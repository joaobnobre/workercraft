// Items lying in the world. The game client animates a dropped item by
// itself, so the server only has to agree with it on where the item ends up:
// it runs the same simple physics and tells clients the final resting place.

export interface DroppedItem {
	entityId: number;
	uuid: Uint8Array;
	item: number;
	count: number;
	x: number;
	y: number;
	z: number;
	vx: number;
	vy: number;
	vz: number;
	/** Ticks since it was dropped. */
	age: number;
	/** Ticks until it can be picked up. */
	pickupDelay: number;
	/** Lying still. Skipped by physics until the block under it goes away. */
	resting: boolean;
}

export const ITEM_LIFETIME_TICKS = 5 * 60 * 20;
export const PICKUP_DELAY_TICKS = 40;

// An item is a quarter-block cube. These are vanilla's item physics constants.
const HALF_WIDTH = 0.125;
const HEIGHT = 0.25;
const GRAVITY = 0.04;
const AIR_DRAG = 0.98;
const GROUND_FRICTION = 0.6 * 0.98;
const REST_SPEED_SQUARED = 1e-5;
const EPSILON = 1e-7;

type Solid = (x: number, y: number, z: number) => boolean;

/** Whether any block touching the item's footprint is solid in this layer. */
function solidInLayer(solid: Solid, x: number, layer: number, z: number): boolean {
	const x0 = Math.floor(x - HALF_WIDTH);
	const x1 = Math.floor(x + HALF_WIDTH);
	const z0 = Math.floor(z - HALF_WIDTH);
	const z1 = Math.floor(z + HALF_WIDTH);
	return solid(x0, layer, z0) || solid(x1, layer, z0) || solid(x0, layer, z1) || solid(x1, layer, z1);
}

/** Whether a block at this x (or z, when `alongX` is false) blocks the item's body. */
function solidInColumn(solid: Solid, item: DroppedItem, block: number, alongX: boolean): boolean {
	const y0 = Math.floor(item.y + EPSILON);
	const y1 = Math.floor(item.y + HEIGHT - EPSILON);
	const side = alongX ? item.z : item.x;
	const s0 = Math.floor(side - HALF_WIDTH);
	const s1 = Math.floor(side + HALF_WIDTH);
	for (let y = y0; y <= y1; y++) {
		for (const s of s0 === s1 ? [s0] : [s0, s1]) {
			if (alongX ? solid(block, y, s) : solid(s, y, block)) return true;
		}
	}
	return false;
}

/**
 * Advances an item by one tick (1/20 s). Returns true on the tick it comes to
 * rest, which is when clients should be told its exact position.
 */
export function stepItem(item: DroppedItem, solid: Solid): boolean {
	item.age++;
	if (item.pickupDelay > 0) item.pickupDelay--;

	const floorLayer = () => Math.floor(item.y + EPSILON) - 1;
	if (item.resting) {
		if (item.age % 4 !== 0 || solidInLayer(solid, item.x, floorLayer(), item.z)) return false;
		item.resting = false; // the block it was lying on is gone
	}

	item.vy -= GRAVITY;

	// Down or up first, so the sideways checks use the final height.
	let onGround = false;
	let y = item.y + item.vy;
	if (item.vy < 0) {
		for (let layer = floorLayer(); layer + 1 >= y - EPSILON; layer--) {
			if (solidInLayer(solid, item.x, layer, item.z)) {
				y = layer + 1;
				item.vy = 0;
				onGround = true;
				break;
			}
		}
	} else if (item.vy > 0) {
		const layer = Math.floor(y + HEIGHT);
		if (layer > Math.floor(item.y + HEIGHT - EPSILON) && solidInLayer(solid, item.x, layer, item.z)) {
			y = layer - HEIGHT;
			item.vy = 0;
		}
	}
	item.y = y;

	for (const alongX of [true, false]) {
		const velocity = alongX ? item.vx : item.vz;
		if (velocity === 0) continue;
		const direction = Math.sign(velocity);
		const from = alongX ? item.x : item.z;
		let to = from + velocity;
		const block = Math.floor(to + direction * HALF_WIDTH);
		if (block !== Math.floor(from + direction * (HALF_WIDTH - EPSILON)) && solidInColumn(solid, item, block, alongX)) {
			to = direction > 0 ? block - HALF_WIDTH : block + 1 + HALF_WIDTH; // stop flush against the block
			if (alongX) item.vx = 0;
			else item.vz = 0;
		}
		if (alongX) item.x = to;
		else item.z = to;
	}

	const friction = onGround ? GROUND_FRICTION : AIR_DRAG;
	item.vx *= friction;
	item.vy *= AIR_DRAG;
	item.vz *= friction;

	if (onGround && item.vx * item.vx + item.vz * item.vz < REST_SPEED_SQUARED) {
		item.vx = item.vy = item.vz = 0;
		item.resting = true;
		return true;
	}
	return false;
}

/** Vanilla's pickup range: the player's body grown by a block sideways and half a block up and down. */
export function canPickUp(item: DroppedItem, player: { x: number; y: number; z: number }): boolean {
	const reach = 0.3 + 1 + HALF_WIDTH;
	return (
		Math.abs(item.x - player.x) < reach &&
		Math.abs(item.z - player.z) < reach &&
		item.y + HEIGHT > player.y - 0.5 &&
		item.y < player.y + 1.8 + 0.5
	);
}

/** Speed and direction of an item thrown by a player looking this way. */
export function throwVelocity(yawDegrees: number, pitchDegrees: number): { vx: number; vy: number; vz: number } {
	const yaw = (yawDegrees * Math.PI) / 180;
	const pitch = (pitchDegrees * Math.PI) / 180;
	const wobbleAngle = Math.random() * 2 * Math.PI;
	const wobble = 0.02 * Math.random();
	return {
		vx: -Math.sin(yaw) * Math.cos(pitch) * 0.3 + Math.cos(wobbleAngle) * wobble,
		vy: -Math.sin(pitch) * 0.3 + 0.1 + (Math.random() - Math.random()) * 0.1,
		vz: Math.cos(yaw) * Math.cos(pitch) * 0.3 + Math.sin(wobbleAngle) * wobble,
	};
}
