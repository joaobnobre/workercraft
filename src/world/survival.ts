// Whether a block can stay where it is: vanilla's canSurvive, which decides
// both whether a block may be placed somewhere and whether it falls off when
// what holds it changes. Both go through canSurvive() here, so they agree.
//
// What a block offers to others (which faces are sturdy, solid, and so on)
// depends on its state and is generated from the game (faces() in
// scripts/Probe.java). Which rule applies to a block is the game class that
// declares its canSurvive and mayPlaceOn, also generated; the rules below are
// written per class, in the order of the bytecode they follow.
//
// The game also looks at light for mushrooms and crops. There is no light
// here, so those rules are read as if the light were right.

import { data } from "../protocol/version";
import { OFFSET, OPPOSITE, HORIZONTAL, DIRECTIONS, blockByName, blockOf, hasTag, propertiesOf, withProperties, type BlockDef, type Direction } from "./blockstates";

type GetBlock = (x: number, y: number, z: number) => number;
interface Position {
	x: number;
	y: number;
	z: number;
}

// ---- what a state offers ---------------------------------------------------

/** Bits of a face mask; see faces() in scripts/Probe.java. */
const STURDY_FULL = 0;
const STURDY_CENTER = 6;
const STURDY_RIGID = 12;
const ATTACHABLE = 18;
const COLLISION_TOP_FULL = 1 << 24;
const COLLISION_BOTTOM_FULL = 1 << 25;
const SOLID = 1 << 26;
const SOLID_RENDER = 1 << 27;
const COLLISION_TOUCHES_TOP = 1 << 28;
const FACE_ALPHABET = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";

const faceMasks = new Int32Array(data.stateCount);
data.blockDefs.forEach(([, first, , , , properties], block) => {
	const entry = data.blockFaces[block]!;
	const count = properties.reduce((n, [, values]) => n * values.length, 1);
	if (entry >= 0) {
		faceMasks.fill(data.faceMasks[entry]!, first, first + count);
		return;
	}
	const [relevant, used, runs] = data.faceTables[-1 - entry]!;
	const table: number[] = [];
	for (const [, letter, run] of runs.matchAll(/([a-zA-Z])(\d*)/g)) {
		const mask = data.faceMasks[used[FACE_ALPHABET.indexOf(letter!)]!]!;
		for (let i = Number(run || 1); i > 0; i--) table.push(mask);
	}
	const sizes = properties.map(([, values]) => values.length);
	for (let i = 0; i < count; i++) {
		let rest = i;
		const values: number[] = [];
		for (let p = sizes.length - 1; p >= 0; p--) {
			values[p] = rest % sizes[p]!;
			rest = Math.floor(rest / sizes[p]!);
		}
		let slot = 0;
		for (const p of relevant) slot = slot * sizes[p]! + values[p]!;
		faceMasks[first + i] = table[slot]!;
	}
});

const faceBit = (offset: number, face: Direction) => 1 << (offset + DIRECTIONS.indexOf(face));

export type SupportType = "full" | "center" | "rigid";

/** Vanilla's isFaceSturdy: whether this face of the state can hold something of the given kind. */
export function isFaceSturdy(state: number, face: Direction, type: SupportType = "full"): boolean {
	return (faceMasks[state]! & faceBit(type === "full" ? STURDY_FULL : type === "center" ? STURDY_CENTER : STURDY_RIGID, face)) !== 0;
}

const has = (state: number, bit: number) => (faceMasks[state]! & bit) !== 0;
const isAir = (state: number) => blockOf(state).type === "air";

/** Vanilla's Block.canSupportCenter: a torch, candle or lantern can rest on this face. */
function canSupportCenter(state: number, face: Direction): boolean {
	if (face === "down" && hasTag(blockOf(state), "unstable_bottom_center")) return false;
	return isFaceSturdy(state, face, "center");
}

/** Vanilla's MultifaceBlock.canAttachTo: what a vine or glow lichen clings to, a face filled completely. */
function attachable(state: number, face: Direction): boolean {
	return has(state, faceBit(ATTACHABLE, face));
}

// ---- fluids ----------------------------------------------------------------

const ALWAYS_WATER = new Set(data.alwaysWater);
const fluidTags = new Map((data.tags.find(([registry]) => registry === "minecraft:fluid")?.[1] ?? []).map(([name, ids]) => [name, new Set(ids)]));

