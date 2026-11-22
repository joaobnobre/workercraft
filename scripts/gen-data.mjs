// Generates src/generated/v<protocol>.json from Mojang's official server jar.
//
// Everything version-specific that the server needs (packet ids, which data
// registries the client expects, tag contents, block state ids) comes out of
// the jar itself, so nothing here is copied by hand from a wiki.
//
//   node scripts/gen-data.mjs [version]     (default: 26.3, needs a JDK 25+)
//
// Only the jar's data generator, its bundled data pack and a few questions
// asked of its classes (scripts/Probe.java) are used; the game server is never
// started.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const version = process.argv[2] ?? "26.3";
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const cache = join(root, ".cache", `mc-${version}`);
mkdirSync(cache, { recursive: true });

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const strip = (id) => id.replace(/^minecraft:/, "");

// 1. Download and verify the server jar.
const jar = join(cache, "server.jar");
if (!existsSync(jar)) {
	const manifest = await (await fetch("https://piston-meta.mojang.com/mc/game/version_manifest_v2.json")).json();
	const entry = manifest.versions.find((v) => v.id === version);
	if (!entry) throw new Error(`Unknown Minecraft version ${version}`);
	const meta = await (await fetch(entry.url)).json();
	const { url, sha1 } = meta.downloads.server;
	console.log(`Downloading ${url}`);
	const bytes = Buffer.from(await (await fetch(url)).arrayBuffer());
	const actual = createHash("sha1").update(bytes).digest("hex");
	if (actual !== sha1) throw new Error(`server.jar checksum mismatch: ${actual} != ${sha1}`);
	writeFileSync(jar, bytes);
}

// 2. Run the data generator (reports) and unpack the built-in data pack.
if (!existsSync(join(cache, "gen/reports/packets.json"))) {
	console.log("Running the data generator");
	execFileSync("java", ["-DbundlerMainClass=net.minecraft.data.Main", "-jar", "server.jar", "--reports", "--output", "gen"], {
		cwd: cache,
		stdio: "ignore",
	});
}
const NEEDED_CLASSES = ["net.minecraft.resources.RegistryDataLoader", "net.minecraft.core.registries.Registries"];
const inner = join(cache, "versions", version, `server-${version}.jar`);
const unpacked = join(cache, "jar");
if (!NEEDED_CLASSES.every((cls) => existsSync(join(unpacked, `${cls.replaceAll(".", "/")}.class`)))) {
	mkdirSync(unpacked, { recursive: true });
	execFileSync("jar", ["xf", inner, "data", "version.json", ...NEEDED_CLASSES.map((cls) => `${cls.replaceAll(".", "/")}.class`)], { cwd: unpacked });
}

// What the reports do not say: each block's class, collision and block entity,
// and the ids of entity data fields. Cached until Probe.java changes.
const probeSource = join(root, "scripts/Probe.java");
const probeFile = join(cache, `probe-${createHash("sha1").update(readFileSync(probeSource)).digest("hex").slice(0, 12)}.json`);
if (!existsSync(probeFile)) {
	console.log("Asking the game's classes about blocks and entity data");
	const jars = [];
	const walk = (dir) => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			if (entry.isDirectory()) walk(join(dir, entry.name));
			else if (entry.name.endsWith(".jar")) jars.push(join(dir, entry.name));
		}
	};
	walk(join(cache, "libraries"));
	const classpath = [inner, ...jars].join(delimiter);
	const classes = join(cache, "probe");
	execFileSync("javac", ["-nowarn", "-proc:none", "-cp", classpath, "-d", classes, probeSource], { stdio: ["ignore", "ignore", "inherit"] });
	const output = execFileSync("java", ["-cp", [classes, classpath].join(delimiter), "Probe"], {
		cwd: cache,
		encoding: "utf8",
		maxBuffer: 64 << 20,
		stdio: ["ignore", "pipe", "ignore"],
	});
	const line = output.split("\n").find((l) => l.startsWith("PROBE"));
	if (!line) throw new Error("Probe.java printed no result");
	writeFileSync(probeFile, line.slice("PROBE".length));
}
const probe = readJson(probeFile);

const versionInfo = readJson(join(unpacked, "version.json"));
const packetsReport = readJson(join(cache, "gen/reports/packets.json"));
const registriesReport = readJson(join(cache, "gen/reports/registries.json"));
const blocksReport = readJson(join(cache, "gen/reports/blocks.json"));
const dataDir = join(unpacked, "data/minecraft");

