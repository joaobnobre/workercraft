// The rules of building: which state a block gets when it is placed, how
// blocks react to their neighbours, what falls off when its support is
// removed, and what right-clicking a block does.
//
// These follow vanilla's behaviour block class by block class. They are pure
// functions over "what block is at x, y, z"; world.ts applies the results.

import {
	DIRECTIONS,
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
import {
	canSurvive,
	collisionBottomFull,
	hasWaterSource,
	isFaceSturdy,
	multifaceCanAttach,
	needsWaterToPlace,
	updatedMultiface,
	updatedVine,
	vineCanAttach,
} from "./survival";

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
	/** Sneaking, which the game calls using the item's secondary action. */
	sneaking?: boolean;
}

/** Block classes whose "facing" is the face they were placed against. */
const FACES_CLICKED_SIDE = new Set(["end_rod", "lightning_rod", "weathering_lightning_rod", "amethyst_cluster", "shulker_box"]);
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
 * The six directions, nearest to where the player looks first: vanilla's
 * Direction.orderedByNearest, with the block that was clicked moved to the
 * front unless the click replaces it (BlockPlaceContext.getNearestLookingDirections).
 * Blocks that can hang on several sides take the first of these that holds them.
 */
function nearestLookingDirections(yaw: number, pitch: number, face: Direction, replacingClicked: boolean): Direction[] {
	const pitchRadians = (pitch * Math.PI) / 180;
	const yawRadians = (-yaw * Math.PI) / 180;
	const [sinPitch, cosPitch, sinYaw, cosYaw] = [Math.sin(pitchRadians), Math.cos(pitchRadians), Math.sin(yawRadians), Math.cos(yawRadians)];
	const [east, up, south] = [sinYaw > 0, sinPitch < 0, cosYaw > 0];
	const x = east ? sinYaw : -sinYaw;
	const y = up ? -sinPitch : sinPitch;
	const z = south ? cosYaw : -cosYaw;
	const [xLevel, zLevel] = [x * cosPitch, z * cosPitch];
	const alongX: Direction = east ? "east" : "west";
	const alongY: Direction = up ? "up" : "down";
	const alongZ: Direction = south ? "south" : "north";
	let order: [Direction, Direction, Direction];
	if (x > z) order = y > xLevel ? [alongY, alongX, alongZ] : zLevel > y ? [alongX, alongZ, alongY] : [alongX, alongY, alongZ];
	else order = y > zLevel ? [alongY, alongZ, alongX] : xLevel > y ? [alongZ, alongX, alongY] : [alongZ, alongY, alongX];
	const all = [...order, ...order.map((direction) => OPPOSITE[direction]).reverse()];
	if (replacingClicked) return all;
	return [OPPOSITE[face], ...all.filter((direction) => direction !== OPPOSITE[face])];
}

const isHorizontal = (direction: Direction) => direction !== "up" && direction !== "down";

/** What a placement knows besides the item: where the block goes and which ways it could hang. */
interface PlaceContext {
	p: Placement;
	at: Position;
	/** What is at `at` now: air, or something the block replaces. */
	existing: number;
	replacingClicked: boolean;
	directions: Direction[];
	/** The compass direction the player looks in. */
	looking: Direction;
}

/** A block and the properties a placement rule chose; the rest are filled in by finish(). */
interface Candidate {
	def: BlockDef;
	set: Properties;
	/** A further check besides canSurvive, as for a wall hanging sign. */
	check?: (state: number) => boolean;
}

/**
 * The states this placement may end up as, in the order the game tries them.
 * The first that can stay where it is put is placed; when none can, nothing
 * is. Most blocks have one candidate; blocks that attach to something try the
 * sides nearest to where the player looks.
 */