/** The fluid in a block, by fluid name, and whether it fills the block (a source, or falling water). */
function fluidOf(state: number): { name: "water" | "flowing_water" | "lava"; full: boolean } | undefined {
	const def = blockOf(state);
	const properties = propertiesOf(state);
	if (def.name === "water" || def.name === "lava") {
		const level = Number(properties.level ?? 0);
		const name = def.name === "lava" ? "lava" : level === 0 ? "water" : "flowing_water";
		return { name, full: level === 0 || level >= 8 };
	}
	if (properties.waterlogged === "true" || ALWAYS_WATER.has(def.name)) return { name: "water", full: true };
	return undefined;
}

function fluidHasTag(state: number, tag: string): boolean {
	const fluid = fluidOf(state);
	return fluid !== undefined && (fluidTags.get(`minecraft:${tag}`)?.has(data.fluids[fluid.name]) ?? false);
}

const isWater = (state: number) => fluidHasTag(state, "water");
const isWaterSource = (state: number) => fluidOf(state)?.name === "water";

// ---- which rule a block follows --------------------------------------------

interface Rule {
	survive: string;
	mayPlaceOn: string | undefined;
	tags: Record<string, string>;
	growth: Direction | undefined;
}
const rules = new Map<BlockDef, Rule>();
for (const [survive, mayPlaceOn, tags, growth, names] of data.survival) {
	for (const name of names) {
		const def = blockByName(name);
		if (def) rules.set(def, { survive, mayPlaceOn: mayPlaceOn ?? undefined, tags, growth: (growth ?? undefined) as Direction | undefined });
	}
}

/** Neighbours of a position, read relative to it. */
interface Around {
	at: Position;
	state: number;
	rule: Rule;
	/** The state in a direction, or further along it. */
	get(direction: Direction, distance?: number): number;
	/** The state one step in `first`, then one in `second`. */
	diagonal(first: Direction, second: Direction): number;
	/** What is at the position itself in the world (for a block about to be placed, what it replaces). */
	here: number;
}

function is(state: number, name: string): boolean {
	return blockOf(state).name === name;
}
const tagged = (state: number, tag: string) => hasTag(blockOf(state), tag);

/** The rule of BlockBehaviour.mayPlaceOn and its overrides, for the block below (or wherever it grows from). */
function mayPlaceOn(a: Around, below: number): boolean {
	switch (a.rule.mayPlaceOn) {
		case undefined:
		case "vegetation":
			return tagged(below, "supports_vegetation");
		case "dry_vegetation":
			return tagged(below, "supports_dry_vegetation");
		case "seagrass":
		case "tall_seagrass":
			return isFaceSturdy(below, "up") && !tagged(below, "cannot_support_seagrass");
		case "wither_rose":
			return tagged(below, "supports_wither_rose");
		case "mushroom":
			return has(below, SOLID_RENDER);
		case "crop":
		case "pitcher_crop":
			return tagged(below, "supports_crops");
		case "cactus_flower":
			return tagged(below, "support_override_cactus_flower") || isFaceSturdy(below, "up", "center");
		case "attached_stem":
		case "nether_fungus":
		case "nether_roots":
			return tagged(below, a.rule.tags.supportBlocks ?? "");
		case "stem":
			return tagged(below, a.rule.tags.stemSupportBlocks ?? "");
		case "lily_pad":
			return (fluidHasTag(below, "supports_lily_pad") || tagged(below, "supports_lily_pad")) && fluidOf(a.here) === undefined;
		case "nether_wart":
			return tagged(below, "supports_nether_wart");
		case "nether_sprouts":
			return tagged(below, "supports_nether_sprouts");
		case "azalea":
			return tagged(below, "supports_azalea");
		case "mangrove_propagule":
			return tagged(below, "supports_mangrove_propagule");
		case "small_dripleaf":
			return tagged(below, "supports_small_dripleaf") || (isWaterSource(a.here) && tagged(below, "supports_vegetation"));
		case "sea_pickle":
			return has(below, COLLISION_TOUCHES_TOP) || isFaceSturdy(below, "up");
		default:
			return true; // a class this server does not know yet
	}
}

/** The direction a face-attached block (button, lever) is held from: vanilla's getConnectedDirection. */
function connectedDirection(state: number): Direction {
	const properties = propertiesOf(state);
	return properties.face === "ceiling" ? "down" : properties.face === "floor" ? "up" : (properties.facing as Direction);
}

