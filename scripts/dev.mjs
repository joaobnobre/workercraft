// Starts `wrangler dev` with the world and every plugin in one session.
//
//   node scripts/dev.mjs [wrangler dev options]     (npm run dev)
//   INSTANCE=2 npm run dev                          a second server beside the first
//   npm run dev -- --print                          show what would start, start nothing
//   INSTANCE=1 PLUGINS=limbo npm run dev            other plugins than the usual ones
//
// Without INSTANCE this is plain `wrangler dev -c wrangler.jsonc -c plugins/...`.
// With INSTANCE=<n> it starts a copy that shares nothing with the default
// server: the Worker names end in -<n>, the game listens on 25570+n, HTTP on
// 8790+n, the inspector on any free port, and the world is kept in
// .wrangler/state-<n>. The names differ because wrangler's dev registry, where
// dev sessions find each other's Workers by name, keeps the first session that
// claims a name and leaves the second unlisted.
//
// PLUGINS=<name,...> (only with INSTANCE) loads plugins/<name>/wrangler.jsonc
// for each name, in that order, instead of the plugins wrangler.jsonc binds.
// The examples that change who may play (limbo, gate) are loaded only this way,
// so the default server and `npm run deploy` never have them.
//
// Wrangler has no option for the TCP port in `connect`, so each config is
// copied with those changes to .wrangler-instance-<n>.jsonc beside the
// original (beside it, so relative paths and .dev.vars still apply), and the
// copies are removed when wrangler exits.

import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { experimental_readRawConfig } from "wrangler";
import { devInstance } from "./instance.mjs";

// The world first; the others are its plugins. A new plugin goes here too.
const DEFAULT_CONFIGS = ["wrangler.jsonc", "plugins/guard/wrangler.jsonc", "plugins/welcome/wrangler.jsonc", "plugins/builder/wrangler.jsonc"];

process.chdir(join(dirname(fileURLToPath(import.meta.url)), ".."));
const args = process.argv.slice(2).filter((arg) => arg !== "--print");
const print = args.length < process.argv.length - 2;
const instance = devInstance();

const chosen = process.env.PLUGINS?.split(",").map((name) => name.trim()).filter(Boolean);
const stop = (message) => {
	console.error(message);
	process.exit(2);
};
if (chosen && instance.id === undefined) stop("PLUGINS needs INSTANCE: the default server always has its usual plugins.");
for (const name of chosen ?? []) {
	if (!/^[a-z0-9-]+$/.test(name) || !existsSync(`plugins/${name}/wrangler.jsonc`)) stop(`No plugin "${name}" in plugins/.`);
}
const CONFIGS = chosen ? ["wrangler.jsonc", ...chosen.map((name) => `plugins/${name}/wrangler.jsonc`)] : DEFAULT_CONFIGS;

const raw = CONFIGS.map((config) => experimental_readRawConfig({ config }).rawConfig);
if (chosen) raw[0] = { ...raw[0], services: chosen.map((name, i) => ({ binding: `PLUGIN_${name.toUpperCase().replace(/-/g, "_")}`, service: raw[i + 1].name })) };
const renamed = new Map(raw.map((config) => [config.name, config.name + instance.suffix]));
const configs = raw.map((config) => ({
	...config,
	name: renamed.get(config.name),
	services: config.services?.map((s) => ({ ...s, service: renamed.get(s.service) ?? s.service })),
	connect: config.connect?.map((c) => (c.protocol === "tcp" ? { ...c, port: instance.gamePort } : c)),
}));
const paths = instance.id === undefined ? CONFIGS : CONFIGS.map((path) => join(dirname(path), `.wrangler-instance-${instance.id}.jsonc`));
const wranglerArgs = ["dev", ...paths.flatMap((path) => ["-c", path]), ...args];
// Inspector port 0 lets the system pick one: wrangler's own pick (the first
// free port from 9229) races when two instances start at the same moment.
if (instance.id !== undefined) wranglerArgs.push("--port", String(instance.httpPort), "--inspector-port", "0", "--persist-to", instance.persistTo);

if (print) {
	for (const config of configs) console.log(`${config.name}${config.connect ? `  tcp ${config.connect.map((c) => c.port).join(", ")}` : ""}${config.services ? `  -> ${config.services.map((s) => s.service).join(", ")}` : ""}`);
	console.log(`http ${instance.httpPort}${instance.id === undefined ? " (wrangler's default)" : ""}, state in ${instance.persistTo}`);
	console.log(`wrangler ${wranglerArgs.join(" ")}`);
	process.exit(0);
}

if (instance.id !== undefined) {
	configs.forEach((config, i) => {
		const from = basename(CONFIGS[i]);
		writeFileSync(paths[i], `// Written by scripts/dev.mjs from ${from} for INSTANCE=${instance.id}; removed when it exits.\n${JSON.stringify(config, null, "\t")}\n`);
	});
}
const cleanUp = () => {
	if (instance.id !== undefined) for (const path of paths) rmSync(path, { force: true });
};

const wrangler = join(dirname(createRequire(import.meta.url).resolve("wrangler/package.json")), "bin/wrangler.js");
const child = spawn(process.execPath, [wrangler, ...wranglerArgs], { stdio: "inherit" });
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, () => child.kill(signal));
child.on("exit", (code, signal) => {
	cleanUp();
	process.exit(code ?? (signal ? 1 : 0));
});
