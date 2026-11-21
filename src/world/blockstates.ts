// Block states. A block (oak_stairs) has properties (facing, half, shape, ...)
// and one numeric state id per combination of their values. This file turns
// ids into properties and back, and answers questions about a block's kind.

import { data } from "../protocol/version";

export interface BlockDef {
	name: string;
	/** Id of the first state. */
	first: number;
	defaultState: number;
	/** The game's block class, such as "stair", "door" or "wall_sign". */
	type: string;
	/** Index into the version data's sound groups. */
	soundGroup: number;
	/** Id in the block registry, which is what tags refer to. */
	registryId: number;
	properties: { name: string; values: string[] }[];
	stateCount: number;
	blockEntity?: number;
	/** Has no collision box: things walk and fall through it. */
	passable: boolean;
	/** Fills its whole cube, so fences connect to it and torches can sit on it. */
	fullCube: boolean;
}

export type Properties = Record<string, string>;

const passable = new Set(data.passable);
const fullCubes = new Set(data.fullCubes);

const defs: BlockDef[] = data.blockDefs.map(([name, first, defaultState, type, registryId, properties, soundGroup]) => ({
	name,
	first,
	defaultState,
	type,
	registryId,
	soundGroup,
	properties: properties.map(([propertyName, values]) => ({ name: propertyName, values })),
	stateCount: properties.reduce((count, [, values]) => count * values.length, 1),
	blockEntity: data.blockEntities[name],
	passable: passable.has(name),
	fullCube: fullCubes.has(name),
}));
const byName = new Map(defs.map((def) => [def.name, def]));

/** Block entity type by state id, or -1. A table, because encoding a chunk asks for every block in it. */
const blockEntityTypes = new Int16Array(data.stateCount).fill(-1);
for (const def of defs) if (def.blockEntity !== undefined) blockEntityTypes.fill(def.blockEntity, def.first, def.first + def.stateCount);

/** The type of block entity this state carries (a chest's, a sign's), or -1 for none. */
export function blockEntityTypeOf(state: number): number {
	return blockEntityTypes[state] ?? -1;
}

export function blockByName(name: string): BlockDef | undefined {
	return byName.get(name.replace(/^minecraft:/, ""));
}

/** The block a state id belongs to. Ids are consecutive per block, so this is a binary search. */
export function blockOf(state: number): BlockDef {
	let low = 0;
	let high = defs.length - 1;
	while (low < high) {
		const middle = (low + high + 1) >> 1;
		if (defs[middle]!.first <= state) low = middle;
		else high = middle - 1;
	}
	return defs[low]!;
}

export function propertiesOf(state: number): Properties {
	const def = blockOf(state);
	const out: Properties = {};
	let rest = state - def.first;
	let stride = def.stateCount;
	for (const property of def.properties) {
		stride /= property.values.length;
		out[property.name] = property.values[Math.floor(rest / stride)]!;
		rest %= stride;
	}
	return out;
}

/** The state of `def` with these property values. Properties left out keep their default. */
export function stateOf(def: BlockDef, properties: Properties = {}): number {
	const defaults = def.properties.length > 0 ? propertiesOf(def.defaultState) : {};
	let state = def.first;
	let stride = def.stateCount;
	for (const property of def.properties) {
		stride /= property.values.length;
		const index = property.values.indexOf(properties[property.name] ?? defaults[property.name]!);
		state += (index < 0 ? property.values.indexOf(defaults[property.name]!) : index) * stride;
	}
	return state;
}

/**
 * A state written out, such as "oak_stairs[facing=north,half=top]". Unlike a
 * state id, this means the same thing in every game version.
 */
export function stateName(state: number): string {
	const def = blockOf(state);
	if (def.properties.length === 0) return def.name;
	const properties = propertiesOf(state);
	return `${def.name}[${def.properties.map((property) => `${property.name}=${properties[property.name]}`).join(",")}]`;
}

/**
 * The state a name written by stateName() stands for, or undefined when this
 * version has no such block. A property this version does not know is ignored
 * and one the name leaves out keeps its default.
 */
export function stateFromName(text: string): number | undefined {
	const bracket = text.indexOf("[");
	const def = byName.get(bracket < 0 ? text : text.slice(0, bracket));
	if (!def) return undefined;
	if (bracket < 0) return stateOf(def);
	const properties: Properties = {};
	for (const pair of text.slice(bracket + 1, -1).split(",")) {
		const equals = pair.indexOf("=");
		properties[pair.slice(0, equals)] = pair.slice(equals + 1);
	}
	return stateOf(def, properties);
}

/** The same block with some properties changed. */
export function withProperties(state: number, changes: Properties): number {
	return stateOf(blockOf(state), { ...propertiesOf(state), ...changes });
}

export function hasProperty(def: BlockDef, name: string, value?: string): boolean {
	const property = def.properties.find((p) => p.name === name);
	return property !== undefined && (value === undefined || property.values.includes(value));
}

const blockTags = new Map((data.tags.find(([registry]) => registry === "minecraft:block")?.[1] ?? []).map(([name, ids]) => [name, new Set(ids)]));

export function hasTag(def: BlockDef, tag: string): boolean {
	return blockTags.get(`minecraft:${tag}`)?.has(def.registryId) ?? false;
}

/** Air, grass, water and the like: placing a block here simply overwrites it. */
export function isReplaceable(state: number): boolean {
	return state === 0 || hasTag(blockOf(state), "replaceable");
}

// ---- directions --------------------------------------------------------------

export type Direction = "down" | "up" | "north" | "south" | "west" | "east";

/** In the order the protocol numbers block faces. */
export const DIRECTIONS: Direction[] = ["down", "up", "north", "south", "west", "east"];
export const HORIZONTAL: Direction[] = ["north", "east", "south", "west"];

export const OFFSET: Record<Direction, readonly [number, number, number]> = {
	down: [0, -1, 0],
	up: [0, 1, 0],
	north: [0, 0, -1],
	south: [0, 0, 1],
	west: [-1, 0, 0],
	east: [1, 0, 0],
};

export const OPPOSITE: Record<Direction, Direction> = { down: "up", up: "down", north: "south", south: "north", west: "east", east: "west" };

export function clockwise(direction: Direction): Direction {
	return HORIZONTAL[(HORIZONTAL.indexOf(direction) + 1) % 4] ?? direction;
}
export function counterClockwise(direction: Direction): Direction {
	return HORIZONTAL[(HORIZONTAL.indexOf(direction) + 3) % 4] ?? direction;
}

export function axisOf(direction: Direction): "x" | "y" | "z" {
	return direction === "up" || direction === "down" ? "y" : direction === "east" || direction === "west" ? "x" : "z";
}

/** The compass direction a player with this yaw is looking in. Yaw 0 is south. */
export function horizontalFacing(yaw: number): Direction {
	return (["south", "west", "north", "east"] as const)[Math.floor(yaw / 90 + 0.5) & 3]!;
}

/** Like horizontalFacing, but up or down when the player looks steeply. */
export function nearestFacing(yaw: number, pitch: number): Direction {
	if (pitch > 45) return "down";
	if (pitch < -45) return "up";
	return horizontalFacing(yaw);
}

/** A yaw as one of the 16 rotations signs and banners can stand in. */
export function rotationSegment(yaw: number): string {
	return String(Math.floor((yaw * 16) / 360 + 0.5) & 15);
}