/** The opposite of the way it faces: where a wall torch, sign or ladder is fixed. */
function behind(a: Around): number {
	return a.get(OPPOSITE[propertiesOf(a.state).facing as Direction]);
}
const facing = (a: Around) => propertiesOf(a.state).facing as Direction;

/** The upper half of a two-block plant or door stands on its own lower half. */
function onOwnLowerHalf(a: Around): boolean {
	const below = a.get("down");
	return blockOf(below) === blockOf(a.state) && propertiesOf(below).half === "lower";
}

function survivesHere(a: Around): boolean {
	const { state } = a;
	const def = blockOf(state);
	const properties = propertiesOf(state);
	const below = () => a.get("down");
	const above = () => a.get("up");
	switch (a.rule.survive) {
		case "base_torch":
		case "candle":
			return canSupportCenter(below(), "up");
		case "wall_torch":
		case "redstone_wall_torch":
		case "ladder":
		case "base_coral_wall_fan":
		case "shelf_mushroom":
		case "amethyst_cluster":
			return isFaceSturdy(behind(a), facing(a));
		case "trip_wire_hook":
			return HORIZONTAL.includes(facing(a)) && isFaceSturdy(behind(a), facing(a));
		case "standing_sign":
		case "banner":
		case "cake":
		case "candle_cake":
			return has(below(), SOLID);
		case "wall_sign":
		case "wall_banner":
			return has(behind(a), SOLID);
		case "ceiling_hanging_sign":
			return isFaceSturdy(above(), "down", "center");
		case "face_attached_horizontal_directional": {
			const towards = OPPOSITE[connectedDirection(state)];
			return isFaceSturdy(a.get(towards), OPPOSITE[towards]);
		}
		case "grindstone":
			return true;
		case "base_pressure_plate":
			return isFaceSturdy(below(), "up", "rigid") || canSupportCenter(below(), "up");
		case "base_rail":
		case "diode":
			return isFaceSturdy(below(), "up", "rigid");
		case "redstone_wire":
			return isFaceSturdy(below(), "up") || is(below(), "hopper");
		case "door":
			return properties.half === "lower" ? isFaceSturdy(below(), "up") : blockOf(below()) === def;
		case "lantern":
			return properties.hanging === "true" ? canSupportCenter(above(), "down") : canSupportCenter(below(), "up");
		case "bell": {
			const attachment = properties.attachment;
			if (attachment === "ceiling") return canSupportCenter(above(), "down");
			const towards = attachment === "floor" ? "down" : facing(a);
			return isFaceSturdy(a.get(towards), OPPOSITE[towards]);
		}
		case "base_coral_plant_type":
		case "leaf_litter":
			return isFaceSturdy(below(), "up");
		case "cocoa":
			return tagged(a.get(facing(a)), "supports_cocoa");
		case "hanging_roots":
			return isFaceSturdy(above(), "down");
		case "spore_blossom":
			return canSupportCenter(above(), "down") && !isWater(a.here);
		case "hanging_moss":
			return attachable(above(), "down") || blockOf(above()) === def;
		case "snow_layer": {
			const ground = below();
			if (tagged(ground, "cannot_support_snow_layer")) return false;
			if (tagged(ground, "support_override_snow_layer")) return true;
			return has(ground, COLLISION_TOP_FULL) || (blockOf(ground) === def && propertiesOf(ground).layers === "8");
		}
		case "carpet":
			return !isAir(below());
		case "mossy_carpet":
			return properties.base === "true" ? !isAir(below()) : blockOf(below()) === def && propertiesOf(below()).base === "true";
		case "sea_pickle":
		case "vegetation":
		case "crop": // and enough light, which is assumed
			return mayPlaceOn(a, below());
		case "mushroom": // and dark enough, which is assumed
			return tagged(below(), "overrides_mushroom_light_requirement") || mayPlaceOn(a, below());
		case "double_plant":
		case "pitcher_crop":
			return properties.half === "upper" ? onOwnLowerHalf(a) : mayPlaceOn(a, below());
		case "tall_seagrass": {
			if (properties.half === "upper") return onOwnLowerHalf(a);
			const fluid = fluidOf(a.here);
			return mayPlaceOn(a, below()) && fluid !== undefined && fluidHasTag(a.here, "water") && fluid.full;
		}
		case "mangrove_propagule":
			return properties.hanging === "true" ? tagged(above(), "supports_hanging_mangrove_propagule") : mayPlaceOn(a, below());
		case "cactus": {
			for (const side of HORIZONTAL) {
				const next = a.get(side);
				if (has(next, SOLID) || fluidHasTag(next, "lava")) return false;
			}
			const ground = below();
			return (blockOf(ground) === def || tagged(ground, "supports_cactus")) && !["water", "lava"].includes(blockOf(above()).name);
		}
		case "sugar_cane": {
			const ground = below();
			if (blockOf(ground) === def) return true;
			if (!tagged(ground, "supports_sugar_cane")) return false;
			return HORIZONTAL.some((side) => {
				const next = a.diagonal("down", side);
				return fluidHasTag(next, "supports_sugar_cane_adjacently") || tagged(next, "supports_sugar_cane_adjacently");
			});
		}
		case "bamboo_stalk":
		case "bamboo_sapling":
			return tagged(below(), "supports_bamboo");
		case "big_dripleaf": {
			const ground = below();
			return blockOf(ground) === def || is(ground, "big_dripleaf_stem") || tagged(ground, "supports_big_dripleaf");
		}
		case "big_dripleaf_stem": {
			const ground = below();
			const top = above();
			return (blockOf(ground) === def || tagged(ground, "supports_big_dripleaf")) && (blockOf(top) === def || is(top, "big_dripleaf"));
		}
		case "growing_plant": {
			const growth = a.rule.growth ?? "up";
			const from = a.get(OPPOSITE[growth]);
			const head = def.name.replace(/_plant$/, "");
			if (is(from, head) || is(from, `${head}_plant`)) return true;
			if (head === "kelp" && tagged(from, "cannot_support_kelp")) return false;
			return isFaceSturdy(from, growth);
		}
		case "vine":
			return VINE_FACES.some((face) => vineFaces(a)[face] === "true");
		case "multiface": {
			let any = false;
			for (const face of DIRECTIONS) {
				if (properties[face] !== "true") continue;
				if (!attachable(a.get(face), OPPOSITE[face])) return false;
				any = true;
			}
			return any;
		}
		case "chorus_flower": {
			const ground = below();
			if (is(ground, "chorus_plant") || tagged(ground, "supports_chorus_flower")) return true;
			if (!isAir(ground)) return false;
			let plant = false;
			for (const side of HORIZONTAL) {
				const next = a.get(side);
				if (is(next, "chorus_plant")) {
					if (plant) return false;
					plant = true;
				} else if (!isAir(next)) return false;
			}
			return plant;
		}
		case "chorus_plant": {
			const ground = below();
			const enclosed = !isAir(above()) && !isAir(ground);
			for (const side of HORIZONTAL) {
				if (blockOf(a.get(side)) !== def) continue;
				if (enclosed) return false;
				const under = a.diagonal(side, "down");
				if (blockOf(under) === def || tagged(under, "supports_chorus_plant")) return true;
			}
			return blockOf(ground) === def || tagged(ground, "supports_chorus_plant");
		}
		case "speleothem":
		case "pointed_dripstone": {
			const tip = (properties.vertical_direction ?? properties.tip_direction ?? "up") as Direction;
			const base = a.get(OPPOSITE[tip]);
			return isFaceSturdy(base, tip) || (blockOf(base) === def && (propertiesOf(base).vertical_direction ?? propertiesOf(base).tip_direction) === tip);
		}
		case "frogspawn": {
			const ground = below();
			return (fluidHasTag(ground, "supports_frogspawn") || tagged(ground, "supports_frogspawn")) && fluidOf(a.here) === undefined;
		}
		default:
			// Fire, farmland, paths, scaffolding, bubble columns and piston heads
			// follow rules about things this server does not do.
			return true;
	}
}

