// Compiles test/conformance/Conformance.java against Mojang's server jar and
// runs it against a running server. The jar is the one `npm run gen` already
// downloaded into .cache/.
//
//   node test/conformance.mjs [version]     (default 26.3; HOST and PORT as for npm test)

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const version = process.argv[2] ?? "26.3";
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
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
const run = spawnSync("java", ["-cp", [classes, classpath].join(delimiter), "Conformance", process.env.HOST ?? "127.0.0.1", process.env.PORT ?? "25565"], {
	cwd: cache,
	stdio: ["ignore", "inherit", process.env.CONFORMANCE_TRACE ? "inherit" : "ignore"],
});
process.exit(run.status ?? 1);
