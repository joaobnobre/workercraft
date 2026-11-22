// One TCP connection, from handshake to disconnect. Reads packets, keeps the
// protocol phase, and turns play packets into calls on the world.

import { Deframer, ProtocolError, Reader, concat } from "../net/bytes";
import type { Text } from "../net/nbt";
import { readClientStack } from "../protocol/components";
import * as out from "../protocol/packets";
import { BEFORE_26_3, DATA_PACK_VERSIONS, PROTOCOL, S, VERSION_NAME } from "../protocol/version";
import { offlineUuid } from "./skins";
import type { Player, World } from "./world";

export const BRAND = "workercraft";

/** A connection that has not reached the game by then is dropped. */
const LOGIN_TIMEOUT_MS = 20_000;
/** A client that stops reading is dropped once this much is waiting for it. */
const MAX_QUEUED_BYTES = 24 << 20;

/** How long a closing connection waits for its last bytes to go out. */
const FLUSH_TIMEOUT_MS = 2000;

/**
 * Packets, and bytes of them, read while earlier ones are still being
 * handled. Past either, reading pauses until the handlers catch up.
 */
const MAX_BACKLOG = 256;
const MAX_BACKLOG_BYTES = 1 << 20;
/** How long a cookie request waits for the client's answer. */
const COOKIE_TIMEOUT_MS = 3000;
/** Cookie requests that may be waiting on one connection at once. */
const MAX_COOKIE_REQUESTS = 16;
/** Most characters in a transfer's host name or a cookie's key (FriendlyByteBuf.readUtf). */
const MAX_STRING_LENGTH = 32767;
/**
 * A transferred client hangs up by itself, the way it does when a vanilla
 * server transfers it. One that has not by then is disconnected.
 */
const TRANSFER_GRACE_MS = 10_000;

/** The handshake's intent when the client was sent here by another server. */
const INTENT_TRANSFER = 3;

/** What the numbers in a player_action packet mean. 26.3 added one in the middle. */
export type PlayerAction = "startDigging" | "changeDigDirection" | "cancelDigging" | "finishDigging" | "dropStack" | "dropOne" | "releaseItem" | "swapHands" | "stab";
const PLAYER_ACTIONS: PlayerAction[] = BEFORE_26_3
	? ["startDigging", "cancelDigging", "finishDigging", "dropStack", "dropOne", "releaseItem", "swapHands", "stab"]
	: ["startDigging", "changeDigDirection", "cancelDigging", "finishDigging", "dropStack", "dropOne", "releaseItem", "swapHands", "stab"];
const SIGN_FRONT = 1;

const INPUT_SNEAK = 0x20;
const COMMAND_START_SPRINTING = 1;
const COMMAND_STOP_SPRINTING = 2;

export interface ClientSettings {
	viewDistance: number;
	skinParts: number;
}

type Phase = "handshake" | "login" | "config" | "play" | "closed";

interface CookieWait {
	resolve(payload: Uint8Array | undefined): void;
	reject(error: Error): void;
	timer: ReturnType<typeof setTimeout>;
}

/**
 * A cookie key as the game reads it: "namespace:path", where a key without a
 * namespace is in "minecraft". Throws for anything the game would not accept.
 */
export function cookieKey(key: unknown): string {
	if (typeof key !== "string" || key.length > MAX_STRING_LENGTH) throw new Error("A cookie key is a string such as \"myplugin:ticket\"");
	const colon = key.indexOf(":");
	const namespace = colon < 0 ? "minecraft" : key.slice(0, colon);
	const path = colon < 0 ? key : key.slice(colon + 1);
	if (!/^[a-z0-9_.-]+$/.test(namespace) || namespace === ".." || !/^[a-z0-9_.\/-]+$/.test(path)) {
		throw new Error(`"${key}" is not a valid cookie key: lower-case letters, digits, _ . - (and / after the colon), such as "myplugin:ticket"`);
	}
	return `${namespace}:${path}`;
}