// ---- vines -----------------------------------------------------------------

const VINE_FACES: Direction[] = ["up", "north", "east", "south", "west"];

/**
 * The faces a vine keeps given what is around it: vanilla's getUpdatedState.
 * A side face holds on to the block beside it, or to the vine above that has
 * the same face.
 */
function vineFaces(a: Around): Record<string, string> {
	const properties = propertiesOf(a.state);
	const out: Record<string, string> = {};
	// The game checks the top face of the block above here, unlike when placing.
	if (properties.up === "true") out.up = String(attachable(a.get("up"), "up"));
	for (const side of HORIZONTAL) {
		if (properties[side] !== "true") continue;
		const above = a.get("up");
		out[side] = String(vineCanHoldAt(a.get, side) || (blockOf(above) === blockOf(a.state) && propertiesOf(above)[side] === "true"));
	}
	return { ...properties, ...out };
}

/** Vanilla's VineBlock.canSupportAtFace. */
function vineCanHoldAt(get: (direction: Direction, distance?: number) => number, face: Direction): boolean {
	if (face === "down") return false;
	if (attachable(get(face), OPPOSITE[face])) return true;
	if (face === "up") return false;
	const above = get("up");
	return blockOf(above).type === "vine" && propertiesOf(above)[face] === "true";
}

