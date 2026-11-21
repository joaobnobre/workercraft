// Runs hooks across every plugin: the ones compiled in, then every Worker
// bound to this one under a name starting with PLUGIN_.

import type { HookName, Hooks, Server } from "./api";

/** What a plugin Worker exposes over RPC. Implemented by sdk/plugin.ts. */
export interface RemotePlugin {
	hooks(): Promise<HookName[]>;
	dispatch(hook: HookName, event: unknown, server: Server): Promise<unknown>;
}

interface Loaded {
	name: string;
	has(hook: HookName): boolean | Promise<boolean>;
	call(hook: HookName, event: unknown, server: Server): unknown;
}

/** A plugin that is slow or down must not freeze the game. */
const HOOK_TIMEOUT_MS = 2000;
/** How long a failing plugin Worker is skipped before it is tried again. */
const RETRY_AFTER_MS = 30_000;

function withTimeout<T>(work: Promise<T>): Promise<T> {
	let timer: ReturnType<typeof setTimeout>;
	const timeout = new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error("timed out")), HOOK_TIMEOUT_MS)));
	return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

export class PluginHost {
	private plugins: Loaded[] = [];

	constructor(
		builtin: { name: string; hooks: Hooks }[],
		env: Record<string, unknown>,
		private server: Server,
	) {
		for (const { name, hooks } of builtin) {
			this.plugins.push({
				name,
				has: (hook) => typeof hooks[hook] === "function",
				call: (hook, event, server) => (hooks[hook] as (e: unknown, s: Server) => unknown)(event, server),
			});
		}
		for (const [binding, value] of Object.entries(env)) {
			if (!binding.startsWith("PLUGIN_")) continue;
			const remote = value as RemotePlugin;
			const name = binding.slice("PLUGIN_".length).toLowerCase();
			let known: Promise<HookName[]> | undefined;
			let failedAt = 0;
			this.plugins.push({
				name,
				has: async (hook) => {
					if (Date.now() - failedAt < RETRY_AFTER_MS) return false;
					known ??= Promise.resolve(remote.hooks());
					try {
						return (await withTimeout(known)).includes(hook);
					} catch (error) {
						console.warn(`Plugin ${name} is unreachable: ${error}`);
						known = undefined;
						failedAt = Date.now();
						return false;
					}
				},
				call: (hook, event, server) => remote.dispatch(hook, event, server),
			});
		}
	}

	get names(): string[] {
		return this.plugins.map((plugin) => plugin.name);
	}

	/** Calls a hook on every plugin, in order. Results of failed or slow plugins are skipped. */
	private async run(hook: HookName, event: unknown, stop: (result: unknown) => boolean): Promise<boolean> {
		for (const plugin of this.plugins) {
			try {
				if (!(await plugin.has(hook))) continue;
				const result = await withTimeout(Promise.resolve(plugin.call(hook, event, this.server)));
				if (stop(result)) return true;
			} catch (error) {
				console.warn(`Plugin ${plugin.name} failed in ${hook}: ${error}`);
			}
		}
		return false;
	}

	/** Fire-and-forget notification. */
	async notify(hook: "onJoin" | "onQuit", event: unknown): Promise<void> {
		await this.run(hook, event, () => false);
	}

	/** Returns true when some plugin cancelled the event. */
	cancellable(hook: "onChat" | "onBlockBreak" | "onBlockPlace", event: unknown): Promise<boolean> {
		return this.run(hook, event, (result) => typeof result === "object" && result !== null && (result as { cancel?: boolean }).cancel === true);
	}

	/** Returns true when some plugin handled the command. */
	command(event: unknown): Promise<boolean> {
		return this.run("onCommand", event, (result) => result === true);
	}
}
