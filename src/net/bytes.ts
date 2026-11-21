// Minecraft's wire primitives: big-endian numbers, varints, length-prefixed
// UTF-8 strings and the packed block position.

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });

export class ProtocolError extends Error {}

export class Writer {
	private buf: Uint8Array;
	private view: DataView;
	length = 0;

	constructor(capacity = 64) {
		this.buf = new Uint8Array(capacity);
		this.view = new DataView(this.buf.buffer);
	}

	/**
	 * Makes room for n bytes and returns where they go. Growing replaces
	 * this.buf and this.view, so callers must call this before touching either.
	 */
	private reserve(n: number): number {
		const need = this.length + n;
		if (need > this.buf.length) {
			let size = this.buf.length * 2;
			while (size < need) size *= 2;
			const grown = new Uint8Array(size);
			grown.set(this.buf.subarray(0, this.length));
			this.buf = grown;
			this.view = new DataView(grown.buffer);
		}
		const at = this.length;
		this.length = need;
		return at;
	}

	u8(v: number): this {
		const at = this.reserve(1);
		this.view.setUint8(at, v);
		return this;
	}
	i8(v: number): this {
		const at = this.reserve(1);
		this.view.setInt8(at, v);
		return this;
	}
	bool(v: boolean): this {
		return this.u8(v ? 1 : 0);
	}
	i16(v: number): this {
		const at = this.reserve(2);
		this.view.setInt16(at, v);
		return this;
	}
	u16(v: number): this {
		const at = this.reserve(2);
		this.view.setUint16(at, v);
		return this;
	}
	i32(v: number): this {
		const at = this.reserve(4);
		this.view.setInt32(at, v);
		return this;
	}
	u32(v: number): this {
		const at = this.reserve(4);
		this.view.setUint32(at, v);
		return this;
	}
	i64(v: bigint | number): this {
		const at = this.reserve(8);
		this.view.setBigInt64(at, typeof v === "bigint" ? v : BigInt(Math.trunc(v)));
		return this;
	}
	f32(v: number): this {
		const at = this.reserve(4);
		this.view.setFloat32(at, v);
		return this;
	}
	f64(v: number): this {
		const at = this.reserve(8);
		this.view.setFloat64(at, v);
		return this;
	}
	varint(v: number): this {
		v >>>= 0;
		do {
			let byte = v & 0x7f;
			v >>>= 7;
			if (v !== 0) byte |= 0x80;
			this.u8(byte);
		} while (v !== 0);
		return this;
	}
	varlong(v: bigint | number): this {
		let n = BigInt.asUintN(64, BigInt(v));
		do {
			let byte = Number(n & 0x7fn);
			n >>= 7n;
			if (n !== 0n) byte |= 0x80;
			this.u8(byte);
		} while (n !== 0n);
		return this;
	}
	bytes(b: Uint8Array): this {
		const at = this.reserve(b.length);
		this.buf.set(b, at);
		return this;
	}
	string(s: string): this {
		const utf8 = encoder.encode(s);
		return this.varint(utf8.length).bytes(utf8);
	}
	/** Block position packed as x:26, z:26, y:12 bits. */
	position(x: number, y: number, z: number): this {
		const packed = ((BigInt(x) & 0x3ffffffn) << 38n) | ((BigInt(z) & 0x3ffffffn) << 12n) | (BigInt(y) & 0xfffn);
		const at = this.reserve(8);
		this.view.setBigUint64(at, packed);
		return this;
	}
	/** An angle as 1/256 of a full turn, the form entity packets use. */
	angle(degrees: number): this {
		return this.u8(Math.floor((degrees * 256) / 360) & 0xff);
	}

	finish(): Uint8Array {
		return this.buf.slice(0, this.length);
	}
	/** View of the written bytes, valid until the next write. */
	peek(): Uint8Array {
		return this.buf.subarray(0, this.length);
	}
}

export class Reader {
	private view: DataView;
	pos = 0;

	constructor(private buf: Uint8Array) {
		this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
	}

	get remaining(): number {
		return this.buf.length - this.pos;
	}

	private take(n: number): number {
		if (n < 0 || this.pos + n > this.buf.length) throw new ProtocolError("Packet ended early");
		const at = this.pos;
		this.pos += n;
		return at;
	}

