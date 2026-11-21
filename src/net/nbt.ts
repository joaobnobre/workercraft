// Just enough NBT to write chat text and registry data. The network form has
// no name on the root tag.

import type { Writer } from "./bytes";

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

/** A chat text component. A plain string is the simplest valid one. */
export type Text = string | { text?: string; translate?: string; with?: Text[]; color?: string; bold?: boolean; italic?: boolean; extra?: Text[] };