// 3. Packet ids, keyed by Mojang's own packet names.
const packets = {};
for (const [state, directions] of Object.entries(packetsReport)) {
	packets[state] = { clientbound: {}, serverbound: {} };
	for (const [direction, entries] of Object.entries(directions)) {
		for (const [name, { protocol_id }] of Object.entries(entries)) packets[state][direction][strip(name)] = protocol_id;
	}
}

// 4. Which data registries the server must sync to the client. Read out of the
//    bytecode so a new registry in a future version is picked up automatically.
const javap = (cls) => execFileSync("javap", ["-p", "-c", "-cp", unpacked, cls], { encoding: "utf8", maxBuffer: 64 << 20 });
const registryKeys = {};
{
	let lastString;
	for (const line of javap("net.minecraft.core.registries.Registries").split("\n")) {
		const str = line.match(/\/\/ String (\S+)/);
		if (str) lastString = str[1];
		const field = line.match(/putstatic.*Field ([A-Z0-9_]+):Lnet\/minecraft\/resources\/ResourceKey;/);
		if (field && lastString) registryKeys[field[1]] = `minecraft:${lastString}`;
	}
}
let synced = [];
{
	// The list is built by the registry references between the previous static
	// field being stored and SYNCHRONIZED_REGISTRIES being stored.
	let sinceLastField = [];
	for (const line of javap("net.minecraft.resources.RegistryDataLoader").split("\n")) {
		const ref = line.match(/getstatic.*Registries\.([A-Z0-9_]+):/);
		if (ref) sinceLastField.push(registryKeys[ref[1]] ?? (() => { throw new Error(`No key for registry ${ref[1]}`); })());
		else if (/putstatic.*Field SYNCHRONIZED_REGISTRIES:/.test(line)) synced = sinceLastField;
		else if (/putstatic/.test(line)) sinceLastField = [];
	}
}
if (synced.length < 10) throw new Error(`Only found ${synced.length} synchronized registries; the bytecode layout changed`);

const listJson = (dir) => {
	if (!existsSync(dir)) return [];
	const out = [];
	const walk = (d) => {
		for (const entry of readdirSync(d, { withFileTypes: true })) {
			const p = join(d, entry.name);
			if (entry.isDirectory()) walk(p);
			else if (entry.name.endsWith(".json")) out.push(relative(dir, p).replace(/\\/g, "/").replace(/\.json$/, ""));
		}
	};
	walk(dir);
	return out.sort();
};

// The client already has this data in its own copy of the vanilla data pack
// ("known packs"), so the server only sends the entry names, in this order.
const registries = synced.map((id) => [id, listJson(join(dataDir, strip(id))).map((name) => `minecraft:${name}`)]);
for (const [id, entries] of registries) if (entries.length === 0) throw new Error(`Registry ${id} has no entries in the data pack`);

// Full contents of those entries, for clients that do not have a matching
// vanilla data pack (bots, mostly). World generation fields are dropped: the
// client never reads them and they are most of the size.
const WORLDGEN_ONLY = ["features", "carvers", "spawners", "spawn_costs", "creature_spawn_probability"];
const registryData = {};
for (const [id, entries] of registries) {
	registryData[id] = entries.map((name) => {
		const json = readJson(join(dataDir, strip(id), `${strip(name)}.json`));
		if (id === "minecraft:worldgen/biome") for (const key of WORLDGEN_ONLY) delete json[key];
		return json;
	});
}

// 5. Tags, resolved to numeric ids. Sent for every built-in registry plus the
//    synced data registries, which is what the vanilla server does.
const idMaps = new Map();
for (const [id, report] of Object.entries(registriesReport)) {
	idMaps.set(id, new Map(Object.entries(report.entries).map(([name, { protocol_id }]) => [name, protocol_id])));
}
for (const [id, entries] of registries) idMaps.set(id, new Map(entries.map((name, index) => [name, index])));

