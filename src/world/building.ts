// The rules of building: which state a block gets when it is placed, how
// blocks react to their neighbours, what falls off when its support is
// removed, and what right-clicking a block does.
//
// These follow vanilla's behaviour block class by block class. They are pure
// functions over "what block is at x, y, z"; world.ts applies the results.

import {
	OFFSET,
	OPPOSITE,
	HORIZONTAL,
	axisOf,
	blockByName,
	blockOf,
	clockwise,
	counterClockwise,
	hasProperty,
	hasTag,
	horizontalFacing,
	isReplaceable,
	nearestFacing,
	propertiesOf,
	rotationSegment,
	stateOf,
	withProperties,
	type BlockDef,
	type Direction,
	type Properties,
} from "./blockstates";

export type GetBlock = (x: number, y: number, z: number) => number;

export interface Position {
	x: number;
	y: number;
	z: number;
}

export interface BlockChange extends Position {
	state: number;
}

const AIR = 0;
const WATER_SOURCE = blockByName("water")?.defaultState;

function offset(at: Position, direction: Direction, distance = 1): Position {
	const [dx, dy, dz] = OFFSET[direction];
	return { x: at.x + dx * distance, y: at.y + dy * distance, z: at.z + dz * distance };
}

// ---- which block an item places ---------------------------------------------

/** Items named differently from the block they place. */
const ITEM_BLOCKS: Record<string, string> = {
	water_bucket: "water",
	lava_bucket: "lava",
	powder_snow_bucket: "powder_snow",
	redstone: "redstone_wire",
	string: "tripwire",
	wheat_seeds: "wheat",
	beetroot_seeds: "beetroots",
	carrot: "carrots",
	potato: "potatoes",
	melon_seeds: "melon_stem",
	pumpkin_seeds: "pumpkin_stem",
	torchflower_seeds: "torchflower_crop",
	pitcher_pod: "pitcher_crop",
	cocoa_beans: "cocoa",
	sweet_berries: "sweet_berry_bush",
	glow_berries: "cave_vines",
};
const BLOCK_ITEMS: Record<string, string> = Object.fromEntries(Object.entries(ITEM_BLOCKS).map(([item, block]) => [block, item]));

/** Blocks that come in a standing and a wall-mounted form, by the end of their name. */
const WALL_FORMS = ["hanging_sign", "sign", "torch", "banner", "skull", "head", "coral_fan"];

/** "oak_sign" -> "oak_wall_sign", for blocks that have a wall form. */
function wallForm(def: BlockDef): BlockDef | undefined {
	for (const suffix of WALL_FORMS) {
		if (def.name === suffix || def.name.endsWith(`_${suffix}`)) {
			return blockByName(`${def.name.slice(0, def.name.length - suffix.length)}wall_${suffix}`);
		}
	}
	return undefined;
}

export function blockForItem(item: string): BlockDef | undefined {
	return blockByName(ITEM_BLOCKS[item] ?? item);
}

/** The item a block drops as, such as "oak_sign" for "oak_wall_sign". */
export function itemForBlock(def: BlockDef): string {
	const standing = def.name.replace("wall_", "");
	const name = def.name.includes("wall_") && wallForm(blockByName(standing) ?? def) === def ? standing : def.name;
	return BLOCK_ITEMS[name] ?? name;
}

// ---- placing ------------------------------------------------------------------

export interface Placement {
	getBlock: GetBlock;
	/** Item name, without namespace. */
	item: string;
	clicked: Position;
	/** The face of the clicked block that was hit. */
	face: Direction;
	/** Where on the clicked block the crosshair was, 0 to 1 on each axis. */
	cursor: Position;
	yaw: number;
	pitch: number;
	minY: number;
	maxY: number;
}

