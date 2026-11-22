// Test of the per-address connection limits. It needs a server started with
// low limits, so that it can reach them:
//
//   INSTANCE=22 npm run dev -- --var MAX_CONNECTIONS_PER_ADDRESS:3 --var JOINS_PER_ADDRESS:8/8 --var PINGS_PER_ADDRESS:3/3 --var SKINS:off
//   INSTANCE=22 npm run test:limits
//
// Every connection comes from 127.0.0.1, so they all count as one address. The
// clients here speak only the handshake, the start of the login and the server
// list ping, which are the same in every version this server builds for. Held
// connections stay in the login phase, so none of them joins the world. It
// takes about a minute, most of it waiting for allowances to refill and for
// the login timeout.

import { connect } from "node:net";
import { devInstance } from "../scripts/instance.mjs";
import { addressNetwork, clientKey, keyFromTarget, worldTarget } from "../src/net/address.ts";

const host = process.env.HOST ?? "127.0.0.1";
const port = Number(process.env.PORT ?? devInstance().gamePort);

// What the server has to be started with (see above).
const MAX_CONNECTIONS = 3;
const JOINS = { count: 8, seconds: 8 };
const PINGS = { count: 3, seconds: 3 };
/** session.ts drops a connection that has not reached the game by then. */
const LOGIN_TIMEOUT_MS = 20_000;