const tags = [];
for (const [registry, ids] of idMaps) {
	const tagDir = join(dataDir, "tags", strip(registry));
	const names = listJson(tagDir);
	if (names.length === 0) continue;
	const resolved = new Map();
	const resolve = (name, stack = []) => {
		if (resolved.has(name)) return resolved.get(name);
		if (stack.includes(name)) throw new Error(`Tag cycle at ${registry} #${name}`);
		const out = new Set();
		for (const raw of readJson(join(tagDir, `${name}.json`)).values) {
			const value = typeof raw === "string" ? raw : raw.id;
			const required = typeof raw === "string" ? true : raw.required !== false;
			if (value.startsWith("#")) {
				for (const id of resolve(strip(value.slice(1)), [...stack, name])) out.add(id);
			} else if (ids.has(value)) {
				out.add(ids.get(value));
			} else if (required) {
				throw new Error(`Tag ${registry} #${name} references unknown entry ${value}`);
			}
		}
		resolved.set(name, out);
		return out;
	};
	tags.push([registry, names.map((name) => [`minecraft:${name}`, [...resolve(name)]])]);
}

// 6. Blocks. A block's states are numbered consecutively, in the order of its
//    properties with the last one changing fastest, so the first id, the
//    property list and the default are enough to compute any state id.
const blocks = {};
const blockDefs = [];
/** Blocks that carry a block entity (chests, signs, banners, ...), to its type id. */
const blockEntities = {};
/** Blocks with no collision box, and blocks whose collision box is the whole cube. */
const passable = [];
const fullCubes = [];
/** Distinct [place sound, break sound, volume, pitch] combinations; each block names one. */
const soundGroups = [];
/**
 * A block's kind is its Java class in snake case without "Block": StairBlock
 * is "stair". It is what the building rules go by. Mojang respelled one class
 * between versions, so that one is spelled the new way for both.
 */
function blockKind(className) {
	const kind = className
		.replace(/Block$/, "")
		.replace(/(?<=[a-z0-9])(?=[A-Z])/g, "_")
		.toLowerCase();
	return kind.replace(/^red_stone_/, "redstone_") || "block";
}
let stateCount = 0;
for (const [name, block] of Object.entries(blocksReport)) {
	const ids = block.states.map((state) => state.id);
	const first = Math.min(...ids);
	stateCount = Math.max(stateCount, Math.max(...ids) + 1);
	const defaultState = block.states.find((state) => state.default).id;
	blocks[strip(name)] = defaultState;
	// The report does not list properties in numbering order, so recover it:
	// the property that differs between two states `stride` apart is the next
	// slowest one.
	const byId = new Map(block.states.map((state) => [state.id, state]));
	const unordered = new Map(Object.entries(block.properties ?? {}));
	const properties = [];
	for (let stride = 1; unordered.size > 0; ) {
		const [a, b] = [byId.get(first).properties, byId.get(first + stride).properties];
		const differing = [...unordered.keys()].filter((property) => a[property] !== b[property]);
		if (differing.length !== 1) throw new Error(`Cannot work out the property order of ${name}`);
		properties.unshift([differing[0], unordered.get(differing[0])]);
		stride *= unordered.get(differing[0]).length;
		unordered.delete(differing[0]);
	}
	// Check the numbering assumption instead of trusting it.
	for (const state of block.states) {
		let expected = first;
		let stride = block.states.length;
		for (const [property, values] of properties) {
			stride /= values.length;
			expected += values.indexOf(state.properties[property]) * stride;
		}
		if (expected !== state.id) throw new Error(`State numbering of ${name} is not what the generator assumes`);
	}
	const probed = probe.blocks[strip(name)];
	if (!probed) throw new Error(`The probe did not report block ${name}`);
	const sound = [probed.placeSound, probed.breakSound, probed.volume, probed.pitch];
	let soundGroup = soundGroups.findIndex((group) => group.every((value, index) => value === sound[index]));
	if (soundGroup < 0) soundGroup = soundGroups.push(sound) - 1;
	blockDefs.push([strip(name), first, defaultState, blockKind(probed.class), registriesReport["minecraft:block"].entries[name].protocol_id, properties, soundGroup]);
	if (probed.blockEntity >= 0) blockEntities[strip(name)] = probed.blockEntity;
	if (probed.passable) passable.push(strip(name));
	else if (probed.fullCube) fullCubes.push(strip(name));
}
blockDefs.sort((a, b) => a[1] - b[1]);