/** Block classes whose "facing" is the face they were placed against. */
const FACES_CLICKED_SIDE = new Set(["ladder", "trip_wire_hook", "end_rod", "lightning_rod", "weathering_lightning_rod", "amethyst_cluster", "shulker_box"]);
/** Block classes that face the way the player looks. Most others face the player instead. */
const FACES_AWAY = new Set(["stair", "weathering_copper_stair", "door", "weathering_copper_door", "fence_gate", "bed", "straw_bed", "campfire"]);
/** Properties that count how many of the block share one space: candles, sea pickles, snow layers. */
const STACK_COUNTERS = ["candles", "pickles", "flower_amount", "segment_amount", "layers", "eggs"];
const MULTIFACE = new Set(["vine", "multiface", "glow_lichen", "sculk_vein"]);

/**
 * Clicking a block with the same block in hand sometimes adds to it instead of
 * placing a new one: a second slab makes a double slab, a second candle joins
 * the first.
 */
function stackOnto(state: number, def: BlockDef, placement?: Pick<Placement, "face" | "cursor">): number | undefined {
	const properties = propertiesOf(state);
	if (properties.type === "top" || properties.type === "bottom") {
		if (placement) {
			// Only when the click was on the slab's open side.
			const upperHalf = placement.cursor.y > 0.5;
			const sideways = placement.face !== "up" && placement.face !== "down";
			const fills = properties.type === "bottom" ? placement.face === "up" || (sideways && upperHalf) : placement.face === "down" || (sideways && !upperHalf);
			if (!fills) return undefined;
		}
		return withProperties(state, { type: "double" });
	}
	for (const counter of STACK_COUNTERS) {
		const values = def.properties.find((property) => property.name === counter)?.values;
		const next = values?.[values.indexOf(properties[counter]!) + 1];
		if (next !== undefined) return withProperties(state, { [counter]: next });
	}
	return undefined;
}

/**
 * Every block change that placing this item causes, or nothing when it cannot
 * be placed there. Doors, beds and tall plants are two blocks.
 */
