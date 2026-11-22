// Runs hooks across every plugin: the ones compiled in, then every Worker
// bound to this one under a name starting with PLUGIN_.

import type { HookName, Hooks, LoginEvent, Server, Text, TimerEvent } from "./api";

/** What a plugin Worker exposes over RPC. Implemented by sdk/plugin.ts. */
export interface RemotePlugin {
	hooks(): Promise<HookName[]>;
	dispatch(hook: HookName, event: unknown, server: Server): Promise<unknown>;
}

interface Loaded {
	name: string;
	/** Undefined when the plugin cannot be asked which hooks it has. */
	has(hook: HookName): boolean | undefined | Promise<boolean | undefined>;
	call(hook: HookName, event: unknown, server: Server): unknown;
}

/** A plugin that is slow or down must not freeze the game. */
const HOOK_TIMEOUT_MS = 2000;
/**
 * onLogin gets longer: the player is not in the game yet, so nothing waits on
 * it, and a plugin may need to ask the player's game for a cookie first.
 */
const LOGIN_HOOK_TIMEOUT_MS = 5000;
/** How long a failing plugin Worker is skipped before it is tried again. */
const RETRY_AFTER_MS = 30_000;

const LOGIN_UNCHECKED: Text = { text: "The server could not check your login just now. Try again in a moment." };
const LOGIN_REFUSED: Text = { text: "You may not join this server." };

function withTimeout<T>(work: Promise<T>, ms = HOOK_TIMEOUT_MS): Promise<T> {
	let timer: ReturnType<typeof setTimeout>;
	const timeout = new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error("timed out")), ms)));
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
					if (Date.now() - failedAt < RETRY_AFTER_MS) return undefined;
					known ??= Promise.resolve(remote.hooks());
					try {
						return (await withTimeout(known)).includes(hook);
					} catch (error) {
						console.warn(`Plugin ${name} is unreachable: ${error}`);
						known = undefined;
						failedAt = Date.now();
						return undefined;
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

	private timerRunning = false;

	/** The once-a-second timer. Skipped while the previous one is still running. */
	async timer(event: TimerEvent): Promise<void> {
		if (this.timerRunning) return;
		this.timerRunning = true;
		try {
			await this.run("onTimer", event, () => false);
		} finally {
			this.timerRunning = false;
		}
	}

	/**
	 * Asks every plugin with onLogin whether the player may come in. Returns
	 * the reason to give the player when one says no, or fails, or cannot be
	 * asked: a gate that lets people through because it was down is no gate.
	 */
	async login(event: LoginEvent): Promise<Text | undefined> {
		for (const plugin of this.plugins) {
			try {
				const has = await plugin.has("onLogin");
				if (has === undefined) throw new Error("its hooks are unknown because it is unreachable");
				if (!has) continue;
				const result = (await withTimeout(Promise.resolve(plugin.call("onLogin", event, this.server)), LOGIN_HOOK_TIMEOUT_MS)) as { cancel?: unknown; reason?: Text } | undefined;
				if (typeof result === "object" && result !== null && result.cancel === true) return result.reason ?? LOGIN_REFUSED;
			} catch (error) {
				console.warn(`Plugin ${plugin.name} failed in onLogin, so ${event.name} is turned away: ${error}`);
				return LOGIN_UNCHECKED;
			}
		}
		return undefined;
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
