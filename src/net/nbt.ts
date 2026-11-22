// Just enough NBT to write chat text and registry data, and to read text that
// comes from a client. The network form has no name on the root tag.

import { ProtocolError, type Reader, type Writer } from "./bytes";

export type Nbt = string | number | boolean | Nbt[] | { [key: string]: Nbt };

const BYTE = 1;
const INT = 3;
const LONG = 4;
const DOUBLE = 6;
const STRING = 8;
const LIST = 9;
const COMPOUND = 10;

function tagType(value: Nbt): number {
	if (typeof value === "string") return STRING;
	if (typeof value === "boolean") return BYTE;
	if (typeof value === "number") {
		if (!Number.isInteger(value)) return DOUBLE;
		return value >= -0x80000000 && value <= 0x7fffffff ? INT : LONG;
	}
	return Array.isArray(value) ? LIST : COMPOUND;
}

/** Java's "modified UTF-8": UTF-16 units encoded one by one, and NUL as two bytes. */
function writeJavaString(w: Writer, s: string): void {
	const bytes: number[] = [];
	for (let i = 0; i < s.length; i++) {
		const c = s.charCodeAt(i);
		if (c !== 0 && c < 0x80) bytes.push(c);
		else if (c < 0x800) bytes.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
		else bytes.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
	}
	if (bytes.length > 0xffff) throw new Error("NBT string is too long");
	w.u16(bytes.length).bytes(Uint8Array.from(bytes));
}

function writePayload(w: Writer, value: Nbt, type: number): void {
	switch (type) {
		case BYTE:
			w.i8(typeof value === "boolean" ? (value ? 1 : 0) : (value as number));
			return;
		case INT:
			w.i32(value as number);
			return;
		case LONG:
			w.i64(value as number);
			return;
		case DOUBLE:
			w.f64(value as number);
			return;
		case STRING:
			writeJavaString(w, value as string);
			return;
		case LIST: {
			const list = value as Nbt[];
			if (list.length === 0) {
				w.u8(0).i32(0);
				return;
			}
			const types = new Set(list.map(tagType));
			let elementType: number;
			let elements = list;
			if (types.size === 1) {
				elementType = [...types][0]!;
			} else if ([...types].every((t) => t === INT || t === LONG || t === DOUBLE)) {
				elementType = types.has(DOUBLE) ? DOUBLE : LONG;
			} else {
				// A list holds one tag type, so mixed lists wrap each element in a compound.
				elementType = COMPOUND;
				elements = list.map((el) => (tagType(el) === COMPOUND ? el : { "": el }));
			}
			w.u8(elementType).i32(elements.length);
			for (const el of elements) writePayload(w, el, elementType);
			return;
		}
		case COMPOUND:
			for (const [key, child] of Object.entries(value as { [key: string]: Nbt })) {
				if (child === undefined || child === null) continue; // an optional field left unset
				const childType = tagType(child);
				w.u8(childType);
				writeJavaString(w, key);
				writePayload(w, child, childType);
			}
			w.u8(0);
			return;
	}
}

export function writeNbt(w: Writer, value: Nbt): void {
	const type = tagType(value);
	w.u8(type);
	writePayload(w, value, type);
}

// ---- reading ----------------------------------------------------------------
//
// For NBT that comes from a client, so everything is checked: a tag the game
// would refuse throws, and so does anything nested deeper than `maxDepth`.

/** A tag as read. Numbers lose which numeric type they were; arrays keep theirs. */
export type ReadTag = string | number | bigint | ReadTag[] | Map<string, ReadTag> | Int8Array | Int32Array | BigInt64Array;

const END = 0;
const SHORT = 2;
const FLOAT = 5;
const BYTE_ARRAY = 7;
const INT_ARRAY = 11;
const LONG_ARRAY = 12;

/** Reads Java's "modified UTF-8", refusing malformed bytes the way DataInput.readUTF does. */
function readJavaString(r: Reader): string {
	const bytes = r.bytes(r.u16());
	let out = "";
	for (let i = 0; i < bytes.length; ) {
		const a = bytes[i++]!;
		if (a < 0x80) out += String.fromCharCode(a);
		else if ((a & 0xe0) === 0xc0) {
			const b = bytes[i++];
			if (b === undefined || (b & 0xc0) !== 0x80) throw new ProtocolError("Malformed NBT string");
			out += String.fromCharCode(((a & 0x1f) << 6) | (b & 0x3f));
		} else if ((a & 0xf0) === 0xe0) {
			const b = bytes[i++];
			const c = bytes[i++];
			if (b === undefined || c === undefined || (b & 0xc0) !== 0x80 || (c & 0xc0) !== 0x80) throw new ProtocolError("Malformed NBT string");
			out += String.fromCharCode(((a & 0x0f) << 12) | ((b & 0x3f) << 6) | (c & 0x3f));
		} else throw new ProtocolError("Malformed NBT string");
	}
	return out;
}

function readPayload(r: Reader, type: number, depth: number): ReadTag {
	switch (type) {
		case BYTE:
			return r.i8();
		case SHORT:
			return r.i16();
		case INT:
			return r.i32();
		case LONG:
			return r.i64();
		case FLOAT:
			return r.f32();
		case DOUBLE:
			return r.f64();
		case STRING:
			return readJavaString(r);
		case BYTE_ARRAY:
			return Int8Array.from(r.bytes(arrayLength(r, 1)), (b) => (b << 24) >> 24);
		case INT_ARRAY: {
			const values = new Int32Array(arrayLength(r, 4));
			for (let i = 0; i < values.length; i++) values[i] = r.i32();
			return values;
		}
		case LONG_ARRAY: {
			const values = new BigInt64Array(arrayLength(r, 8));
			for (let i = 0; i < values.length; i++) values[i] = r.i64();
			return values;
		}
		case LIST: {
			if (depth <= 0) throw new ProtocolError("NBT is nested too deeply");
			const elementType = r.u8();
			const length = r.i32();
			if (length < 0 || length > r.remaining) throw new ProtocolError("Bad NBT list length");
			if (elementType === END && length > 0) throw new ProtocolError("NBT list without a type");
			const list: ReadTag[] = [];
			for (let i = 0; i < length; i++) list.push(readPayload(r, elementType, depth - 1));
			return list;
		}
		case COMPOUND: {
			if (depth <= 0) throw new ProtocolError("NBT is nested too deeply");
			const entries = new Map<string, ReadTag>();
			for (let child = r.u8(); child !== END; child = r.u8()) {
				const key = readJavaString(r);
				entries.set(key, readPayload(r, child, depth - 1));
			}
			return entries;
		}
		default:
			throw new ProtocolError(`Unknown NBT tag type ${type}`);
	}
}

function arrayLength(r: Reader, elementSize: number): number {
	const length = r.i32();
	if (length < 0 || length * elementSize > r.remaining) throw new ProtocolError("Bad NBT array length");
	return length;
}

/** Reads NBT in its network form: a type byte, then the payload with no name. */
export function readNbt(r: Reader, maxDepth: number): ReadTag {
	const type = r.u8();
	if (type === END) throw new ProtocolError("Empty NBT");
	return readPayload(r, type, maxDepth);
}

/** A chat text component. A plain string is the simplest valid one. */
export type Text = string | { text?: string; translate?: string; with?: Text[]; color?: string; bold?: boolean; italic?: boolean; extra?: Text[] };