export function place(p: Placement): BlockChange[] | undefined {
	let def = blockForItem(p.item);
	if (!def) return undefined;
	const get = (at: Position) => p.getBlock(at.x, at.y, at.z);

	const clickedState = get(p.clicked);
	if (blockOf(clickedState) === def) {
		const stacked = stackOnto(clickedState, def, p);
		if (stacked !== undefined) return [{ ...p.clicked, state: stacked }];
	}

	const replacingClicked = isReplaceable(clickedState);
	const at = replacingClicked ? p.clicked : offset(p.clicked, p.face);
	if (at.y < p.minY || at.y > p.maxY) return undefined;
	const existing = get(at);
	if (!replacingClicked && blockOf(existing) === def) {
		const stacked = stackOnto(existing, def);
		if (stacked !== undefined) return [{ ...at, state: stacked }];
	}
	if (!isReplaceable(existing)) return undefined;

	const looking = horizontalFacing(p.yaw);
	const sideways = p.face !== "up" && p.face !== "down";
	const upperHalf = p.face === "down" || (sideways && p.cursor.y > 0.5);
	const set: Properties = {};

	// Torches, signs, banners and heads become their wall form on the side of a block.
	const wall = wallForm(def);
	if (wall) {
		const hangs = def.type === "ceiling_hanging_sign";
		if (sideways) {
			def = wall;
			set.facing = hangs ? hangingSignFacing(p.face, p.yaw) : p.face;
		} else if (hangs ? p.face === "up" : p.face === "down") {
			return undefined; // nothing to stand on, or nothing to hang from
		}
	}

	if (hasProperty(def, "axis")) set.axis = axisOf(p.face);
	if (hasProperty(def, "rotation")) set.rotation = rotationSegment(def.type.includes("skull") || def.type.includes("head") ? p.yaw : p.yaw + 180);
	if (hasProperty(def, "half", "top")) set.half = upperHalf ? "top" : "bottom";
	if (hasProperty(def, "type", "double")) set.type = upperHalf ? "top" : "bottom";
	if (hasProperty(def, "hanging")) set.hanging = String(p.face === "down");
	if (hasProperty(def, "persistent")) set.persistent = "true"; // placed leaves never decay
	if (hasProperty(def, "shape", "north_south")) set.shape = axisOf(looking) === "x" ? "east_west" : "north_south"; // rails
	if (MULTIFACE.has(def.type) && hasProperty(def, OPPOSITE[p.face])) set[OPPOSITE[p.face]] = "true";

	if (hasProperty(def, "face", "ceiling")) {
		// Buttons, levers and grindstones attach to the face that was clicked.
		set.face = p.face === "up" ? "floor" : p.face === "down" ? "ceiling" : "wall";
		set.facing = sideways ? p.face : looking;
	} else if (set.facing === undefined && hasProperty(def, "facing")) {
		const sixWay = hasProperty(def, "facing", "up");
		let facing: Direction;
		if (def.type.includes("trap_door")) facing = sideways ? p.face : OPPOSITE[looking];
		else if (FACES_CLICKED_SIDE.has(def.type)) facing = p.face;
		else if (def.type === "hopper") facing = sideways ? OPPOSITE[p.face] : "down";
		else if (def.type === "observer") facing = nearestFacing(p.yaw, p.pitch);
		else if (sixWay) facing = OPPOSITE[nearestFacing(p.yaw, p.pitch)];
		else if (def.type === "anvil") facing = clockwise(looking);
		else facing = FACES_AWAY.has(def.type) ? looking : OPPOSITE[looking];
		// A block that only turns sideways cannot face up or down.
		set.facing = hasProperty(def, "facing", facing) ? facing : OPPOSITE[looking];
	}

	if (hasProperty(def, "hinge")) set.hinge = doorHinge(p, at, set.facing as Direction);
	if (hasProperty(def, "waterlogged")) set.waterlogged = String(existing === WATER_SOURCE);

	const changes: BlockChange[] = [{ ...at, state: stateOf(def, set) }];
	let second: BlockChange | undefined;
	if (hasProperty(def, "half", "upper")) {
		changes[0]!.state = stateOf(def, { ...set, half: "lower" });
		second = { ...offset(at, "up"), state: stateOf(def, { ...set, half: "upper" }) };
	} else if (hasProperty(def, "part", "head")) {
		changes[0]!.state = stateOf(def, { ...set, part: "foot" });
		second = { ...offset(at, looking), state: stateOf(def, { ...set, part: "head" }) };
	}
	if (second) {
		if (second.y > p.maxY || !isReplaceable(get(second))) return undefined;
		changes.push(second);
	}
	return changes;
}

/** A wall hanging sign faces along the wall, to whichever side the player is on. */
function hangingSignFacing(wallFace: Direction, yaw: number): Direction {
	const radians = (yaw * Math.PI) / 180;
	const [lookX, lookZ] = [-Math.sin(radians), Math.cos(radians)];
	const along = (direction: Direction) => lookX * OFFSET[direction][0] + lookZ * OFFSET[direction][2];
	const [a, b] = [clockwise(wallFace), counterClockwise(wallFace)];
	return along(a) < along(b) ? a : b;
}

/**
 * Vanilla's rule for which side a door hinges on: away from a door next to it
 * (so the two make a pair), else towards the side with more solid blocks, else
 * on the half of the block that was clicked.
 */
function doorHinge(p: Placement, at: Position, facing: Direction): "left" | "right" {
	const beside = (direction: Direction, up: number) => {
		const neighbour = offset(at, direction);
		return p.getBlock(neighbour.x, neighbour.y + up, neighbour.z);
	};
	const [left, right] = [counterClockwise(facing), clockwise(facing)];
	const isLowerDoor = (state: number) => blockOf(state).type.endsWith("door") && propertiesOf(state).half === "lower";
	const solid = (state: number) => (blockOf(state).fullCube ? 1 : 0);
	const leftDoor = isLowerDoor(beside(left, 0));
	const rightDoor = isLowerDoor(beside(right, 0));
	const solidBalance = solid(beside(right, 0)) + solid(beside(right, 1)) - solid(beside(left, 0)) - solid(beside(left, 1));
	if ((leftDoor && !rightDoor) || solidBalance > 0) return "right";
	if ((rightDoor && !leftDoor) || solidBalance < 0) return "left";
	const [stepX, , stepZ] = OFFSET[facing];
	// Where the click landed, measured from the door's own block.
	const x = p.clicked.x + p.cursor.x - at.x;
	const z = p.clicked.z + p.cursor.z - at.z;
	const onLeft = (stepX >= 0 || z >= 0.5) && (stepX <= 0 || z <= 0.5) && (stepZ >= 0 || x <= 0.5) && (stepZ <= 0 || x >= 0.5);
	return onLeft ? "left" : "right";
}

