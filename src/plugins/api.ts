// The plugin API. A plugin is a set of event hooks plus a handle to the
// server. It can be compiled into the server (see ./builtin.ts) or be its own
// Worker (see sdk/plugin.ts and plugins/), in which case every hook is an RPC
// call over a service binding.

import type { Text } from "../net/nbt";

export type { Text };

export interface PlayerInfo {
	name: string;
	uuid: string;
	x: number;
	y: number;
	z: number;
	/** The client said in its handshake that another server transferred it here. */
	transferred: boolean;
}

/**
 * A player who has logged in and is not in the world yet: nothing of the
 * world has been sent to them, and nobody else knows they are there.
 */
export interface LoginEvent {
	name: string;
	uuid: string;
	/** Arrived by transfer from another server, so may carry that server's cookies. */
	transferred: boolean;
}
export interface TimerEvent {
	/** How many times the timer has fired since the world started. */
	count: number;
}

export interface JoinEvent {
	player: PlayerInfo;
}
export interface QuitEvent {
	player: PlayerInfo;
}
export interface ChatEvent {
	player: PlayerInfo;
	message: string;
}
export interface CommandEvent {
	player: PlayerInfo;
	/** Without the leading slash, lower case: "tp". */
	command: string;
	args: string[];
}
export interface BlockEvent {
	player: PlayerInfo;
	x: number;
	y: number;
	z: number;
	/** Block name without the namespace: "oak_planks". */
	block: string;
}

/** Return `{ cancel: true }` to stop the event from happening. */
export type Verdict = void | { cancel?: boolean };
/** Return `{ cancel: true, reason }` to turn the player away; `reason` is what they read. */
export type LoginVerdict = void | { cancel?: boolean; reason?: Text };
type MaybePromise<T> = T | Promise<T>;

export interface Hooks {
	/**
	 * Decides whether a player may come in, before they appear in the world.
	 * The player's name already works with `server.requestCookie`.
	 *
	 * Unlike the other hooks, this one fails closed: a plugin that implements
	 * it and throws, does not answer within 5 seconds, or cannot be reached at
	 * all turns the player away. A plugin whose hook list cannot be fetched
	 * might be a gate, so it turns players away too.
	 */
	onLogin?(event: LoginEvent, server: Server): MaybePromise<LoginVerdict>;
	/**
	 * Once a second while anyone is online, for plugins that act on their own
	 * rather than on what a player does. A call that is still running when the
	 * next one is due makes the world skip that one.
	 */
	onTimer?(event: TimerEvent, server: Server): MaybePromise<void>;
	onJoin?(event: JoinEvent, server: Server): MaybePromise<void>;
	onQuit?(event: QuitEvent, server: Server): MaybePromise<void>;
	onChat?(event: ChatEvent, server: Server): MaybePromise<Verdict>;
	/** Return true when this plugin handled the command. */
	onCommand?(event: CommandEvent, server: Server): MaybePromise<boolean | void>;
	onBlockBreak?(event: BlockEvent, server: Server): MaybePromise<Verdict>;
	onBlockPlace?(event: BlockEvent, server: Server): MaybePromise<Verdict>;
}

export type HookName = keyof Hooks;

export const HOOK_NAMES: HookName[] = ["onLogin", "onJoin", "onQuit", "onTimer", "onChat", "onCommand", "onBlockBreak", "onBlockPlace"];

/**
 * What a plugin can do to the world. Every method is async so the same code
 * works in-process and across an RPC boundary.
 */
export interface Server {
	/** Sends a chat line to everyone. */
	broadcast(text: Text): Promise<void>;
	/** Sends a chat line to one player. */
	message(player: string, text: Text): Promise<void>;
	/** Shows a line above the player's hotbar that fades after a few seconds and does not go into the chat. */
	actionBar(player: string, text: Text): Promise<void>;
	players(): Promise<PlayerInfo[]>;
	getBlock(x: number, y: number, z: number): Promise<string>;
	/** Returns false for an unknown block name or a position outside the world. */
	setBlock(x: number, y: number, z: number, block: string): Promise<boolean>;
	teleport(player: string, x: number, y: number, z: number): Promise<void>;
	kick(player: string, reason: Text): Promise<void>;
	/**
	 * Sends a player to another server, which sees in the handshake that they
	 * were transferred and can ask for the cookies stored here. The player
	 * leaves this world at once, as if they had disconnected. The other server
	 * has to accept transfers (`accepts-transfers=true` on a vanilla or Paper
	 * server; workercraft always does). Throws for a host that is empty or
	 * longer than 32767 characters, or a port outside 1 to 65535.
	 */
	transfer(player: string, host: string, port: number): Promise<void>;
	/**
	 * Has the player's game keep up to 5120 bytes under a key such as
	 * "myplugin:ticket". The game keeps cookies for as long as it is connected
	 * and takes them along to the server it is transferred to; it forgets them
	 * when it disconnects any other way. Only once the player is in the world.
	 * Throws for a bad key or a payload that is too large.
	 */
	storeCookie(player: string, key: string, payload: Uint8Array): Promise<void>;
	/**
	 * Asks the player's game for the cookie stored under a key. Resolves to its
	 * bytes, or to undefined when the game has none. Works from `onLogin` on,
	 * where the name is the player being let in. Rejects when the player is
	 * not connected or their game does not answer within 3 seconds. What comes
	 * back is whatever the client chose to send: check it before trusting it.
	 */
	requestCookie(player: string, key: string): Promise<Uint8Array | undefined>;
}
