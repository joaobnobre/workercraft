// Chunk storage and the chunk packet.
//
// The world is an endless flat plain, so an untouched chunk needs no memory
// and no storage: only the blocks players changed are kept, one SQLite row
// each. A chunk is rebuilt from "flat ground + its changed blocks" on demand.
//
// State ids change with every game version, so a row does not hold one. It
// points into the world's own palette table, which spells each state out
// ("oak_stairs[facing=north,...]"). A world therefore survives the server
// moving to another version.

import { packet, Writer } from "../net/bytes";
import { writeNbt, type Nbt } from "../net/nbt";
import { AIR, BEFORE_26_3, BIOME_ID, C, DIRECT_BLOCK_BITS, blockState } from "../protocol/version";
import { blockEntityTypeOf, blockOf, stateFromName, stateName } from "./blockstates";

export const MIN_Y = -64;
export const WORLD_HEIGHT = 384;
export const MAX_Y = MIN_Y + WORLD_HEIGHT - 1;
const SECTION_COUNT = WORLD_HEIGHT / 16;
const SECTION_VOLUME = 4096;

/** Top of the flat ground. Players stand on y = GROUND_Y + 1. */
export const GROUND_Y = -61;

function requireBlock(name: string): number {
	const state = blockState(name);
	if (state === undefined) throw new Error(`Block ${name} is missing from the generated data`);
	return state;
}

const BEDROCK = requireBlock("bedrock");
const DIRT = requireBlock("dirt");
const GRASS = requireBlock("grass_block");

/** The block at this position before anyone touched the world. */
export function naturalBlock(y: number): number {
	if (y > GROUND_Y || y < MIN_Y) return AIR;
	if (y === GROUND_Y) return GRASS;
	return y === MIN_Y ? BEDROCK : DIRT;
}

/** Bottom section of every untouched chunk. Shared, never written to. */
const NATURAL_BOTTOM = new Uint16Array(SECTION_VOLUME);
for (let y = 0; y < 16; y++) NATURAL_BOTTOM.fill(naturalBlock(MIN_Y + y), y << 8, (y + 1) << 8);

type Sections = (Uint16Array | undefined)[];

export function chunkKey(cx: number, cz: number): number {
	return (cx + 0x200000) * 0x400000 + (cz + 0x200000);
}

/** Position of a block inside its chunk column. */
function columnIndex(x: number, y: number, z: number): number {
	return ((y - MIN_Y) << 8) | ((z & 15) << 4) | (x & 15);
}

// ---- encoding --------------------------------------------------------------

/** Packs values into 64-bit words, low bits first, never splitting a value across words. */
function writePacked(w: Writer, values: ArrayLike<number>, bits: number): void {
	const perWord = Math.floor(64 / bits);
	for (let start = 0; start < values.length; start += perWord) {
		let lo = 0;
		let hi = 0;
		const end = Math.min(start + perWord, values.length);
		for (let i = start; i < end; i++) {
			const value = values[i]!;
			const shift = (i - start) * bits;
			if (shift >= 32) {
				hi |= value << (shift - 32);
			} else {
				lo |= value << shift;
				if (shift + bits > 32) hi |= value >>> (32 - shift);
			}
		}
		w.u32(hi >>> 0).u32(lo >>> 0);
	}
}

function writeSection(w: Writer, blocks: Uint16Array | undefined): void {
	if (!blocks) {
		w.i16(0).i16(0); // no blocks, no fluids
		w.u8(0).varint(AIR); // one block state for the whole section
	} else {
		const palette: number[] = [];
		const paletteIndex = new Map<number, number>();
		let solid = 0;
		for (let i = 0; i < SECTION_VOLUME; i++) {
			const state = blocks[i]!;
			if (state !== AIR) solid++;
			if (!paletteIndex.has(state)) {
				paletteIndex.set(state, palette.length);
				palette.push(state);
			}
		}
		w.i16(solid).i16(0);
		if (palette.length === 1) {
			w.u8(0).varint(palette[0]!);
		} else if (palette.length <= 256) {
			const bits = Math.max(4, Math.ceil(Math.log2(palette.length)));
			w.u8(bits).varint(palette.length);
			for (const state of palette) w.varint(state);
			const indices = new Uint16Array(SECTION_VOLUME);
			for (let i = 0; i < SECTION_VOLUME; i++) indices[i] = paletteIndex.get(blocks[i]!)!;
			writePacked(w, indices, bits);
		} else {
			w.u8(DIRECT_BLOCK_BITS);
			writePacked(w, blocks, DIRECT_BLOCK_BITS);
		}
	}
	w.u8(0).varint(BIOME_ID); // one biome for the whole section
}

