// Compiles test/conformance/Conformance.java against Mojang's server jar and
// runs it against a running server. The jar is the one `npm run gen` already
// downloaded into .cache/.
//
//   node test/conformance.mjs [version]     (default 26.3; HOST, PORT and INSTANCE as for npm test)
//   node test/conformance.mjs --queue       the queue example instead, against its limbo (npm run test:queue)
//
// --queue needs the secret both of the example's servers sign with: from
// QUEUE_SECRET, or else from plugins/gate/.dev.vars.

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { devInstance } from "../scripts/instance.mjs";

const queue = process.argv.includes("--queue");
const version = process.argv.slice(2).find((arg) => !arg.startsWith("--")) ?? "26.3";
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const env = { ...process.env };
if (queue) {
	env.QUEUE = "1";
	const devVars = join(root, "plugins/gate/.dev.vars");
	env.QUEUE_SECRET ??= existsSync(devVars) ? /^QUEUE_SECRET\s*=\s*"?([^"\n]*)"?\s*$/m.exec(readFileSync(devVars, "utf8"))?.[1] : undefined;
	if (!env.QUEUE_SECRET) {
		console.error("The queue test needs QUEUE_SECRET, the secret in plugins/gate/.dev.vars. See README, \"A queue\".");
		process.exit(2);
	}
}
const cache = join(root, ".cache", `mc-${version}`);
const jar = join(cache, "versions", version, `server-${version}.jar`);
if (!existsSync(jar)) {
	console.error(`No server jar for ${version}. Run: npm run gen -- ${version}`);
	process.exit(2);
}

const jars = [];
const walk = (dir) => {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (entry.isDirectory()) walk(join(dir, entry.name));
		else if (entry.name.endsWith(".jar")) jars.push(join(dir, entry.name));
	}
};
walk(join(cache, "libraries"));
const classpath = [jar, ...jars].join(delimiter);
const classes = join(cache, "conformance");

execFileSync("javac", ["-nowarn", "-proc:none", "-Xlint:-deprecation", "-cp", classpath, "-d", classes, join(root, "test/conformance/Conformance.java")], { stdio: "inherit" });
const run = spawnSync("java", ["-cp", [classes, classpath].join(delimiter), "Conformance", process.env.HOST ?? "127.0.0.1", process.env.PORT ?? String(devInstance().gamePort)], {
	cwd: cache,
	env,
	stdio: ["ignore", "inherit", process.env.CONFORMANCE_TRACE ? "inherit" : "ignore"],
});
process.exit(run.status ?? 1);