function candidates(def: BlockDef, c: PlaceContext): Candidate[] {
	const { directions, looking } = c;
	const horizontal = directions.filter(isHorizontal);
	const facingAway = (each: Direction[]) => each.map((direction) => ({ def, set: { facing: OPPOSITE[direction] } }));

	// Torches, signs, banners, heads and coral fans: standing, or on a wall
	// (StandingAndWallBlockItem). Hanging signs hang from above or on a wall.
	const wall = wallForm(def);
	if (wall) {
		const hanging = def.type === "ceiling_hanging_sign";
		const attachment: Direction = hanging ? "up" : "down";
		const out: Candidate[] = [];
		let wallsTried = false;
		for (const direction of directions) {
			if (direction === OPPOSITE[attachment]) continue;
			if (direction === attachment) out.push(hanging ? ceilingHangingSign(def, c) : { def, set: {} });
			else if (!wallsTried) {
				wallsTried = true;
				out.push(...wallCandidates(wall, c));
			}
		}
		return out;
	}
	if (hasProperty(def, "face", "ceiling")) {
		// Buttons, levers and grindstones (FaceAttachedHorizontalDirectionalBlock).
		return directions.map((direction) =>
			isHorizontal(direction)
				? { def, set: { face: "wall", facing: OPPOSITE[direction] } }
				: { def, set: { face: direction === "up" ? "ceiling" : "floor", facing: looking } },
		);
	}
	switch (def.type) {
		case "lantern":
		case "weathering_lantern":
			return directions.filter((direction) => !isHorizontal(direction)).map((direction) => ({ def, set: { hanging: String(direction === "up") } }));
		case "ladder": {
			const clicked = c.p.getBlock(c.p.clicked.x, c.p.clicked.y, c.p.clicked.z);
			if (!c.replacingClicked && blockOf(clicked) === def && propertiesOf(clicked).facing === c.p.face) return [];
			return facingAway(horizontal);
		}
		case "trip_wire_hook":
		case "shelf_mushroom":
			return facingAway(horizontal);
		case "cocoa":
			return horizontal.map((direction) => ({ def, set: { facing: direction } }));
		case "bell":
			return bellCandidates(def, c);
		case "vine":
			return vineCandidate(def, c);
		case "speleothem":
		case "pointed_dripstone": {
			const tip = c.p.pitch < 0 ? "down" : "up"; // away from where the player looks, up or down
			const property = hasProperty(def, "tip_direction") ? "tip_direction" : "vertical_direction";
			return [tip, OPPOSITE[tip]].map((each) => ({ def, set: { [property]: each } }));
		}
	}
	if (MULTIFACE.has(def.type) && def.type !== "vine") return multifaceCandidates(def, c);
	return [{ def, set: {} }];
}

/** A wall torch, sign or banner faces away from the first wall beside it, nearest to where the player looks, that holds it. */
function wallCandidates(wall: BlockDef, c: PlaceContext): Candidate[] {
	const horizontal = c.directions.filter(isHorizontal);
	if (wall.type === "wall_hanging_sign") {
		// It hangs along a wall, so it may not face the side that was clicked,
		// and needs something to hang from on one side or the other.
		return horizontal
			.filter((direction) => axisOf(direction) !== axisOf(c.p.face))
			.map((direction) => {
				const facing = OPPOSITE[direction];
				const holds = (side: Direction) => {
					const next = offset(c.at, side);
					const state = c.p.getBlock(next.x, next.y, next.z);
					if (hasTag(blockOf(state), "wall_hanging_signs")) return axisOf(propertiesOf(state).facing as Direction) === axisOf(facing);
					return isFaceSturdy(state, OPPOSITE[side]);
				};
				return { def: wall, set: { facing }, check: () => holds(clockwise(facing)) || holds(counterClockwise(facing)) };
			});
	}
	if (wall.type.includes("wall_skull") || wall.type.includes("wall_head")) {
		// A head goes on the first side with anything there.
		const side = horizontal.find((direction) => {
			const next = offset(c.at, direction);
			return !isReplaceable(c.p.getBlock(next.x, next.y, next.z));
		});
		return side ? [{ def: wall, set: { facing: OPPOSITE[side] } }] : [];
	}
	return horizontal.map((direction) => ({ def: wall, set: { facing: OPPOSITE[direction] } }));
}

/**
 * A hanging sign under a block. It is "attached" (hangs from one chain in the
 * middle, and turns freely) unless the block above has a full bottom or is
 * another hanging sign it lines up with, and always when sneaking.
 */