const HEIGHTMAP_WORLD_SURFACE = 1;
const HEIGHTMAP_MOTION_BLOCKING = 4;
const HEIGHTMAP_BITS = Math.ceil(Math.log2(WORLD_HEIGHT + 1));
const SKY_LIGHT_FULL = new Uint8Array(2048).fill(0xff);

/** Block entity data (a sign's text, say) by position inside the chunk column. */
type BlockData = Map<number, Nbt>;

/** Everything in the chunk packet after the chunk coordinates. */
function encodeChunkBody(sections: Sections, blockData?: BlockData): Uint8Array {
	const heights = new Uint16Array(256);
	let topSection = -1;
	// Chests, signs, beds and the like are drawn from their block entity, and
	// the client only creates the ones the chunk packet lists.
	const blockEntities = new Writer(16);
	let blockEntityCount = 0;
	sections.forEach((blocks, section) => {
		if (!blocks) return;
		for (let i = 0; i < SECTION_VOLUME; i++) {
			const state = blocks[i]!;
			if (state === AIR) continue;
			topSection = section;
			const height = (section << 4) + (i >> 8) + 1;
			if (height > heights[i & 255]!) heights[i & 255] = height;
			const type = blockEntityTypeOf(state);
			if (type < 0) continue;
			blockEntityCount++;
			// x and z share a byte, x in the high half.
			blockEntities.u8(((i & 15) << 4) | ((i >> 4) & 15)).i16(MIN_Y + height - 1).varint(type);
			writeNbt(blockEntities, blockData?.get((section << 12) | i) ?? {});
		}
	});

	const sectionData = new Writer(256);
	for (const blocks of sections) writeSection(sectionData, blocks);

	const w = new Writer(sectionData.length + blockEntities.length + 16 * 1024);
	w.varint(2);
	for (const type of [HEIGHTMAP_WORLD_SURFACE, HEIGHTMAP_MOTION_BLOCKING]) {
		w.varint(type).varint(Math.ceil(256 / Math.floor(64 / HEIGHTMAP_BITS)));
		writePacked(w, heights, HEIGHTMAP_BITS);
	}
	w.varint(sectionData.length).bytes(sectionData.peek());
	w.varint(blockEntityCount).bytes(blockEntities.peek());

	// Light. The server has no lighting engine, so every section that holds
	// blocks (and the one above it) is sent fully sky-lit. The client relights
	// around blocks it sees change.
	const litSections = Math.min(topSection + 2, SECTION_COUNT);
	let skyMask = 0;
	for (let section = 0; section < litSections; section++) skyMask |= 1 << (section + 1); // bit 0 is below the world
	// Which sections have sky light: a bit set, sent as 64-bit words until
	// 26.3 and as its bytes, lowest first and without trailing zeros, since.
	if (BEFORE_26_3) {
		w.varint(1).u32(0).u32(skyMask >>> 0);
	} else {
		const bytes = [skyMask & 0xff, (skyMask >>> 8) & 0xff, (skyMask >>> 16) & 0xff, skyMask >>> 24];
		while (bytes.length > 0 && bytes.at(-1) === 0) bytes.pop();
		w.varint(bytes.length).bytes(Uint8Array.from(bytes));
	}
	w.varint(0).varint(0).varint(0); // block light, empty sky light, empty block light
	w.varint(litSections);
	for (let section = 0; section < litSections; section++) w.varint(SKY_LIGHT_FULL.length).bytes(SKY_LIGHT_FULL);
	w.varint(0); // no block light arrays
	return w.finish();
}

function chunkPacket(cx: number, cz: number, body: Uint8Array): Uint8Array {
	return packet(C.play.levelChunk, (w) => w.i32(cx).i32(cz).bytes(body));
}

const naturalSections: Sections = new Array(SECTION_COUNT).fill(undefined);
naturalSections[0] = NATURAL_BOTTOM;
let naturalBody: Uint8Array | undefined;

// ---- storage ---------------------------------------------------------------

interface LoadedChunk {
	sections: Sections;
	/** Sections this chunk has its own copy of; the rest are shared natural ones. */
	owned: Set<number>;
	data: BlockData;
	body?: Uint8Array;
}

/** How many edited chunks stay decoded in memory. Each costs a few tens of KB. */
const MAX_LOADED_CHUNKS = 512;
/**
 * Block changes are written to storage in one transaction at most this often.
 * A Durable Object holds back everything it sends until its writes are safely
 * stored, so one write per block would freeze the whole world while a plugin
 * builds something large.
 */
