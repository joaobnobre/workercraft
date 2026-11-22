// The queue ticket: the cookie the limbo gives a player when their turn comes,
// and the destination checks before letting them in. Shared by
// plugins/limbo and plugins/gate.
//
// What it proves. The servers do not verify accounts (offline mode), so a
// name is whatever the client typed. A valid ticket proves only that this
// name went through the queue, recently. Somebody else can then join under
// the same name with the same ticket until it expires, if they get hold of
// its bytes: it is not single-use, and it is not bound to an account.
//
// Cookie key: "queue:ticket". Payload, 42 to 57 bytes:
//
//   offset  size  what
//   0       1     format version, 1
//   1       8     expiry: Unix time in seconds, unsigned, big-endian
//   9       1     n, the length of the name, 1 to 16
//   10      n     the player name, ASCII, exactly as the client sent it at login
//   10+n    32    HMAC-SHA256 of bytes 0 to 10+n-1, keyed with the UTF-8 bytes
//                 of the shared secret (QUEUE_SECRET)
//
// A destination accepts a ticket when the version is 1, the length adds up,
// the HMAC matches (compared in constant time), the expiry is in the future,
// and the name equals the name the player logged in with, case included. In
// Java that is javax.crypto.Mac.getInstance("HmacSHA256") and
// MessageDigest.isEqual for the comparison.

export const TICKET_KEY = "queue:ticket";
const VERSION = 1;
const MAC_BYTES = 32;
const encoder = new TextEncoder();

function hmacKey(secret: string, usage: "sign" | "verify"): Promise<CryptoKey> {
	if (!secret) throw new Error("QUEUE_SECRET is not set");
	return crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [usage]);
}

function body(name: string, expiresAt: number): Uint8Array {
	const nameBytes = encoder.encode(name);
	if (!/^[A-Za-z0-9_]{1,16}$/.test(name)) throw new Error(`"${name}" is not a Minecraft name`);
	const bytes = new Uint8Array(10 + nameBytes.length);
	const view = new DataView(bytes.buffer);
	view.setUint8(0, VERSION);
	view.setBigUint64(1, BigInt(expiresAt));
	view.setUint8(9, nameBytes.length);
	bytes.set(nameBytes, 10);
	return bytes;
}

/** A ticket for `name` that expires `ttlSeconds` from now. */
export async function issueTicket(secret: string, name: string, ttlSeconds: number): Promise<Uint8Array> {
	const signed = body(name, Math.floor(Date.now() / 1000) + ttlSeconds);
	const mac = new Uint8Array(await crypto.subtle.sign("HMAC", await hmacKey(secret, "sign"), signed));
	const ticket = new Uint8Array(signed.length + MAC_BYTES);
	ticket.set(signed);
	ticket.set(mac, signed.length);
	return ticket;
}

export type TicketCheck = "ok" | "malformed" | "forged" | "expired" | "wrong name";

/** Checks a ticket the client sent back. The bytes come from the client, so anything may be in them. */
export async function checkTicket(secret: string, name: string, ticket: Uint8Array): Promise<TicketCheck> {
	if (ticket.length < 10 + 1 + MAC_BYTES || ticket[0] !== VERSION) return "malformed";
	const nameLength = ticket[9]!;
	if (nameLength < 1 || nameLength > 16 || ticket.length !== 10 + nameLength + MAC_BYTES) return "malformed";
	const signed = ticket.subarray(0, 10 + nameLength);
	const mac = ticket.subarray(10 + nameLength);
	// crypto.subtle.verify compares in constant time.
	if (!(await crypto.subtle.verify("HMAC", await hmacKey(secret, "verify"), mac, signed))) return "forged";
	const expiresAt = Number(new DataView(ticket.buffer, ticket.byteOffset, ticket.byteLength).getBigUint64(1));
	if (expiresAt <= Date.now() / 1000) return "expired";
	if (new TextDecoder().decode(ticket.subarray(10, 10 + nameLength)) !== name) return "wrong name";
	return "ok";
}