export class Session {
	phase: Phase = "handshake";
	name = "";
	uuid: Uint8Array = new Uint8Array(16);
	skin: Promise<out.ProfileProperty[]> = Promise.resolve([]);
	settings: ClientSettings = { viewDistance: 8, skinParts: 0x7f };
	player?: Player;
	/** The client said in its handshake that another server transferred it here. */
	transferred = false;

	private protocol = 0;
	/**
	 * The phase the next packet from the client belongs to. It runs ahead of
	 * `phase` while packets wait to be handled, see run().
	 */
	private incoming: Phase = "handshake";
	private cookieWaits = new Map<string, CookieWait[]>();
	private cookieWaitCount = 0;
	private sentRegistries = false;
	private outbox: Uint8Array[] = [];
	private queuedBytes = 0;
	private lastWrite: Promise<void> = Promise.resolve();
	private reader: ReadableStreamDefaultReader<Uint8Array>;
	private writer: WritableStreamDefaultWriter<Uint8Array>;

	constructor(
		private world: World,
		socket: Socket,
	) {
		// A client that drops the connection rejects this; that is not an error here.
		socket.closed.catch(() => {});
		this.reader = socket.readable.getReader();
		this.writer = socket.writable.getWriter();
		this.reader.closed.catch(() => {});
		this.writer.closed.catch(() => {});
	}

	async run(): Promise<void> {
		const deframer = new Deframer();
		const loginDeadline = setTimeout(() => {
			if (this.phase !== "play") this.close();
		}, LOGIN_TIMEOUT_MS);
		// Packets are handled one at a time, in order, but reading does not wait
		// for that: a handler may be waiting for a plugin that waits for a cookie,
		// and the client's answer is a packet that comes after the one being
		// handled. Cookie answers are therefore taken as they are read, and
		// everything else joins the queue of packets to handle.
		let handling = Promise.resolve();
		let backlog = 0;
		let backlogBytes = 0;
		try {
			while (this.phase !== "closed") {
				const { value, done } = await this.reader.read();
				if (done) break;
				for (const data of deframer.push(value)) {
					const r = new Reader(data);
					const id = r.varint();
					if (this.takeCookieResponse(id, r)) continue;
					this.advanceIncoming(id);
					backlog++;
					backlogBytes += data.length;
					handling = handling.then(async () => {
						backlog--;
						backlogBytes -= data.length;
						if (this.phase !== "closed") await this.handle(id, r).catch((error) => this.fail(error));
					});
				}
				if (backlog > MAX_BACKLOG || backlogBytes > MAX_BACKLOG_BYTES) await handling;
			}
		} catch (error) {
			this.fail(error);
		} finally {
			clearTimeout(loginDeadline);
			this.close();
			if (this.player) this.world.leave(this.player);
			// A handler still running sees the connection closed and stops; one that
			// was letting the player in may have done so meanwhile.
			await handling;
			if (this.player) this.world.leave(this.player);
			await Promise.race([this.lastWrite, new Promise((resolve) => setTimeout(resolve, FLUSH_TIMEOUT_MS))]);
		}
	}

	private fail(error: unknown): void {
		if (error instanceof ProtocolError) this.disconnect(`Bad packet: ${error.message}`);
		// Anything else is the socket ending abruptly, which is how most clients leave.
		else this.close();
	}

	/** Follows the client's switches of phase as its packets are read, before they are handled. */
	private advanceIncoming(id: number): void {
		if (this.incoming === "handshake") this.incoming = "login";
		else if (this.incoming === "login" && id === S.login.acknowledged) this.incoming = "config";
		else if (this.incoming === "config" && id === S.config.finish) this.incoming = "play";
	}

	/**
	 * Queues bytes for the world's next tick. Movement of other players goes
	 * through here: with many players it turns thousands of tiny socket writes a
	 * second into one write per player per tick.
	 */
	sendSoon(bytes: Uint8Array): void {
		if (this.phase !== "closed") this.outbox.push(bytes);
	}

