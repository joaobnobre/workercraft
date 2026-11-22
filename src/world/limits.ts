// Limits per client address: how many connections one address may have in the
// world at once, and how fast it may open new ones.
//
// The Worker turns the client's address into a key and passes it to the world
// in the address it connects to (see net/address.ts). The counters here are in
// memory only, so a restart forgets them, together with the connections they
// counted. They hold keys, never addresses, and nothing here stores, logs or
// reports either.
//
// A connection whose address is unknown is not limited: one shared counter for
// all of them would turn away everybody at once if the address went missing.

import { loginDisconnect } from "../protocol/packets";

/** "N/T": a burst of N, refilled at N per T seconds. Undefined means no limit. */
export interface Rate {
	count: number;
	periodMs: number;
}

/** Reads "N/T" ("20/60"); "0", "off" or nothing turns the limit off. */
export function parseRate(value: string | undefined): Rate | undefined {
	const text = (value ?? "").trim();
	if (text === "" || text === "0" || text === "off") return undefined;
	const match = /^(\d+)\s*\/\s*(\d+(?:\.\d+)?)\s*s?$/.exec(text);
	const count = Number(match?.[1]);
	const periodMs = Number(match?.[2]) * 1000;
	if (!match || !(count > 0) || !(periodMs > 0)) {
		console.warn(`Ignoring a rate limit that is not "count/seconds": ${JSON.stringify(text)}`);
		return undefined;
	}
	return { count, periodMs };
}

/**
 * A rate limit per key, as a generic cell rate algorithm: up to `count` at
 * once, then one more every `periodMs / count`. One number per key, which is
 * dropped once the key is back to its full allowance. Refused attempts cost
 * nothing.
 */
class RateLimiter {
	/** For each key, when its allowance is next back to full (the "theoretical arrival time"). */
	private full = new Map<string, number>();
	private readonly interval: number;
	private readonly tolerance: number;
	private sweptAt = 0;

	constructor(rate: Rate) {
		this.interval = rate.periodMs / rate.count;
		this.tolerance = rate.periodMs - this.interval;
	}

	/** Counts one attempt. Returns 0 if allowed, otherwise how many ms until the next one would be. */
	take(key: string, now: number): number {
		this.sweep(now);
		const full = Math.max(this.full.get(key) ?? now, now);
		const wait = full - this.tolerance - now;
		if (wait > 0) return wait;
		this.full.set(key, full + this.interval);
		return 0;
	}

	private sweep(now: number): void {
		if (now - this.sweptAt < 60_000) return;
		this.sweptAt = now;
		for (const [key, full] of this.full) if (full <= now) this.full.delete(key);
	}
}

export interface LimitSettings {
	MAX_CONNECTIONS_PER_ADDRESS?: string;
	JOINS_PER_ADDRESS?: string;
	PINGS_PER_ADDRESS?: string;
}

/** How long a refused connection waits for the bytes the Worker passes on first. */
const REFUSAL_WAIT_MS = 2000;

/**
 * Turns a joining client away with a login disconnect, as vanilla does when it
 * refuses a login straight after the handshake. It first reads what the Worker
 * replays of the client's first packets: the Worker passes nothing back to the
 * client until that is through, so a reply sent before it would be lost.
 */
export async function refuse(socket: Socket, reason: string): Promise<void> {
	const reader = socket.readable.getReader();
	const writer = socket.writable.getWriter();
	const timer = setTimeout(() => reader.cancel().catch(() => {}), REFUSAL_WAIT_MS);
	try {
		await reader.read();
		await writer.write(loginDisconnect({ text: reason }));
	} catch {
		// The client is gone already.
	} finally {
		clearTimeout(timer);
	}
}

/** The defaults, the same as in wrangler.jsonc, for a config that leaves a variable out. */
const DEFAULTS = { MAX_CONNECTIONS_PER_ADDRESS: "10", JOINS_PER_ADDRESS: "20/60", PINGS_PER_ADDRESS: "120/60" };
const REPORT_EVERY_MS = 60_000;

/** The world's side: counts connections and attempts per client key. */
export class AddressLimits {
	private readonly maxConnections: number;
	private readonly joins?: RateLimiter;
	private readonly pings?: RateLimiter;
	private open = new Map<string, number>();
	private refusedJoins = 0;
	private refusedPings = 0;
	private reportedAt = -Infinity;
	private warnedUnknown = false;

	constructor(env: LimitSettings) {
		const max = Number(env.MAX_CONNECTIONS_PER_ADDRESS ?? DEFAULTS.MAX_CONNECTIONS_PER_ADDRESS);
		this.maxConnections = Number.isFinite(max) && max > 0 ? Math.floor(max) : Infinity;
		const joins = parseRate(env.JOINS_PER_ADDRESS ?? DEFAULTS.JOINS_PER_ADDRESS);
		const pings = parseRate(env.PINGS_PER_ADDRESS ?? DEFAULTS.PINGS_PER_ADDRESS);
		if (joins) this.joins = new RateLimiter(joins);
		if (pings) this.pings = new RateLimiter(pings);
	}

	/**
	 * A client wants to join. Returns why not, or undefined after counting the
	 * connection, which must then be given back with closed().
	 */
	join(key: string | undefined, now = Date.now()): string | undefined {
		if (key === undefined) {
			this.warnUnknown();
			return undefined;
		}
		const open = this.open.get(key) ?? 0;
		if (open >= this.maxConnections) {
			this.refused("join", now);
			return `There are already ${this.maxConnections} connections from your address. Try again once one of them has left.`;
		}
		const wait = this.joins?.take(key, now) ?? 0;
		if (wait > 0) {
			this.refused("join", now);
			const seconds = Math.ceil(wait / 1000);
			return `Too many connections from your address in a short time. Try again in ${seconds} second${seconds === 1 ? "" : "s"}.`;
		}
		this.open.set(key, open + 1);
		return undefined;
	}

	/** A connection join() let in has ended. */
	closed(key: string | undefined): void {
		if (key === undefined) return;
		const open = (this.open.get(key) ?? 0) - 1;
		if (open > 0) this.open.set(key, open);
		else this.open.delete(key);
	}

	/** A client asks for the server list status. False if it should get no answer. */
	ping(key: string | undefined, now = Date.now()): boolean {
		if (key === undefined || !this.pings) return true;
		if (this.pings.take(key, now) === 0) return true;
		this.refused("ping", now);
		return false;
	}

	/** Logs how many were refused, at most once a minute and without saying who. */
	private refused(kind: "join" | "ping", now: number): void {
		if (kind === "join") this.refusedJoins++;
		else this.refusedPings++;
		if (now - this.reportedAt < REPORT_EVERY_MS) return;
		console.log(`Per-address limits: refused ${this.refusedJoins} join(s) and ${this.refusedPings} ping(s) since the last report`);
		this.refusedJoins = this.refusedPings = 0;
		this.reportedAt = now;
	}

	private warnUnknown(): void {
		if (this.warnedUnknown) return;
		this.warnedUnknown = true;
		console.warn("A player connected without a known client address; the per-address limits do not apply to such connections.");
	}
}
