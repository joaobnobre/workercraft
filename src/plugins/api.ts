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
type MaybePromise<T> = T | Promise<T>;

export interface Hooks {
	onJoin?(event: JoinEvent, server: Server): MaybePromise<void>;
	onQuit?(event: QuitEvent, server: Server): MaybePromise<void>;
	onChat?(event: ChatEvent, server: Server): MaybePromise<Verdict>;
	/** Return true when this plugin handled the command. */
	onCommand?(event: CommandEvent, server: Server): MaybePromise<boolean | void>;
	onBlockBreak?(event: BlockEvent, server: Server): MaybePromise<Verdict>;
	onBlockPlace?(event: BlockEvent, server: Server): MaybePromise<Verdict>;
}

export type HookName = keyof Hooks;

export const HOOK_NAMES: HookName[] = ["onJoin", "onQuit", "onChat", "onCommand", "onBlockBreak", "onBlockPlace"];

/**
 * What a plugin can do to the world. Every method is async so the same code
 * works in-process and across an RPC boundary.
 */
export interface Server {
	/** Sends a chat line to everyone. */
	broadcast(text: Text): Promise<void>;
	/** Sends a chat line to one player. */
	message(player: string, text: Text): Promise<void>;
	players(): Promise<PlayerInfo[]>;
	getBlock(x: number, y: number, z: number): Promise<string>;
	/** Returns false for an unknown block name or a position outside the world. */
	setBlock(x: number, y: number, z: number, block: string): Promise<boolean>;
	teleport(player: string, x: number, y: number, z: number): Promise<void>;
	kick(player: string, reason: Text): Promise<void>;
}