// ---- reacting to neighbours ---------------------------------------------------

const FENCES = new Set(["fence"]);
/** Full blocks that fences, panes and walls still do not join up with. */
const NEVER_JOINED = new Set(["barrier", "pumpkin", "carved_pumpkin", "jack_o_lantern", "melon"]);
const PANES = new Set(["iron_bars", "stained_glass_pane", "weathering_copper_bars"]);
const isStairs = (def: BlockDef) => def.type === "stair" || def.type === "weathering_copper_stair";
const isGate = (def: BlockDef) => def.type === "fence_gate";

/** Whether a fence, pane or wall at one block joins up with the block in this direction. */
function connects(self: BlockDef, neighbourState: number, direction: Direction): boolean {
	const neighbour = blockOf(neighbourState);
	if (neighbour.fullCube) return !hasTag(neighbour, "leaves") && !NEVER_JOINED.has(neighbour.name);
	if (FENCES.has(self.type)) {
		if (isGate(neighbour)) return axisOf(propertiesOf(neighbourState).facing as Direction) !== axisOf(direction);
		// Wooden fences join each other; the nether brick fence only joins itself.
		return FENCES.has(neighbour.type) && (self === neighbour || (hasTag(self, "wooden_fences") && hasTag(neighbour, "wooden_fences")));
	}
	if (PANES.has(neighbour.type) || neighbour.type === "wall") return true;
	return self.type === "wall" && isGate(neighbour) && axisOf(propertiesOf(neighbourState).facing as Direction) !== axisOf(direction);
}

/** Whether a stair may bend towards `direction`: not when a matching stair already continues there. */
function stairCanBend(get: (at: Position) => number, at: Position, properties: Properties, direction: Direction): boolean {
	const state = get(offset(at, direction));
	if (!isStairs(blockOf(state))) return true;
	const other = propertiesOf(state);
	return other.facing !== properties.facing || other.half !== properties.half;
}

/** Stairs turn into corner pieces next to perpendicular stairs. */
function stairShape(get: (at: Position) => number, at: Position, properties: Properties): string {
	const facing = properties.facing as Direction;
	for (const [toward, inner] of [
		[facing, false],
		[OPPOSITE[facing], true],
	] as const) {
		const state = get(offset(at, toward));
		if (!isStairs(blockOf(state))) continue;
		const other = propertiesOf(state);
		const otherFacing = other.facing as Direction;
		if (other.half !== properties.half || axisOf(otherFacing) === axisOf(facing)) continue;
		if (!stairCanBend(get, at, properties, inner ? otherFacing : OPPOSITE[otherFacing])) continue;
		const side = otherFacing === counterClockwise(facing) ? "left" : "right";
		return `${inner ? "inner" : "outer"}_${side}`;
	}
	return "straight";
}

/**
 * The state a block should have given what is around it now: fences, panes and
 * walls connect, stairs form corners, fence gates sink into walls. Returns the
 * same state when nothing changes.
 */
