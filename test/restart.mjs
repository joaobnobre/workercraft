// Checks that dropped items survive the server stopping: once after the world
// went idle, once killed while a player was online. Starts and stops its own
// dev server, so it needs an instance nobody is running:
//
//   INSTANCE=3 npm run test:restart
//
// It keeps the instance's world (.wrangler/state-<n>) and builds in it, like
// the other tests. The judging is done by test/conformance/ItemTests.java.

import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { devInstance } from "../scripts/instance.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const instance = devInstance();
if (instance.id === undefined) {
	console.error("Pick an instance that is not running: INSTANCE=<n> npm run test:restart");
	process.exit(2);
}
const status = () => fetch(`http://127.0.0.1:${instance.httpPort}/`).then((r) => r.ok, () => false);
if (await status()) {
	console.error(`Something already answers on port ${instance.httpPort}. Stop INSTANCE=${instance.id} first: this test starts and stops its own.`);
	process.exit(2);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const tag = Date.now().toString(36).slice(-5);
const at = `${200_000 + Math.floor(Math.random() * 100_000)},${200_000 + Math.floor(Math.random() * 100_000)}`;

/** Starts the dev server in a process group of its own, so that all of it can be stopped at once. */
async function startServer() {
	const server = spawn("node", ["scripts/dev.mjs", ...process.argv.slice(2)], { cwd: root, detached: true, stdio: "ignore", env: process.env });
	const exited = new Promise((resolve) => server.on("exit", resolve));
	for (let i = 0; i < 120 && !(await status()); i++) await sleep(500);
	if (!(await status())) throw new Error("The dev server did not start");
	return {
		async stop(signal) {
			try {
				process.kill(-server.pid, signal);
			} catch {}
			await Promise.race([exited, sleep(10_000)]);
			try {
				process.kill(-server.pid, "SIGKILL");
			} catch {}
			for (let i = 0; i < 40 && (await status()); i++) await sleep(250);
		},
	};
}

/** Runs one step of ItemTests against the server. Resolves when `until` is printed, or when it exits. */
function step(phase, until) {
	return new Promise((resolve) => {
		const child = spawn("node", ["test/conformance.mjs"], { cwd: root, env: { ...process.env, RESTART_PHASE: phase, RESTART_TAG: tag, RESTART_AT: at }, stdio: ["ignore", "pipe", "inherit"] });
		let output = "";
		child.stdout.on("data", (chunk) => {
			process.stdout.write(chunk);
			output += chunk;
			if (until && output.includes(until)) resolve({ ok: !output.includes("FAIL"), child });
		});
		child.on("exit", (code) => resolve({ ok: code === 0, child }));
	});
}

let failed = false;
let server = await startServer();
try {
	console.log(`-- items dropped at ${at}, then the world goes idle`);
	failed ||= !(await step("idle")).ok;
	console.log("-- items dropped with a player online; the server is killed after the periodic save");
	const crash = await step("crash", "READY");
	failed ||= !crash.ok;
	await server.stop("SIGKILL");
	crash.child.kill();
	console.log("-- the server starts again");
	server = await startServer();
	failed ||= !(await step("after")).ok;
} catch (problem) {
	console.error(problem);
	failed = true;
} finally {
	await server.stop("SIGTERM");
}
console.log(failed ? "\nThe restart test failed." : "\nDropped items survive a restart.");
process.exit(failed ? 1 : 0);
