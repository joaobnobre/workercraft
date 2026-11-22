// The Worker in front of the world. Spectrum hands it a raw TCP connection.
//
// A server list ping is answered right here: the game shows the server as
// online without anything else running. A player who actually joins is piped
// to the world's Durable Object, which speaks the rest of the protocol.
//
// Both tell the world which client they are for (an address turned into a key,
// see net/address.ts), so it can hold each address to its limits.

import { Deframer, Reader, concat } from "./net/bytes";
import type { Text } from "./net/nbt";
import { statusPong, statusResponse } from "./protocol/packets";
import { PROTOCOL, S, VERSION_NAME } from "./protocol/version";
import { clientKey, worldTarget } from "./net/address";
import type { Env, WorldStatus } from "./world/world";

export { World } from "./world/world";

const INTENT_STATUS = 1;
/** A connection that has not said what it wants by then is dropped. */
const HANDSHAKE_TIMEOUT_MS = 10_000;
const LEGACY_PING = 0xfe;

const DEFAULT_MOTD: Text = {
	text: "",
	extra: [
		{ text: "workercraft", color: "gold", bold: true },
		{ text: "  a Minecraft server with no server\n", color: "gray" },
		{ text: "one Durable Object, zero JVMs", color: "dark_gray" },
	],
};

function world(env: Env) {
	return env.WORLD.getByName("main");
}

export default {
	async connect(socket: Socket, env: Env): Promise<void> {
		// A client that drops the connection rejects this; that is not an error here.
		socket.closed.catch(() => {});
		const reader = socket.readable.getReader();
		const deframer = new Deframer(4096);
		const received: Uint8Array[] = [];
		const packets: Uint8Array[] = [];
		const timeout = setTimeout(() => reader.cancel().catch(() => {}), HANDSHAKE_TIMEOUT_MS);
		// Who the client is, from the address Spectrum gives. Undefined when unknown.
		const client = socket.opened.then(
			(info) => clientKey(info.remoteAddress),
			() => undefined,
		);

		/** Next packet from the client, or undefined once it hangs up. */
		const nextPacket = async (): Promise<Uint8Array | undefined> => {
			while (packets.length === 0) {
				const { value, done } = await reader.read();
				if (done || value[0] === LEGACY_PING) return undefined; // pre-2013 clients ping differently
				received.push(value);
				packets.push(...deframer.push(value));
			}
			return packets.shift();
		};

		try {
			const handshake = await nextPacket();
			if (!handshake) return;
			const r = new Reader(handshake);
			if (r.varint() !== S.handshake.intention) return;
			r.varint(); // protocol version
			r.string(255); // server address
			r.u16(); // server port
			const intent = r.varint();

			if (intent === INTENT_STATUS) {
				const writer = socket.writable.getWriter();
				for (let packet = await nextPacket(); packet; packet = await nextPacket()) {
					const request = new Reader(packet);
					const id = request.varint();
					if (id === S.status.request) {
						const status = await statusJson(env, await client);
						// Over the ping limit: hang up without an answer, which is what
						// vanilla does with a status request it is set to ignore.
						if (!status) break;
						await writer.write(statusResponse(status));
					} else if (id === S.status.ping) {
						await writer.write(statusPong(request.i64()));
						break;
					}
				}
				await writer.close();
				return;
			}

			// Joining. Hand the connection to the world, replaying what was already read.
			clearTimeout(timeout);
			reader.releaseLock();
			const upstream = world(env).connect(worldTarget(await client), { allowHalfOpen: true, secureTransport: "off" });
			upstream.closed.catch(() => {});
			await upstream.opened;
			const writer = upstream.writable.getWriter();
			await writer.write(concat(received));
			writer.releaseLock();
			// The world ends the conversation: the client's connection is closed once
			// everything the world sent has been passed on. The other direction is
			// not waited for, because it fails as soon as the world stops reading,
			// which is what it does to turn a player away, and closing on that
			// could lose the reason it had just sent. When the client hangs up
			// first, the world sees that and ends its side.
			socket.readable.pipeTo(upstream.writable).catch(() => {});
			try {
				await upstream.readable.pipeTo(socket.writable);
			} finally {
				await Promise.allSettled([upstream.close()]);
			}
		} catch {
			// A malformed handshake, or one side hung up mid-stream. Either way the
			// connection is over and there is nothing to report.
		} finally {
			clearTimeout(timeout);
			await Promise.allSettled([socket.close()]);
		}
	},

	/** The same Worker over HTTP: who is online, as JSON. */
	async fetch(_request: Request, env: Env): Promise<Response> {
		const status = await world(env).status();
		return Response.json({ version: VERSION_NAME, protocol: PROTOCOL, ...status });
	},
} satisfies ExportedHandler<Env>;

/** The server list entry, or undefined if this client is over the ping limit. */
async function statusJson(env: Env, client: string | undefined): Promise<unknown> {
	const status: WorldStatus | null = await world(env).status(client);
	if (!status) return undefined;
	return {
		version: { name: VERSION_NAME, protocol: PROTOCOL },
		players: { max: status.max, online: status.online, sample: status.players.slice(0, 12).map(({ name, uuid }) => ({ name, id: uuid })) },
		description: env.MOTD ? { text: env.MOTD } : DEFAULT_MOTD,
		enforcesSecureChat: false,
	};
}