export function reshape(getBlock: GetBlock, at: Position): number {
	const get = (position: Position) => getBlock(position.x, position.y, position.z);
	const state = get(at);
	if (state === AIR) return state;
	const def = blockOf(state);

	if (FENCES.has(def.type) || PANES.has(def.type)) {
		const sides: Properties = {};
		for (const direction of HORIZONTAL) sides[direction] = String(connects(def, get(offset(at, direction)), direction));
		return withProperties(state, sides);
	}
	if (def.type === "wall") {
		const sides: Properties = {};
		for (const direction of HORIZONTAL) sides[direction] = connects(def, get(offset(at, direction)), direction) ? "low" : "none";
		const joined = HORIZONTAL.filter((direction) => sides[direction] !== "none");
		// A straight run of wall has no post; ends, corners and junctions do.
		const straight = joined.length === 2 && joined[0] === OPPOSITE[joined[1]!];
		return withProperties(state, { ...sides, up: String(!straight || get(offset(at, "up")) !== AIR) });
	}
	if (isStairs(def)) {
		const properties = propertiesOf(state);
		return withProperties(state, { shape: stairShape(get, at, properties) });
	}
	if (isGate(def)) {
		const facing = propertiesOf(state).facing as Direction;
		const inWall = [clockwise(facing), counterClockwise(facing)].some((side) => blockOf(get(offset(at, side))).type === "wall");
		return withProperties(state, { in_wall: String(inWall) });
	}
	return state;
}

// ---- support -------------------------------------------------------------------

/** Block classes mounted on the side of the block behind them. */
const WALL_MOUNTED = new Set([
	"wall_torch",
	"redstone_wall_torch",
	"wall_sign",
	"wall_banner",
	"ladder",
	"trip_wire_hook",
	"coral_wall_fan",
	"base_coral_wall_fan",
]);
/** Solid block classes that still need a block under them. */
const NEEDS_FLOOR = new Set(["carpet", "wool_carpet", "repeater", "comparator", "candle", "cake", "snow_layer", "door", "weathering_copper_door", "lantern", "weathering_lantern", "bed", "straw_bed"]);
const FLOATS = new Set([
	"liquid", "air", "fire", "soul_fire", "nether_portal", "end_portal", "end_gateway", "structure_void", "light", "bubble_column", "trip_wire", "web",
	"moving_piston", "powder_snow",
]);
/** Block classes that hang from the block above them. */
const HANGS = new Set(["hanging_roots", "hanging_moss", "spore_blossom", "weeping_vines", "weeping_vines_plant", "cave_vines", "cave_vines_plant"]);

/** Which neighbour a block is attached to, if it needs one to stay in place. */
function supportDirection(state: number): Direction | undefined {
	const def = blockOf(state);
	const properties = propertiesOf(state);
	if (properties.face === "wall" || WALL_MOUNTED.has(def.type)) return OPPOSITE[properties.facing as Direction];
	if (properties.face === "ceiling" || properties.hanging === "true" || def.type === "ceiling_hanging_sign" || HANGS.has(def.type)) return "up";
	if (properties.face === "floor") return "down";
	if (properties.half === "upper" || properties.part === "head") return undefined; // held by its other half
	if (def.type === "bed" || def.type === "straw_bed") return undefined;
	if (MULTIFACE.has(def.type) || FLOATS.has(def.type) || def.type === "wall_hanging_sign" || def.type.includes("wall_skull")) return undefined;
	if (def.passable || NEEDS_FLOOR.has(def.type)) return "down";
	return undefined;
}

/** The other block of a door, bed or tall plant, if this is one. */
export function otherHalf(state: number, at: Position): Position | undefined {
	const properties = propertiesOf(state);
	if (properties.half === "upper") return offset(at, "down");
	if (properties.half === "lower") return offset(at, "up");
	if (properties.part === "head") return offset(at, OPPOSITE[properties.facing as Direction]);
	if (properties.part === "foot") return offset(at, properties.facing as Direction);
	return undefined;
}

/**
 * Blocks around `at` that were attached to it and are now attached to nothing:
 * the torch on its side, the flower on top, the lantern hanging below.
 */