function ceilingHangingSign(def: BlockDef, c: PlaceContext): Candidate {
	const aboveAt = offset(c.at, "up");
	const above = c.p.getBlock(aboveAt.x, aboveAt.y, aboveAt.z);
	const direction = horizontalFacing(c.p.yaw);
	let attached = !collisionBottomFull(above) || c.p.sneaking === true;
	if (hasTag(blockOf(above), "all_hanging_signs") && !c.p.sneaking) {
		const properties = propertiesOf(above);
		const aboveFacing = properties.facing ?? (properties.rotation !== undefined && Number(properties.rotation) % 4 === 0 ? ROTATION_FACING[Number(properties.rotation) / 4] : undefined);
		if (aboveFacing !== undefined && axisOf(aboveFacing as Direction) === axisOf(direction)) attached = false;
	}
	const rotation = attached ? rotationSegment(c.p.yaw + 180) : rotationSegment(DIRECTION_YAW[OPPOSITE[direction]]);
	return { def, set: { attached: String(attached), rotation } };
}

/** The direction each multiple of four rotation segments faces, and the yaw of each direction. */
const ROTATION_FACING: Direction[] = ["south", "west", "north", "east"];
const DIRECTION_YAW: Record<Direction, number> = { south: 0, west: 90, north: 180, east: 270, up: 0, down: 0 };

/** A bell on the floor or ceiling, or on the wall that was clicked: between two walls when there is one on each side. */
function bellCandidates(def: BlockDef, c: PlaceContext): Candidate[] {
	const face = c.p.face;
	if (!isHorizontal(face)) return [{ def, set: { attachment: face === "down" ? "ceiling" : "floor", facing: c.looking } }];
	const sturdyToward = (side: Direction) => {
		const next = offset(c.at, side);
		return isFaceSturdy(c.p.getBlock(next.x, next.y, next.z), OPPOSITE[side]);
	};
	const between = sturdyToward(face) && sturdyToward(OPPOSITE[face]);
	const facing = OPPOSITE[face];
	const belowAt = offset(c.at, "down");
	const onFloor = isFaceSturdy(c.p.getBlock(belowAt.x, belowAt.y, belowAt.z), "up");
	return [
		{ def, set: { facing, attachment: between ? "double_wall" : "single_wall" } },
		{ def, set: { facing, attachment: onFloor ? "floor" : "ceiling" } },
	];
}

/** A vine grows a face towards the first side, nearest to where the player looks, that holds it. */
function vineCandidate(def: BlockDef, c: PlaceContext): Candidate[] {
	const base = blockOf(c.existing) === def ? propertiesOf(c.existing) : {};
	for (const direction of c.directions) {
		if (direction === "down" || base[direction] === "true") continue;
		if (vineCanAttach(c.p.getBlock, c.at, direction)) return [{ def, set: { ...base, [direction]: "true" } }];
	}
	return [];
}

/** Glow lichen and the like: a new face on the first side, nearest to where the player looks, with something to cling to. */
function multifaceCandidates(def: BlockDef, c: PlaceContext): Candidate[] {
	const base = blockOf(c.existing) === def ? propertiesOf(c.existing) : {};
	return c.directions
		.filter((direction) => hasProperty(def, direction) && base[direction] !== "true" && multifaceCanAttach(c.p.getBlock, c.at, direction))
		.map((direction) => ({ def, set: { ...base, [direction]: "true" } }));
}

/** Whether a vine or glow lichen with this item in hand takes the click into its own space, to grow another face. */
function growsAnotherFace(state: number, def: BlockDef): boolean {
	if (blockOf(state) !== def || !MULTIFACE.has(def.type)) return false;
	const properties = propertiesOf(state);
	return def.properties.some((property) => (DIRECTIONS as string[]).includes(property.name) && properties[property.name] === "false");
}