// What each block state offers to blocks resting on it (see faces() in
// Probe.java). There are few distinct answers, so each is stored once in
// faceMasks. Each block, in blockDefs order, names the one all its states
// share, or else, as -1 - i, the i-th entry of faceTables, which blocks of
// the same shape share. Such an entry is [properties, answers, runs]: the
// indices of the properties the answer depends on, the faceMasks it uses, and
// one answer for each combination of those properties' values (numbered the
// way states are), as a run-length string: FACE_ALPHABET[i] for the i-th of
// its answers, then how many in a row have it when that is more than one.
//
// The fluid in a state is not stored per state: it follows from the block
// (water, lava, and the few blocks that are always under water) and from a
// waterlogged property, which is checked here against what the probe says.
const FACE_ALPHABET = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
const FLUID_SHIFT = 29;
const faceMasks = [];
const faceIndex = new Map();
const faceTables = [];
const faceTableIndex = new Map();
const alwaysWater = [];
const blockFaces = blockDefs.map(([name, , , , , properties]) => {
	const probed = probe.blocks[name].faces;
	const sizes = properties.map(([, values]) => values.length);
	if (probed.length !== sizes.reduce((n, size) => n * size, 1)) throw new Error(`The probe reported the wrong number of states for ${name}`);
	// Value index of each property, for state number i of this block.
	const valuesOf = (i) => {
		const out = [];
		for (let p = sizes.length - 1; p >= 0; p--) {
			out[p] = i % sizes[p];
			i = Math.floor(i / sizes[p]);
		}
		return out;
	};
	const fluids = probed.map((mask) => mask >>> FLUID_SHIFT);
	const waterlogged = properties.findIndex(([property]) => property === "waterlogged");
	const level = properties.findIndex(([property]) => property === "level");
	if (fluids.every((fluid) => fluid === 1) && waterlogged < 0) alwaysWater.push(name);
	fluids.forEach((fluid, i) => {
		const values = valuesOf(i);
		let expected = 0;
		if (name === "water") expected = values[level] === 0 ? 1 : 2;
		else if (name === "lava") expected = 3;
		else if (alwaysWater.includes(name) || (waterlogged >= 0 && properties[waterlogged][1][values[waterlogged]] === "true")) expected = 1;
		if (fluid !== expected) throw new Error(`The fluid in ${name} is not what the server works out`);
	});
	const masks = probed.map((mask) => mask & ((1 << FLUID_SHIFT) - 1));
	const indices = masks.map((mask) => {
		if (!faceIndex.has(mask)) faceIndex.set(mask, faceMasks.push(mask) - 1);
		return faceIndex.get(mask);
	});
	if (indices.every((index) => index === indices[0])) return indices[0];
	// The properties the answer depends on.
	const relevant = sizes
		.map((_, p) => p)
		.filter((p) => indices.some((index, i) => {
			const values = valuesOf(i);
			if (values[p] !== 0) return false;
			let stride = 1;
			for (let q = p + 1; q < sizes.length; q++) stride *= sizes[q];
			for (let v = 1; v < sizes[p]; v++) if (indices[i + v * stride] !== index) return true;
			return false;
		}));
	const table = [];
	indices.forEach((index, i) => {
		const values = valuesOf(i);
		let slot = 0;
		for (const p of relevant) slot = slot * sizes[p] + values[p];
		if (table[slot] !== undefined && table[slot] !== index) throw new Error(`Face masks of ${name} depend on more than the properties found`);
		table[slot] = index;
	});
	const used = [...new Set(table)];
	if (used.length > FACE_ALPHABET.length) throw new Error(`${name} has too many different face masks`);
	let runs = "";
	for (let i = 0; i < table.length; ) {
		let run = 1;
		while (table[i + run] === table[i]) run++;
		runs += FACE_ALPHABET[used.indexOf(table[i])] + (run > 1 ? run : "");
		i += run;
	}
	const key = JSON.stringify([relevant, used, runs]);
	if (!faceTableIndex.has(key)) faceTableIndex.set(key, faceTables.push([relevant, used, runs]) - 1);
	return -1 - faceTableIndex.get(key);
});

// Which of the game's classes decide whether a block can stay where it is,
// grouped: [canSurvive class, mayPlaceOn class, the tags the block was built
// with by field name, growth direction, blocks]. Classes are spelled like a block's kind.
const survivalGroups = new Map();
for (const [name] of blockDefs) {
	const { survive, mayPlaceOn, tags: supportTags, growth } = probe.blocks[name];
	if (!survive) continue;
	const key = JSON.stringify([blockKind(survive), mayPlaceOn ? blockKind(mayPlaceOn) : null, supportTags ?? {}, growth ?? null]);
	if (!survivalGroups.has(key)) survivalGroups.set(key, [...JSON.parse(key), []]);
	survivalGroups.get(key)[4].push(name);
}
const survival = [...survivalGroups.values()];