	/** Writes whatever sendSoon() queued. */
	flush(): void {
		if (this.outbox.length === 0) return;
		const bytes = this.outbox.length === 1 ? this.outbox[0]! : concat(this.outbox);
		this.outbox = [];
		this.write(bytes);
	}

	/** Sends now, after anything already queued so packets stay in order. */
	send(bytes: Uint8Array): void {
		this.outbox.push(bytes);
		this.flush();
	}

	private write(bytes: Uint8Array): void {
		if (this.phase === "closed") return;
		this.queuedBytes += bytes.length;
		if (this.queuedBytes > MAX_QUEUED_BYTES) {
			this.close();
			return;
		}
		this.lastWrite = this.writer.write(bytes).then(
			() => {
				this.queuedBytes -= bytes.length;
			},
			() => this.close(),
		);
	}

	/** Tells the client why, then closes. */
	disconnect(reason: Text): void {
		if (this.phase === "login" || this.phase === "handshake") this.send(out.loginDisconnect(reason));
		else if (this.phase === "config") this.send(out.configDisconnect(reason));
		else if (this.phase === "play") this.send(out.playDisconnect(reason));
		this.close();
	}

	close(): void {
		if (this.phase === "closed") return;
		this.phase = "closed";
		for (const waits of this.cookieWaits.values()) {
			for (const wait of waits) {
				clearTimeout(wait.timer);
				wait.reject(new Error("The player disconnected before answering"));
			}
		}
		this.cookieWaits.clear();
		// Ends the read loop in run(). The socket itself closes when run() returns,
		// which is once everything queued (a disconnect message, say) is written.
		this.reader.cancel().catch(() => {});
	}

	// ---- cookies and transfers ----------------------------------------------

	/**
	 * Asks the client for a cookie. Resolves to its bytes, or to undefined when
	 * the client has none under that key. A client only has cookies that a
	 * server stored during this connection or, when it was transferred, the
	 * one before it. Rejects when the client does not answer in time.
	 */
	requestCookie(key: string): Promise<Uint8Array | undefined> {
		const normalized = cookieKey(key);
		const phase = this.phase;
		if (phase !== "login" && phase !== "config" && phase !== "play") return Promise.reject(new Error("The player is not connected"));
		if (this.cookieWaitCount >= MAX_COOKIE_REQUESTS) return Promise.reject(new Error("Too many cookie requests are waiting for this player"));
		return new Promise((resolve, reject) => {
			const waits = this.cookieWaits.get(normalized) ?? [];
			const wait: CookieWait = {
				resolve,
				reject,
				timer: setTimeout(() => {
					waits.splice(waits.indexOf(wait), 1);
					this.cookieWaitCount--;
					reject(new Error(`The player did not answer the request for cookie ${normalized}`));
				}, COOKIE_TIMEOUT_MS),
			};
			waits.push(wait);
			this.cookieWaits.set(normalized, waits);
			this.cookieWaitCount++;
			this.send(out.cookieRequest(phase, normalized));
		});
	}

	/**
	 * Reads a cookie answer, which may arrive in any phase that has one. The
	 * client is not trusted to answer only what was asked, or only once: an
	 * answer nobody is waiting for is dropped.
	 */
	private takeCookieResponse(id: number, r: Reader): boolean {
		const phase = this.incoming;
		const expected = phase === "login" ? S.login.cookieResponse : phase === "config" ? S.config.cookieResponse : phase === "play" ? S.play.cookieResponse : undefined;
		if (id !== expected) return false;
		let key: string;
		try {
			key = cookieKey(r.string(MAX_STRING_LENGTH));
		} catch (error) {
			throw error instanceof ProtocolError ? error : new ProtocolError("Bad cookie key");
		}
		let payload: Uint8Array | undefined;
		if (r.bool()) {
			const length = r.varint();
			if (length < 0 || length > out.COOKIE_MAX_BYTES) throw new ProtocolError("Cookie is too large");
			payload = r.bytes(length).slice();
		}
		const wait = this.cookieWaits.get(key)?.shift();
		if (wait) {
			clearTimeout(wait.timer);
			this.cookieWaitCount--;
			wait.resolve(payload);
		}
		return true;
	}