/** The state of a candidate, with what every placement sets: axis, half, rotation, facing and so on. */
function finish(candidate: Candidate, c: PlaceContext): number {
	const { def } = candidate;
	const { p, looking } = c;
	const sideways = isHorizontal(p.face);
	const upperHalf = p.face === "down" || (sideways && p.cursor.y > 0.5);
	const set: Properties = {};

	if (hasProperty(def, "axis")) set.axis = axisOf(p.face);
	if (hasProperty(def, "rotation")) set.rotation = rotationSegment(def.type.includes("skull") || def.type.includes("head") ? p.yaw : p.yaw + 180);
	if (hasProperty(def, "half", "top")) set.half = upperHalf ? "top" : "bottom";
	if (hasProperty(def, "type", "double")) set.type = upperHalf ? "top" : "bottom";
	if (hasProperty(def, "persistent")) set.persistent = "true"; // placed leaves never decay
	if (hasProperty(def, "shape", "north_south")) set.shape = axisOf(looking) === "x" ? "east_west" : "north_south"; // rails

	if (candidate.set.facing === undefined && hasProperty(def, "facing")) {
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
	Object.assign(set, candidate.set);

	if (hasProperty(def, "hinge")) set.hinge = doorHinge(p, c.at, set.facing as Direction);
	if (hasProperty(def, "waterlogged") && candidate.set.waterlogged === undefined) set.waterlogged = String(hasWaterSource(c.existing));
	return stateOf(def, set);
}

/**
 * Every block change that placing this item causes, or nothing when it cannot
 * be placed there. Doors, beds and tall plants are two blocks.
 */
export function place(p: Placement): BlockChange[] | undefined {
	const def = blockForItem(p.item);
	if (!def) return undefined;
	const get = (at: Position) => p.getBlock(at.x, at.y, at.z);

	const clickedState = get(p.clicked);
	if (blockOf(clickedState) === def) {
		const stacked = stackOnto(clickedState, def, p);
		if (stacked !== undefined) return [{ ...p.clicked, state: stacked }];
	}

	const replacingClicked = isReplaceable(clickedState) || growsAnotherFace(clickedState, def);
	const at = replacingClicked ? p.clicked : offset(p.clicked, p.face);
	if (at.y < p.minY || at.y > p.maxY) return undefined;
	const existing = get(at);
	if (!replacingClicked && blockOf(existing) === def) {
		const stacked = stackOnto(existing, def);
		if (stacked !== undefined) return [{ ...at, state: stacked }];
	}
	if (!isReplaceable(existing) && !growsAnotherFace(existing, def)) return undefined;
	if (needsWaterToPlace(def, existing)) return undefined;

	const c: PlaceContext = { p, at, existing, replacingClicked, directions: nearestLookingDirections(p.yaw, p.pitch, p.face, replacingClicked), looking: horizontalFacing(p.yaw) };
	for (const candidate of candidates(def, c)) {
		const state = finish(candidate, c);
		// BlockItem.canPlace: the block has to be able to stay there.
		if (!canSurvive(p.getBlock, at, state) || (candidate.check && !candidate.check(state))) continue;
		const placed = blockOf(state);
		const changes: BlockChange[] = [{ ...at, state }];
		let second: BlockChange | undefined;
		const properties = propertiesOf(state);
		if (hasProperty(placed, "half", "upper")) {
			changes[0]!.state = withProperties(state, { half: "lower" });
			second = { ...offset(at, "up"), state: withProperties(state, { half: "upper" }) };
		} else if (hasProperty(placed, "part", "head")) {
			changes[0]!.state = withProperties(state, { part: "foot" });
			second = { ...offset(at, properties.facing as Direction), state: withProperties(state, { part: "head" }) };
		}
		if (second) {
			if (second.y > p.maxY || !isReplaceable(get(second))) return undefined;
			changes.push(second);
		}
		return changes;
	}
	return undefined;
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
 * walls connect, stairs form corners, fence gates sink into walls, vines keep
 * only the faces that still hold. Returns the
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
	// Vines and glow lichen let go of the faces that lost their hold; with none
	// left they fall off (survival.ts).
	return updatedMultiface(getBlock, at, updatedVine(getBlock, at, state));
}

// ---- support -------------------------------------------------------------------

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
 * Blocks around `at` that can no longer stay where they are now that `at`
 * changed: the torch on its side, the flower on top, the lantern hanging
 * below, a cactus that something was put next to. The same rule decides
 * whether a block may be placed (survival.ts), so a block that could not have
 * been put somewhere does not stay there either. A block saved somewhere it
 * could not be placed stays until something next to it changes.
 */
export function unsupportedAround(getBlock: GetBlock, at: Position): Position[] {
	const out: Position[] = [];
	for (const direction of ["up", "down", ...HORIZONTAL] as Direction[]) {
		const neighbour = offset(at, direction);
		const state = getBlock(neighbour.x, neighbour.y, neighbour.z);
		if (state !== AIR && !canSurvive(getBlock, neighbour, state)) out.push(neighbour);
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