let failures = 0;
function check(label, ok, detail = "") {
	console.log(`${ok ? "ok  " : "FAIL"} ${label}${detail ? `  (${detail})` : ""}`);
	if (!ok) failures++;
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---- just enough of the protocol ----

function varint(value) {
	const bytes = [];
	do {
		let byte = value & 0x7f;
		value >>>= 7;
		if (value !== 0) byte |= 0x80;
		bytes.push(byte);
	} while (value !== 0);
	return Buffer.from(bytes);
}
const string = (text) => Buffer.concat([varint(Buffer.byteLength(text)), Buffer.from(text)]);
const frame = (...parts) => {
	const body = Buffer.concat(parts);
	return Buffer.concat([varint(body.length), body]);
};
const handshake = (protocol, intent) => frame(varint(0x00), varint(protocol), string(host), Buffer.from([port >> 8, port & 0xff]), varint(intent));

function readVarint(buf, offset) {
	let value = 0;
	for (let shift = 0; shift < 35; shift += 7) {
		if (offset >= buf.length) return undefined;
		const byte = buf[offset++];
		value |= (byte & 0x7f) << shift;
		if ((byte & 0x80) === 0) return { value: value >>> 0, offset };
	}
	throw new Error("bad varint");
}

/** One TCP connection that collects the packets the server sends, and notices when it closes. */
class Connection {
	constructor() {
		this.packets = [];
		this.closed = false;
		this.buffer = Buffer.alloc(0);
		this.waiters = [];
		this.socket = connect({ host, port });
		this.socket.setNoDelay(true);
		this.ready = new Promise((resolve, reject) => {
			this.socket.once("connect", resolve);
			this.socket.once("error", reject);
		});
		this.socket.on("error", () => {});
		this.socket.on("data", (data) => {
			this.buffer = Buffer.concat([this.buffer, data]);
			for (;;) {
				const length = readVarint(this.buffer, 0);
				if (!length || this.buffer.length < length.offset + length.value) break;
				const body = this.buffer.subarray(length.offset, length.offset + length.value);
				this.buffer = this.buffer.subarray(length.offset + length.value);
				const id = readVarint(body, 0);
				this.packets.push({ id: id.value, body: body.subarray(id.offset) });
			}
			this.wake();
		});
		this.socket.on("close", () => {
			this.closed = true;
			this.wake();
		});
	}

	wake() {
		for (const waiter of this.waiters.splice(0)) waiter();
	}

	send(bytes) {
		this.socket.write(bytes);
	}

	/** The next packet, or undefined once the connection closed or the time ran out. */
	async next(timeoutMs = 5000) {
		const deadline = Date.now() + timeoutMs;
		while (this.packets.length === 0 && !this.closed && Date.now() < deadline) {
			await new Promise((resolve) => {
				this.waiters.push(resolve);
				setTimeout(resolve, deadline - Date.now());
			});
		}
		return this.packets.shift();
	}

	/** Waits until the server has closed the connection. True if it did in time. */
	async untilClosed(timeoutMs = 5000) {
		const deadline = Date.now() + timeoutMs;
		while (!this.closed && Date.now() < deadline) {
			await new Promise((resolve) => {
				this.waiters.push(resolve);
				setTimeout(resolve, deadline - Date.now());
			});
		}
		return this.closed;
	}

	/** Hangs up and waits for the connection to be gone. */
	async hangUp() {
		this.socket.end();
		await this.untilClosed();
		this.socket.destroy();
	}
}

const LOGIN_DISCONNECT = 0x00;
const LOGIN_FINISHED = 0x02;
let protocol = 0;
let nameCount = 0;

/**
 * Starts logging in and says how the server answered: "in" once it accepted
 * the login, or the reason it gave for refusing. The connection stays open in
 * the login phase until the caller closes it or the login timeout does.
 */
async function login() {
	const connection = new Connection();
	await connection.ready;
	const uuid = Buffer.alloc(16);
	uuid.writeUInt32BE(nameCount, 12);
	connection.send(Buffer.concat([handshake(protocol, 2), frame(varint(0x00), string(`limits_${nameCount++}`), uuid)]));
	const packet = await connection.next();
	if (packet?.id === LOGIN_FINISHED) connection.outcome = "in";
	else if (packet?.id === LOGIN_DISCONNECT) connection.outcome = reasonText(packet.body);
	else connection.outcome = packet ? `packet ${packet.id}` : connection.closed ? "closed without a word" : "no answer";
	return connection;
}

function reasonText(body) {
	const length = readVarint(body, 0);
	const json = JSON.parse(body.subarray(length.offset, length.offset + length.value).toString());
	return typeof json === "string" ? json : (json.text ?? json.translate ?? JSON.stringify(json));
}

/** A server list ping. Returns the status JSON, or undefined if the server hung up instead. */
async function ping() {
	const connection = new Connection();
	await connection.ready;
	connection.send(Buffer.concat([handshake(protocol || 0, 1), frame(varint(0x00))]));
	const response = await connection.next();
	if (response?.id !== 0x00) {
		connection.socket.destroy();
		return undefined;
	}
	const length = readVarint(response.body, 0);
	const status = JSON.parse(response.body.subarray(length.offset, length.offset + length.value).toString());
	connection.send(frame(varint(0x01), Buffer.alloc(8)));
	const pong = await connection.next();
	connection.socket.destroy();
	return pong?.id === 0x01 ? status : undefined;
}

async function addresses() {
	const cases = [
		["203.0.113.7:12345", "203.0.113.7"],
		["[2001:db8:1:2:3:4:5:6]:12345", "2001:db8:1:2::/64"],
		["[2001:db8:1:2::9]:1", "2001:db8:1:2::/64"],
		["[2001:db8:1:3::]:1", "2001:db8:1:3::/64"],
		["[::ffff:203.0.113.7]:1", "203.0.113.7"],
		["[fe80::1%eth0]:1", "fe80:0:0:0::/64"],
		[undefined, undefined],
		["", undefined],
		["not an address:1", undefined],
		["1.2.3.256:1", undefined],
		["[1::2::3]:1", undefined],
	];
	const wrong = cases.filter(([address, network]) => addressNetwork(address) !== network).map(([address]) => `${address} gives ${addressNetwork(address)}`);
	check("addresses are counted by IPv4 address or IPv6 /64", wrong.length === 0, wrong.join("; "));
	const key = await clientKey("[2001:db8:1:2::9]:1");
	check("one /64 is one key, and a different /64 another", key === (await clientKey("[2001:db8:1:2:ffff::]:2")) && key !== (await clientKey("[2001:db8:1:3::9]:1")));
	check("the key gets through the world's connect address and back", keyFromTarget(worldTarget(key)) === key && keyFromTarget(worldTarget(undefined)) === undefined);
	check("the key does not contain the address", !worldTarget(await clientKey("203.0.113.7:1")).includes("203.0.113"));
}

async function main() {
	await addresses();

	// Allowances left over from an earlier run refill first.
	await sleep(Math.max(JOINS.seconds, PINGS.seconds) * 1000 + 200);
	const first = await ping();
	if (!first) throw new Error(`No server list answer from ${host}:${port}`);
	protocol = first.version.protocol;
	check("a server list ping is answered", true, `${first.version.name}, protocol ${protocol}`);

	// ---- connections at once ----
	const held = [];
	for (let i = 0; i < MAX_CONNECTIONS; i++) held.push(await login());
	check(`${MAX_CONNECTIONS} connections from one address are let in`, held.every((c) => c.outcome === "in"), held.map((c) => c.outcome).join(", "));
	const extra = await login();
	check("the next one is refused with a login disconnect", new RegExp(`already ${MAX_CONNECTIONS} connections`).test(extra.outcome), extra.outcome);
	check("and then closed", await extra.untilClosed());
	check("a server list ping is still answered", Boolean(await ping()));

	await held.shift().hangUp();
	const afterHangUp = await login();
	check("a client hanging up frees its slot", afterHangUp.outcome === "in", afterHangUp.outcome);
	held.push(afterHangUp);

	held.shift().socket.resetAndDestroy();
	await sleep(300);
	const afterReset = await login();
	check("a connection reset frees its slot", afterReset.outcome === "in", afterReset.outcome);
	held.push(afterReset);

	const broken = held.shift();
	broken.send(Buffer.from([0x00])); // a packet of length 0
	const brokenReason = await broken.next();
	check("a protocol error ends the connection", (await broken.untilClosed()) && brokenReason?.id === LOGIN_DISCONNECT, brokenReason && reasonText(brokenReason.body));
	const afterError = await login();
	check("a protocol error frees its slot", afterError.outcome === "in", afterError.outcome);
	held.push(afterError);

	const full = await login();
	check("the limit still holds after all that", new RegExp(`already ${MAX_CONNECTIONS} connections`).test(full.outcome), full.outcome);

	console.log(`     waiting for the login timeout to close the held connections`);
	const timedOut = await Promise.all(held.map((c) => c.untilClosed(LOGIN_TIMEOUT_MS + 5000)));
	check("the login timeout closes them", timedOut.every(Boolean));
	const afterTimeout = [];
	for (let i = 0; i < MAX_CONNECTIONS; i++) afterTimeout.push(await login());
	check("and frees their slots", afterTimeout.every((c) => c.outcome === "in"), afterTimeout.map((c) => c.outcome).join(", "));
	for (const connection of afterTimeout) await connection.hangUp();

	// ---- new connections per second ----
	await sleep(JOINS.seconds * 1000 + 200);
	const burst = [];
	for (let i = 0; i < JOINS.count; i++) {
		const connection = await login();
		burst.push(connection.outcome);
		await connection.hangUp();
	}
	check(`${JOINS.count} joins in a row are let in`, burst.every((outcome) => outcome === "in"), burst.join(", "));
	const tooFast = await login();
	check("the next one is refused for coming too fast", /short time\. Try again in 1 second\./.test(tooFast.outcome), tooFast.outcome);
	await tooFast.untilClosed();
	check("a server list ping is answered meanwhile", Boolean(await ping()));
	await sleep((JOINS.seconds / JOINS.count) * 1000 + 200);
	const later = await login();
	check("once the allowance refills, a join is let in again", later.outcome === "in", later.outcome);
	await later.hangUp();

	// ---- server list pings per second ----
	await sleep(PINGS.seconds * 1000 + 200);
	const pings = [];
	for (let i = 0; i < PINGS.count; i++) pings.push(Boolean(await ping()));
	check(`${PINGS.count} pings in a row are answered`, pings.every(Boolean), pings.join(", "));
	check("the next ping gets no answer", !(await ping()));
	const joinMeanwhile = await login();
	check("joining is not held back by the ping limit", joinMeanwhile.outcome === "in", joinMeanwhile.outcome);
	await joinMeanwhile.hangUp();
	await sleep((PINGS.seconds / PINGS.count) * 1000 + 200);
	check("once the allowance refills, a ping is answered again", Boolean(await ping()));
}

main()
	.catch((error) => {
		console.error(error);
		failures++;
	})
	.finally(() => {
		console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) failed. Was the server started with the limits at the top of test/limits.mjs?`);
		process.exit(failures === 0 ? 0 : 1);
	});