	/** Has the client keep a cookie for the rest of this connection and across a transfer. */
	storeCookie(key: string, payload: Uint8Array): void {
		const normalized = cookieKey(key);
		if (!(payload instanceof Uint8Array)) throw new Error("A cookie's payload is a Uint8Array");
		if (payload.length > out.COOKIE_MAX_BYTES) throw new Error(`A cookie holds at most ${out.COOKIE_MAX_BYTES} bytes, not ${payload.length}`);
		if (this.phase !== "config" && this.phase !== "play") throw new Error("Cookies can only be stored once the player is past login");
		this.send(out.storeCookie(this.phase, normalized, payload));
	}

	/**
	 * Sends the client to another server. The client hangs up by itself; the
	 * world forgets the player at once (see World.transfer).
	 */
	transfer(host: string, port: number): void {
		if (typeof host !== "string" || host.length === 0 || host.length > MAX_STRING_LENGTH) throw new Error("A transfer needs a host name");
		if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`${port} is not a port`);
		if (this.phase !== "config" && this.phase !== "play") throw new Error("Players can only be transferred once they are past login");
		this.send(out.transfer(this.phase, host, port));
		setTimeout(() => this.close(), TRANSFER_GRACE_MS);
	}

	private async handle(id: number, r: Reader): Promise<void> {
		switch (this.phase) {
			case "handshake":
				return this.onHandshake(id, r);
			case "login":
				return this.onLogin(id, r);
			case "config":
				return this.onConfig(id, r);
			case "play":
				return this.onPlay(id, r);
		}
	}

	private onHandshake(id: number, r: Reader): void {
		if (id !== S.handshake.intention) throw new ProtocolError("Expected a handshake");
		this.protocol = r.varint();
		r.string(255); // server address
		r.u16(); // server port
		const intent = r.varint();
		// 1 is a server list ping, which the Worker answers without waking this object.
		if (intent !== 2 && intent !== INTENT_TRANSFER) throw new ProtocolError("Unsupported handshake intent");
		this.transferred = intent === INTENT_TRANSFER;
		this.phase = "login";
	}

	private async onLogin(id: number, r: Reader): Promise<void> {
		if (id === S.login.hello) {
			const name = r.string(16);
			const claimedUuid = r.bytes(16).slice();
			if (this.protocol !== PROTOCOL) {
				return this.disconnect({ text: `This server runs Minecraft ${VERSION_NAME}. Switch to that version to join.` });
			}
			if (!/^[A-Za-z0-9_]{1,16}$/.test(name)) return this.disconnect({ text: "That name is not a valid Minecraft name." });
			if (this.world.isFull) return this.disconnect({ translate: "multiplayer.disconnect.server_full" });
			this.name = name;
			this.uuid = await offlineUuid(name);
			// Plugins may refuse the player here, before anything of the world is
			// sent. They may ask the client for cookies while they decide.
			const refusal = await this.world.admit(this);
			if (this.phase !== "login") return;
			if (refusal) return this.disconnect(refusal);
			this.skin = this.world.lookupSkin(name, claimedUuid);
			this.send(out.loginFinished(this.uuid, name, []));
		} else if (id === S.login.acknowledged) {
			if (!this.name) throw new ProtocolError("Login acknowledged before login");
			this.phase = "config";
			this.send(out.configPreamble(BRAND));
		}
	}

	private async onConfig(id: number, r: Reader): Promise<void> {
		switch (id) {
			case S.config.clientInformation:
				this.settings = readClientInformation(r);
				return;
			case S.config.knownPacks: {
				if (this.sentRegistries) return;
				this.sentRegistries = true;
				let hasVanillaData = false;
				const count = Math.min(r.varint(), 64);
				for (let i = 0; i < count; i++) {
					const namespace = r.string();
					const pack = r.string();
					const version = r.string();
					if (namespace === "minecraft" && pack === "core" && DATA_PACK_VERSIONS.includes(version)) hasVanillaData = true;
				}
				this.send(out.configRegistries(hasVanillaData));
				return;
			}
			case S.config.finish:
				if (!this.sentRegistries) throw new ProtocolError("Configuration finished early");
				this.phase = "play";
				await this.world.join(this);
				return;
		}
	}

	private async onPlay(id: number, r: Reader): Promise<void> {
		const player = this.player;
		if (!player) return;
		const world = this.world;
		switch (id) {
			case S.play.keepAlive:
				player.lastKeepAlive = Date.now();
				return;
			case S.play.acceptTeleportation:
				if (r.varint() === player.awaitingTeleport) player.awaitingTeleport = undefined;
				return;
			case S.play.movePos:
				return world.move(player, { x: r.f64(), y: r.f64(), z: r.f64() }, undefined, (r.u8() & 1) !== 0);
			case S.play.movePosRot:
				return world.move(player, { x: r.f64(), y: r.f64(), z: r.f64() }, { yaw: r.f32(), pitch: r.f32() }, (r.u8() & 1) !== 0);
			case S.play.moveRot:
				return world.move(player, undefined, { yaw: r.f32(), pitch: r.f32() }, (r.u8() & 1) !== 0);
			case S.play.moveStatusOnly:
				return world.move(player, undefined, undefined, (r.u8() & 1) !== 0);
			case S.play.chat:
				return world.chat(player, r.string(256));
			case S.play.chatCommand:
			case S.play.chatCommandSigned:
				return world.command(player, r.string(256));
			case S.play.playerAction: {
				const action = PLAYER_ACTIONS[r.varint()];
				const position = r.position();
				r.i8(); // face
				const sequence = r.varint();
				return action === undefined ? undefined : world.dig(player, action, position, sequence);
			}
			case S.play.useItemOn: {
				const hand = r.varint();
				const position = r.position();
				const face = r.varint();
				const cursor = { x: r.f32(), y: r.f32(), z: r.f32() }; // where on the block the crosshair was
				r.bool(), r.bool(); // head inside block, hit the world border
				return world.place(player, hand, position, face, cursor, r.varint());
			}
			case S.play.swing:
				return world.swing(player, r.varint());
			case S.play.punch:
				return world.swing(player, 0);
			case S.play.setCarriedItem: {
				const slot = r.i16();
				if (slot >= 0 && slot <= 8) world.holdSlot(player, slot);
				return;
			}
			case S.play.setCreativeSlot: {
				const slot = r.i16();
				// With its components; which of them reach anyone else is up to components.ts.
				return world.creativeSlot(player, slot, readClientStack(r));
			}
			case S.play.pickItemFromBlock:
				return world.pickBlock(player, r.position());
			case S.play.signUpdate: {
				const position = r.position();
				// The side used to come first, as a yes/no; since 26.3 it comes last.
				const frontFirst = BEFORE_26_3 ? r.bool() : undefined;
				const lines = [r.string(384), r.string(384), r.string(384), r.string(384)];
				return world.signUpdate(player, position, frontFirst ?? r.varint() === SIGN_FRONT, lines);
			}
			case S.play.playerInput:
				return world.setPose(player, { sneaking: (r.u8() & INPUT_SNEAK) !== 0 });
			case S.play.playerCommand: {
				r.varint(); // entity id
				const action = r.varint();
				if (action === COMMAND_START_SPRINTING) world.setPose(player, { sprinting: true });
				else if (action === COMMAND_STOP_SPRINTING) world.setPose(player, { sprinting: false });
				return;
			}
			case S.play.clientInformation:
				this.settings = readClientInformation(r);
				return world.applySettings(player, this.settings);
		}
	}
}

function readClientInformation(r: Reader): ClientSettings {
	r.string(16); // locale
	const viewDistance = r.i8();
	r.varint(); // chat visibility
	r.bool(); // chat colors
	const skinParts = r.u8();
	return { viewDistance, skinParts };
}