const SOUNDS = [
	"block.wooden_door.open", "block.wooden_door.close", "block.iron_door.open", "block.iron_door.close",
	"block.copper_door.open", "block.copper_door.close", "block.wooden_trapdoor.open", "block.wooden_trapdoor.close",
	"block.iron_trapdoor.open", "block.iron_trapdoor.close", "block.copper_trapdoor.open", "block.copper_trapdoor.close",
	"block.fence_gate.open", "block.fence_gate.close", "block.lever.click", "block.comparator.click",
	"block.wooden_button.click_on", "block.wooden_button.click_off", "block.stone_button.click_on", "block.stone_button.click_off",
];
const sounds = {};
for (const name of SOUNDS) {
	const entry = registriesReport["minecraft:sound_event"].entries[`minecraft:${name}`];
	if (entry) sounds[name] = entry.protocol_id;
	else console.warn(`Sound ${name} does not exist in ${version}`);
}
const itemBlocks = {};
const itemNames = {};
for (const [name, { protocol_id }] of Object.entries(registriesReport["minecraft:item"].entries)) {
	itemNames[protocol_id] = strip(name);
	if (strip(name) in blocks) itemBlocks[protocol_id] = blocks[strip(name)];
}

// Stack sizes, for the items that do not stack to 64.
const stackSizes = {};
for (const [id, name] of Object.entries(itemNames)) {
	const file = join(cache, "gen/reports/minecraft/components/item", `${name}.json`);
	const size = existsSync(file) ? readJson(file).components?.["minecraft:max_stack_size"] : undefined;
	if (typeof size === "number" && size !== 64) stackSizes[id] = size;
}

const entityType = (name) => registriesReport["minecraft:entity_type"].entries[`minecraft:${name}`].protocol_id;

const need = (table, key) => {
	if (!(key in table)) throw new Error(`The probe found no ${key}`);
	return table[key];
};
const entityData = {
	types: { byte: need(probe.entityDataSerializers, "BYTE"), pose: need(probe.entityDataSerializers, "POSE"), itemStack: need(probe.entityDataSerializers, "ITEM_STACK") },
	fields: {
		flags: need(probe.entityDataAccessors, "Entity.DATA_SHARED_FLAGS_ID"),
		pose: need(probe.entityDataAccessors, "Entity.DATA_POSE"),
		skinParts: need(probe.entityDataAccessors, "Avatar.DATA_PLAYER_MODE_CUSTOMISATION"),
		item: need(probe.entityDataAccessors, "ItemEntity.DATA_ITEM"),
	},
	poses: { standing: need(probe.poses, "STANDING"), sneaking: need(probe.poses, "CROUCHING") },
};

/** Other game versions that speak the same protocol; each names the vanilla data pack after itself. */
const SAME_PROTOCOL = { "26.1.2": ["26.1.1", "26.1"] };

const out = {
	version: { name: versionInfo.name, protocol: versionInfo.protocol_version, sameProtocol: SAME_PROTOCOL[versionInfo.name] ?? [] },
	packets,
	registries,
	registryData,
	tags,
	stateCount,
	blockDefs,
	blockEntities,
	passable,
	fullCubes,
	faceMasks,
	faceTables,
	blockFaces,
	survival,
	alwaysWater,
	fluids: Object.fromEntries(["water", "flowing_water", "lava"].map((name) => [name, registriesReport["minecraft:fluid"].entries[`minecraft:${name}`].protocol_id])),
	soundGroups,
	entityData,
	sounds,
	itemBlocks,
	itemNames,
	stackSizes,
	entityTypes: { player: entityType("player"), item: entityType("item") },
};
const outFile = join(root, "src/generated", `v${versionInfo.protocol_version}.json`);
mkdirSync(dirname(outFile), { recursive: true });
writeFileSync(outFile, JSON.stringify(out));
console.log(
	`${relative(root, outFile)}: ${versionInfo.name} (protocol ${versionInfo.protocol_version}), ` +
		`${registries.length} synced registries, ${tags.reduce((n, [, t]) => n + t.length, 0)} tags, ` +
		`${Object.keys(blocks).length} blocks, ${(JSON.stringify(out).length / 1024).toFixed(0)} KB`,
);