export function unsupportedAround(getBlock: GetBlock, at: Position): Position[] {
	// Only a block that is gone lets go of things. Which shapes hold a torch or
	// a lantern is not modelled, so any block that is still there keeps them.
	const state = getBlock(at.x, at.y, at.z);
	if (state !== AIR && !blockOf(state).passable) return [];
	const out: Position[] = [];
	for (const direction of ["up", "down", ...HORIZONTAL] as Direction[]) {
		const neighbour = offset(at, direction);
		const attached = getBlock(neighbour.x, neighbour.y, neighbour.z);
		if (attached !== AIR && supportDirection(attached) === OPPOSITE[direction]) out.push(neighbour);
	}
	return out;
}

// ---- right-clicking -------------------------------------------------------------

export interface Interaction {
	changes: BlockChange[];
	sound?: string;
	/** Defaults to 1. */
	volume?: number;
	/** Defaults to a random pitch just under 1, like a door's. */
	pitch?: number;
	/**
	 * Whether the server also sends the sound to the player who clicked. The
	 * game plays a door's sound by itself for that player, but not a lever's.
	 */
	soundForActor?: boolean;
	/** Undo `changes` after this many ticks (a button popping back out). */
	revertAfterTicks?: number;
	revertSound?: string;
}

/** Block classes that open a screen in vanilla. Nothing happens here, but no block is placed either. */
const HAS_SCREEN = new Set([
	"chest", "trapped_chest", "ender_chest", "copper_chest", "weathering_copper_chest", "barrel", "shulker_box", "furnace", "blast_furnace", "smoker",
	"hopper", "dispenser", "dropper", "brewing_stand", "crafting_table", "enchanting_table", "anvil", "loom", "stonecutter", "grindstone",
	"cartography_table", "smithing_table", "beacon", "crafter", "bed", "straw_bed", "note", "jukebox", "lectern", "command", "structure", "jigsaw",
]);

function material(def: BlockDef): "iron" | "copper" | "wooden" {
	return def.name.startsWith("iron_") ? "iron" : def.name.includes("copper") ? "copper" : "wooden";
}

/**
 * What right-clicking this block does. "nothing" means the click is used up
 * without effect; undefined means the block is not interactive, so the click
 * places the held block instead.
 */
export function interact(getBlock: GetBlock, at: Position, yaw: number, heldItem?: string): Interaction | "nothing" | undefined {
	const state = getBlock(at.x, at.y, at.z);
	const def = blockOf(state);
	const properties = propertiesOf(state);
	const flip = (property: string) => String(properties[property] !== "true");

	if (def.type.includes("door")) {
		// Covers doors and trapdoors. Iron ones only open with redstone.
		if (material(def) === "iron") return undefined;
		const open = flip("open");
		const changes: BlockChange[] = [{ ...at, state: withProperties(state, { open }) }];
		const other = def.type.includes("trap_door") ? undefined : otherHalf(state, at);
		if (other) {
			const otherState = getBlock(other.x, other.y, other.z);
			if (blockOf(otherState) === def) changes.push({ ...other, state: withProperties(otherState, { open }) });
		}
		const kind = def.type.includes("trap_door") ? "trapdoor" : "door";
		return { changes, sound: `block.${material(def)}_${kind}.${open === "true" ? "open" : "close"}` };
	}
	if (isGate(def)) {
		const open = flip("open");
		const looking = horizontalFacing(yaw);
		// A gate swings away from whoever opens it.
		const facing = open === "true" && properties.facing === OPPOSITE[looking] ? looking : properties.facing!;
		return { changes: [{ ...at, state: withProperties(state, { open, facing }) }], sound: `block.fence_gate.${open === "true" ? "open" : "close"}` };
	}
	if (def.type === "lever") {
		const powered = flip("powered");
		return {
			changes: [{ ...at, state: withProperties(state, { powered }) }],
			sound: "block.lever.click",
			volume: 0.3,
			pitch: powered === "true" ? 0.6 : 0.5,
			soundForActor: true,
		};
	}
	if (def.type === "button") {
		if (properties.powered === "true") return "nothing";
		const kind = hasTag(def, "wooden_buttons") ? "wooden" : "stone";
		return {
			changes: [{ ...at, state: withProperties(state, { powered: "true" }) }],
			sound: `block.${kind}_button.click_on`,
			pitch: 1,
			soundForActor: true,
			revertAfterTicks: kind === "wooden" ? 30 : 20,
			revertSound: `block.${kind}_button.click_off`,
		};
	}
	if (def.type === "repeater") {
		return { changes: [{ ...at, state: withProperties(state, { delay: String((Number(properties.delay) % 4) + 1) }) }] };
	}
	if (def.type === "comparator") {
		const mode = properties.mode === "compare" ? "subtract" : "compare";
		return { changes: [{ ...at, state: withProperties(state, { mode }) }], sound: "block.comparator.click", volume: 0.3, pitch: mode === "subtract" ? 0.55 : 0.5 };
	}
	if (def.type === "daylight_detector") {
		return { changes: [{ ...at, state: withProperties(state, { inverted: flip("inverted") }) }] };
	}
	if (def.type === "flower_pot") {
		// An empty pot takes the plant in the player's hand; a full one gives it back.
		const potted = heldItem === undefined ? undefined : blockByName(`potted_${heldItem}`);
		if (def.name === "flower_pot") return potted ? { changes: [{ ...at, state: potted.defaultState }] } : "nothing";
		return potted ? "nothing" : { changes: [{ ...at, state: blockByName("flower_pot")!.defaultState }] };
	}
	return HAS_SCREEN.has(def.type) ? "nothing" : undefined;
}