// ---- entry points ------------------------------------------------------------

function around(getBlock: GetBlock, at: Position, state: number): Around | undefined {
	const rule = rules.get(blockOf(state));
	if (!rule) return undefined;
	const get = (direction: Direction, distance = 1) => {
		const [dx, dy, dz] = OFFSET[direction];
		return getBlock(at.x + dx * distance, at.y + dy * distance, at.z + dz * distance);
	};
	const diagonal = (first: Direction, second: Direction) => {
		const [ax, ay, az] = OFFSET[first];
		const [bx, by, bz] = OFFSET[second];
		return getBlock(at.x + ax + bx, at.y + ay + by, at.z + az + bz);
	};
	return { at, state, rule, get, diagonal, here: getBlock(at.x, at.y, at.z) };
}

/**
 * Vanilla's canSurvive: whether `state` can be at `at`, given the blocks around
 * it. For a block about to be placed, `getBlock` still shows what it replaces
 * at `at`, as in the game.
 */
export function canSurvive(getBlock: GetBlock, at: Position, state: number): boolean {
	const a = around(getBlock, at, state);
	return a === undefined || survivesHere(a);
}

/** The vine at `at` with the faces it can still hold, or the same state for anything else. */
export function updatedVine(getBlock: GetBlock, at: Position, state: number): number {
	if (blockOf(state).type !== "vine") return state;
	const a = around(getBlock, at, state)!;
	return withProperties(state, vineFaces(a));
}

/** Glow lichen and the like let go of the faces that lost their hold. */
export function updatedMultiface(getBlock: GetBlock, at: Position, state: number): number {
	const def = blockOf(state);
	if (rules.get(def)?.survive !== "multiface") return state;
	const properties = propertiesOf(state);
	const out: Record<string, string> = {};
	for (const face of DIRECTIONS) {
		if (properties[face] !== "true") continue;
		const [dx, dy, dz] = OFFSET[face];
		if (!attachable(getBlock(at.x + dx, at.y + dy, at.z + dz), OPPOSITE[face])) out[face] = "false";
	}
	return Object.keys(out).length === 0 ? state : withProperties(state, out);
}

/** For placing a vine: whether a new face towards `face` would hold. */
export function vineCanAttach(getBlock: GetBlock, at: Position, face: Direction): boolean {
	return vineCanHoldAt((direction, distance = 1) => {
		const [dx, dy, dz] = OFFSET[direction];
		return getBlock(at.x + dx * distance, at.y + dy * distance, at.z + dz * distance);
	}, face);
}

/** For placing glow lichen: whether a face towards `face` would hold. */
export function multifaceCanAttach(getBlock: GetBlock, at: Position, face: Direction): boolean {
	const [dx, dy, dz] = OFFSET[face];
	return attachable(getBlock(at.x + dx, at.y + dy, at.z + dz), OPPOSITE[face]);
}

/** Whether the bottom of this state is a full face of its collision box (what a ceiling hanging sign checks above it). */
export function collisionBottomFull(state: number): boolean {
	return has(state, COLLISION_BOTTOM_FULL);
}

/** Whether placing this block needs water where it goes (seagrass, kelp). */
export function needsWaterToPlace(def: BlockDef, replaced: number): boolean {
	if (def.name !== "seagrass" && def.name !== "kelp") return false;
	const fluid = fluidOf(replaced);
	return !(fluid !== undefined && fluidHasTag(replaced, "water") && fluid.full);
}

/** Whether there is a water source here, which a placed block takes in as waterlogged. */
export function hasWaterSource(state: number): boolean {
	return isWaterSource(state);
}
