// The whole plugin SDK. A plugin is a Worker whose default export comes from
// definePlugin(); the server reaches it through a service binding and every
// hook is one RPC call.
//
//   import { definePlugin } from "../../sdk/plugin";
//
//   export default definePlugin({
//     async onJoin({ player }, server) {
//       await server.message(player.name, `Welcome, ${player.name}!`);
//     },
//   });

import { WorkerEntrypoint } from "cloudflare:workers";
import { HOOK_NAMES, type HookName, type Hooks, type Server } from "../src/plugins/api";

export type * from "../src/plugins/api";

/**
 * Pass the hooks directly, or a function of the Worker's env when the plugin
 * needs its own bindings (KV, D1, secrets, ...).
 */
export function definePlugin<Env = unknown>(definition: Hooks | ((env: Env) => Hooks)) {
	return class Plugin extends WorkerEntrypoint<Env> {
		#hooks = typeof definition === "function" ? definition(this.env) : definition;

		/** Which hooks this plugin implements, so the server skips the rest. */
		hooks(): HookName[] {
			return HOOK_NAMES.filter((name) => typeof this.#hooks[name] === "function");
		}

		/**
		 * A plugin is only ever called over RPC, but Cloudflare refuses to deploy a
		 * Worker that handles no event at all.
		 */
		fetch(): Response {
			return new Response("This Worker is a workercraft plugin. It has no HTTP interface.", { status: 404 });
		}

		async dispatch(hook: HookName, event: unknown, server: Server): Promise<unknown> {
			if (!HOOK_NAMES.includes(hook)) return undefined;
			const handler = this.#hooks[hook] as ((event: unknown, server: Server) => unknown) | undefined;
			return handler?.(event, server);
		}
	};
}