	u8(): number {
		return this.view.getUint8(this.take(1));
	}
	i8(): number {
		return this.view.getInt8(this.take(1));
	}
	bool(): boolean {
		return this.u8() !== 0;
	}
	i16(): number {
		return this.view.getInt16(this.take(2));
	}
	u16(): number {
		return this.view.getUint16(this.take(2));
	}
	i32(): number {
		return this.view.getInt32(this.take(4));
	}
	i64(): bigint {
		return this.view.getBigInt64(this.take(8));
	}
	f32(): number {
		return this.view.getFloat32(this.take(4));
	}
	f64(): number {
		return this.view.getFloat64(this.take(8));
	}
	varint(): number {
		let value = 0;
		for (let shift = 0; shift < 35; shift += 7) {
			const byte = this.u8();
			value |= (byte & 0x7f) << shift;
			if ((byte & 0x80) === 0) return value;
		}
		throw new ProtocolError("Varint is too long");
	}
	bytes(n: number): Uint8Array {
		const at = this.take(n);
		return this.buf.subarray(at, at + n);
	}
	string(maxLength = 32767): string {
		const byteLength = this.varint();
		if (byteLength > maxLength * 4) throw new ProtocolError("String is too long");
		let value: string;
		try {
			value = decoder.decode(this.bytes(byteLength));
		} catch {
			throw new ProtocolError("String is not valid UTF-8");
		}
		if (value.length > maxLength) throw new ProtocolError("String is too long");
		return value;
	}
	position(): { x: number; y: number; z: number } {
		const packed = this.view.getBigUint64(this.take(8));
		return {
			x: Number(BigInt.asIntN(26, packed >> 38n)),
			z: Number(BigInt.asIntN(26, packed >> 12n)),
			y: Number(BigInt.asIntN(12, packed)),
		};
	}
}

/** Builds one framed packet: varint length, varint id, body. */
export function packet(id: number, body?: (w: Writer) => void): Uint8Array {
	const w = new Writer(body ? 128 : 8);
	w.varint(id);
	body?.(w);
	const payload = w.peek();
	return new Writer(payload.length + 5).varint(payload.length).bytes(payload).finish();
}

export function concat(parts: Uint8Array[]): Uint8Array {
	let total = 0;
	for (const part of parts) total += part.length;
	const out = new Uint8Array(total);
	let at = 0;
	for (const part of parts) {
		out.set(part, at);
		at += part.length;
	}
	return out;
}

/**
 * Splits a TCP byte stream back into packets. A packet can arrive in pieces,
 * and several packets can arrive in one chunk.
 */
export class Deframer {
	private pending: Uint8Array = new Uint8Array(0);

	constructor(private maxPacketLength = 2 << 20) {}

	push(chunk: Uint8Array): Uint8Array[] {
		const data = this.pending.length === 0 ? chunk : concat([this.pending, chunk]);
		const packets: Uint8Array[] = [];
		let at = 0;
		for (;;) {
			let length = 0;
			let shift = 0;
			let cursor = at;
			let complete = false;
			while (cursor < data.length) {
				const byte = data[cursor++]!;
				length |= (byte & 0x7f) << shift;
				if ((byte & 0x80) === 0) {
					complete = true;
					break;
				}
				shift += 7;
				if (shift > 21) throw new ProtocolError("Packet length prefix is too long");
			}
			if (!complete) break;
			if (length === 0 || length > this.maxPacketLength) throw new ProtocolError(`Bad packet length ${length}`);
			if (cursor + length > data.length) break;
			packets.push(data.subarray(cursor, cursor + length));
			at = cursor + length;
		}
		// Copy the remainder so the (possibly large) chunk can be freed.
		this.pending = at === data.length ? new Uint8Array(0) : data.slice(at);
		return packets;
	}

	/** Bytes received but not yet returned as a packet. */
	leftover(): Uint8Array {
		return this.pending;
	}
}

export function uuidToBytes(uuid: string): Uint8Array {
	const hex = uuid.replace(/-/g, "");
	if (!/^[0-9a-fA-F]{32}$/.test(hex)) throw new ProtocolError("Bad UUID");
	const out = new Uint8Array(16);
	for (let i = 0; i < 16; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
	return out;
}

export function bytesToUuid(bytes: Uint8Array): string {
	let hex = "";
	for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
	return hex;
}