const FLUSH_INTERVAL_MS = 1000;

export class BlockStore {
	/** Chunks that have at least one changed block. Everything else is natural. */
	private edited = new Set<number>();
	private loaded = new Map<number, LoadedChunk>();
	/** Changes not written to storage yet, by "cx,cz,idx". */
	private unsaved = new Map<string, { cx: number; cz: number; index: number; state: number; natural: boolean }>();
	/** Block entity data not written to storage yet. Undefined means "delete". */
	private unsavedData = new Map<string, { cx: number; cz: number; index: number; data: Nbt | undefined }>();
	private flushTimer?: ReturnType<typeof setTimeout>;
	/** Palette row to this version's state id, and back. */
	private paletteStates = new Map<number, number>();
	private paletteIds = new Map<number, number>();

	constructor(private storage: DurableObjectStorage) {
		storage.sql.exec(
			`CREATE TABLE IF NOT EXISTS blocks (
				cx INTEGER NOT NULL, cz INTEGER NOT NULL, idx INTEGER NOT NULL, state INTEGER NOT NULL,
				PRIMARY KEY (cx, cz, idx)
			) WITHOUT ROWID`,
		);
		storage.sql.exec(
			`CREATE TABLE IF NOT EXISTS block_data (
				cx INTEGER NOT NULL, cz INTEGER NOT NULL, idx INTEGER NOT NULL, data TEXT NOT NULL,
				PRIMARY KEY (cx, cz, idx)
			) WITHOUT ROWID`,
		);
		storage.sql.exec("CREATE TABLE IF NOT EXISTS palette (id INTEGER PRIMARY KEY, state TEXT NOT NULL UNIQUE)");
		for (const row of storage.sql.exec<{ id: number; state: string }>("SELECT id, state FROM palette")) {
			// A block this version does not have shows as air. Its rows stay as they
			// are, so it is back when the server returns to a version that has it.
			const state = stateFromName(row.state);
			this.paletteStates.set(row.id, state ?? AIR);
			if (state !== undefined && !this.paletteIds.has(state)) this.paletteIds.set(state, row.id);
		}
		for (const row of storage.sql.exec<{ cx: number; cz: number }>("SELECT DISTINCT cx, cz FROM blocks")) {
			this.edited.add(chunkKey(row.cx, row.cz));
		}
	}

	/** The palette row for a state, added on first use. */
	private paletteId(state: number): number {
		let id = this.paletteIds.get(state);
		if (id === undefined) {
			const name = stateName(state);
			this.storage.sql.exec("INSERT OR IGNORE INTO palette (state) VALUES (?)", name);
			id = this.storage.sql.exec<{ id: number }>("SELECT id FROM palette WHERE state = ?", name).one().id;
			this.paletteIds.set(state, id);
			this.paletteStates.set(id, state);
		}
		return id;
	}

	get editedChunkCount(): number {
		return this.edited.size;
	}

	private load(cx: number, cz: number): LoadedChunk | undefined {
		const key = chunkKey(cx, cz);
		if (!this.edited.has(key)) return undefined;
		let chunk = this.loaded.get(key);
		if (chunk) {
			// Re-insert so the map's order is least recently used first.
			this.loaded.delete(key);
			this.loaded.set(key, chunk);
			return chunk;
		}
		this.flush(); // storage must be current before a chunk is rebuilt from it
		chunk = { sections: [...naturalSections], owned: new Set(), data: new Map() };
		for (const row of this.storage.sql.exec<{ idx: number; state: number }>("SELECT idx, state FROM blocks WHERE cx = ? AND cz = ?", cx, cz)) {
			writeBlock(chunk, row.idx, this.paletteStates.get(row.state) ?? AIR);
		}
		for (const row of this.storage.sql.exec<{ idx: number; data: string }>("SELECT idx, data FROM block_data WHERE cx = ? AND cz = ?", cx, cz)) {
			chunk.data.set(row.idx, JSON.parse(row.data) as Nbt);
		}
		this.loaded.set(key, chunk);
		if (this.loaded.size > MAX_LOADED_CHUNKS) this.loaded.delete(this.loaded.keys().next().value!);
		return chunk;
	}

	getBlock(x: number, y: number, z: number): number {
		if (y < MIN_Y || y > MAX_Y) return AIR;
		const chunk = this.load(x >> 4, z >> 4);
		if (!chunk) return naturalBlock(y);
		const index = columnIndex(x, y, z);
		return chunk.sections[index >> 12]?.[index & 0xfff] ?? AIR;
	}