// ---- signs ----------------------------------------------------------------------

export type SignText = { messages: string[]; color: string; has_glowing_text: boolean };
/** A sign's block entity data, in the shape the game stores and sends it. */
export type SignData = { front_text: SignText; back_text: SignText; is_waxed: boolean };

export function blankSign(): SignData {
	const blank = (): SignText => ({ messages: ["", "", "", ""], color: "black", has_glowing_text: false });
	return { front_text: blank(), back_text: blank(), is_waxed: false };
}

const SIGN_LINE_LENGTH = 384;

/** The four lines a player typed, without formatting codes. */
export function signLines(lines: string[]): string[] {
	return Array.from({ length: 4 }, (_, line) => (lines[line] ?? "").replace(/\u00a7./g, "").slice(0, SIGN_LINE_LENGTH));
}

/**
 * Uses a dye, an ink sac or honeycomb on a sign. Returns false when the item
 * does nothing to it, in which case the click opens the editor instead.
 */
export function applyToSign(sign: SignData, front: boolean, item: string | undefined): boolean {
	if (item === "honeycomb") {
		sign.is_waxed = true;
		return true;
	}
	const text = front ? sign.front_text : sign.back_text;
	if (!text.messages.some((line) => line !== "")) return false; // nothing to colour
	const color = item?.endsWith("_dye") ? item.slice(0, -"_dye".length) : undefined;
	const glowing = item === "glow_ink_sac" ? true : item === "ink_sac" ? false : undefined;
	if (color !== undefined && color !== text.color) text.color = color;
	else if (glowing !== undefined && glowing !== text.has_glowing_text) text.has_glowing_text = glowing;
	else return false;
	return true;
}

export function isSign(def: BlockDef): boolean {
	return def.type === "standing_sign" || def.type === "wall_sign" || def.type === "ceiling_hanging_sign" || def.type === "wall_hanging_sign";
}

/** Whether a player standing at (x, z) sees the front of this sign rather than its back. */
export function facesSignFront(state: number, at: Position, x: number, z: number): boolean {
	const properties = propertiesOf(state);
	const frontYaw = properties.rotation !== undefined ? Number(properties.rotation) * 22.5 : { south: 0, west: 90, north: 180, east: 270 }[properties.facing as string] ?? 0;
	const toPlayer = (Math.atan2(-(x - (at.x + 0.5)), z - (at.z + 0.5)) * 180) / Math.PI;
	const difference = Math.abs(((toPlayer - frontYaw + 540) % 360) - 180);
	return difference <= 90;
}