	/** Returns false when the position is outside the world or nothing changed. */
	setBlock(x: number, y: number, z: number, state: number): boolean {
		if (y < MIN_Y || y > MAX_Y) return false;
		const previous = this.getBlock(x, y, z);
		if (previous === state) return false;
		const cx = x >> 4;
		const cz = z >> 4;
		const index = columnIndex(x, y, z);
		this.edited.add(chunkKey(cx, cz));
		const chunk = this.load(cx, cz)!;
		writeBlock(chunk, index, state);
		chunk.body = undefined;
		const key = `${cx},${cz},${index}`;
		this.unsaved.set(key, { cx, cz, index, state, natural: state === naturalBlock(y) });
		// A sign's text goes when the sign does, but stays when the sign only changes state.
		if (chunk.data.has(index) && blockOf(previous) !== blockOf(state)) {
			chunk.data.delete(index);
			this.unsavedData.set(key, { cx, cz, index, data: undefined });
		}
		this.flushTimer ??= setTimeout(() => this.flush(), FLUSH_INTERVAL_MS);
		return true;
	}

	/** The block entity data stored for this position, if any. */
	getBlockData(x: number, y: number, z: number): Nbt | undefined {
		if (y < MIN_Y || y > MAX_Y) return undefined;
		return this.load(x >> 4, z >> 4)?.data.get(columnIndex(x, y, z));
	}

	/** Stores block entity data for a block that was already placed. */
	setBlockData(x: number, y: number, z: number, data: Nbt): void {
		const cx = x >> 4;
		const cz = z >> 4;
		const chunk = y < MIN_Y || y > MAX_Y ? undefined : this.load(cx, cz);
		if (!chunk) return; // an untouched chunk has no block that could carry data
		const index = columnIndex(x, y, z);
		chunk.data.set(index, data);
		chunk.body = undefined;
		this.unsavedData.set(`${cx},${cz},${index}`, { cx, cz, index, data });
		this.flushTimer ??= setTimeout(() => this.flush(), FLUSH_INTERVAL_MS);
	}

	/** Writes every pending block change to storage, as one transaction. */
	flush(): void {
		if (this.flushTimer !== undefined) clearTimeout(this.flushTimer);
		this.flushTimer = undefined;
		if (this.unsaved.size === 0 && this.unsavedData.size === 0) return;
		const changes = [...this.unsaved.values()];
		const dataChanges = [...this.unsavedData.values()];
		this.unsaved.clear();
		this.unsavedData.clear();
		this.storage.transactionSync(() => {
			for (const { cx, cz, index, data } of dataChanges) {
				if (data === undefined) this.storage.sql.exec("DELETE FROM block_data WHERE cx = ? AND cz = ? AND idx = ?", cx, cz, index);
				else this.storage.sql.exec("INSERT OR REPLACE INTO block_data (cx, cz, idx, data) VALUES (?, ?, ?, ?)", cx, cz, index, JSON.stringify(data));
			}
			for (const { cx, cz, index, state, natural } of changes) {
				// A block put back the way nature made it needs no row.
				if (natural) this.storage.sql.exec("DELETE FROM blocks WHERE cx = ? AND cz = ? AND idx = ?", cx, cz, index);
				else this.storage.sql.exec("INSERT OR REPLACE INTO blocks (cx, cz, idx, state) VALUES (?, ?, ?, ?)", cx, cz, index, this.paletteId(state));
			}
		});
	}

	/** The full chunk packet, ready to send. */
	chunkPacket(cx: number, cz: number): Uint8Array {
		const chunk = this.load(cx, cz);
		if (!chunk) return chunkPacket(cx, cz, (naturalBody ??= encodeChunkBody(naturalSections)));
		return chunkPacket(cx, cz, (chunk.body ??= encodeChunkBody(chunk.sections, chunk.data)));
	}
}

/** Writes one block into a chunk, copying a shared section before its first change. */
function writeBlock(chunk: LoadedChunk, index: number, state: number): void {
	const section = index >> 12;
	if (section < 0 || section >= SECTION_COUNT) return;
	let blocks = chunk.sections[section];
	if (!chunk.owned.has(section)) {
		blocks = blocks ? blocks.slice() : new Uint16Array(SECTION_VOLUME);
		chunk.sections[section] = blocks;
		chunk.owned.add(section);
	}
	blocks![index & 0xfff] = state;
}
