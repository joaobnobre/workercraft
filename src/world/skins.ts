// Player identity for an "offline mode" server: the server does not verify the
// account, so the UUID is derived from the name and the skin is looked up by
// name on a best-effort basis.
//
// A skin travels as a "textures" property signed by Mojang, and the game
// checks that signature itself. So it does not matter who hands the property
// over: a source can fail to have a skin, but it cannot make one up.

import { bytesToUuid } from "../net/bytes";
import type { ProfileProperty } from "../protocol/packets";

/** The UUID vanilla gives an unverified player: MD5 of "OfflinePlayer:<name>" as a version 3 UUID. */
export async function offlineUuid(name: string): Promise<Uint8Array> {
	const digest = new Uint8Array(await crypto.subtle.digest("MD5", new TextEncoder().encode(`OfflinePlayer:${name}`)));
	digest[6] = (digest[6]! & 0x0f) | 0x30;
	digest[8] = (digest[8]! & 0x3f) | 0x80;
	return digest;
}

const SKIN_TTL_MS = 6 * 60 * 60 * 1000;
/** "No skin" is remembered only briefly, because it may just mean nobody could be asked. */
const NO_SKIN_TTL_MS = 10 * 60 * 1000;
const LOOKUP_TIMEOUT_MS = 1500;

interface Profile {
	id?: string;
	name?: string;
	properties?: ProfileProperty[];
}

/** A source's answer: the skin, "this name has no account", or undefined when it could not say. */
type Answer = ProfileProperty[] | "no such player" | undefined;

/** What each request of one lookup came to, for the log. */
type Trace = string[];

async function request(url: string, trace: Trace): Promise<{ status: number; json: unknown }> {
	const started = Date.now();
	const host = new URL(url).host;
	let response: Response;
	try {
		response = await fetch(url, {
			signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
			headers: { Accept: "application/json", "User-Agent": "workercraft (Minecraft server, skin lookup)" },
		});
	} catch (error) {
		trace.push(`${host} failed after ${Date.now() - started} ms (${error})`);
		throw error;
	}
	trace.push(`${host} ${response.status} in ${Date.now() - started} ms`);
	let json: unknown;
	try {
		json = await response.json();
	} catch {
		// An error page, or an empty body. The status says enough.
	}
	return { status: response.status, json };
}

/** The signed skin in a profile, provided the profile really is this player's. */
function texturesOf(profile: Profile | undefined, name: string): ProfileProperty[] | undefined {
	if (profile?.name?.toLowerCase() !== name.toLowerCase()) return undefined;
	return (profile.properties ?? [])
		.filter((property) => property.name === "textures" && typeof property.value === "string" && typeof property.signature === "string")
		.map(({ name: propertyName, value, signature }) => ({ name: propertyName, value, signature }));
}

/** Mojang itself. The UUID the client claims is tried first because it saves a lookup by name. */
async function fromMojang(name: string, claimedUuid: Uint8Array, trace: Trace): Promise<Answer> {
	const session = (id: string) => request(`https://sessionserver.mojang.com/session/minecraft/profile/${id}?unsigned=false`, trace);
	const claimed = await session(bytesToUuid(claimedUuid));
	const direct = claimed.status === 200 ? texturesOf(claimed.json as Profile, name) : undefined;
	if (direct) return direct;

	const byName = await request(`https://api.mojang.com/users/profiles/minecraft/${encodeURIComponent(name)}`, trace);
	if (byName.status === 404 || byName.status === 204) return "no such player";
	const id = byName.status === 200 ? (byName.json as Profile | undefined)?.id : undefined;
	if (!id) return undefined; // blocked, rate limited or down
	const profile = await session(id);
	return profile.status === 200 ? texturesOf(profile.json as Profile, name) : undefined;
}

/** playerdb.co, a public cache of Mojang profiles. */
async function fromPlayerDb(name: string, trace: Trace): Promise<Answer> {
	const { status, json } = await request(`https://playerdb.co/api/player/minecraft/${encodeURIComponent(name)}`, trace);
	const body = json as { code?: string; data?: { player?: { username?: string; properties?: ProfileProperty[] } } } | undefined;
	if (body?.code === "minecraft.invalid_username") return "no such player";
	const player = status === 200 ? body?.data?.player : undefined;
	return texturesOf(player && { name: player.username, properties: player.properties }, name);
}

/** minetools.eu, another one. */
async function fromMineTools(name: string, trace: Trace): Promise<Answer> {
	const found = (await request(`https://api.minetools.eu/uuid/${encodeURIComponent(name)}`, trace)).json as { id?: string; status?: string } | undefined;
	if (found?.status !== "OK" || !found.id) return undefined;
	const profile = (await request(`https://api.minetools.eu/profile/${found.id}`, trace)).json as { raw?: Profile } | undefined;
	return texturesOf(profile?.raw, name);
}

export class SkinCache {
	constructor(private sql: SqlStorage) {
		sql.exec("CREATE TABLE IF NOT EXISTS skins (name TEXT PRIMARY KEY, properties TEXT NOT NULL, fetched_at INTEGER NOT NULL)");
	}

	/**
	 * The signed skin of the real account with this name, or nothing.
	 *
	 * Mojang is asked first. It turns away requests from some networks,
	 * Cloudflare's among them, so when it gives no answer two public caches of
	 * its profiles are asked instead.
	 */
	async lookup(name: string, claimedUuid: Uint8Array): Promise<ProfileProperty[]> {
		const key = name.toLowerCase();
		const cached = this.sql.exec<{ properties: string; fetched_at: number }>("SELECT properties, fetched_at FROM skins WHERE name = ?", key).toArray()[0];
		const cachedSkin = cached ? (JSON.parse(cached.properties) as ProfileProperty[]) : undefined;
		if (cached && cachedSkin && Date.now() - cached.fetched_at < (cachedSkin.length > 0 ? SKIN_TTL_MS : NO_SKIN_TTL_MS)) return cachedSkin;

		let answer: Answer;
		const trace: Trace = [];
		for (const source of [() => fromMojang(name, claimedUuid, trace), () => fromPlayerDb(name, trace), () => fromMineTools(name, trace)]) {
			try {
				answer = await source();
			} catch {
				// Slow or unreachable: on to the next one.
			}
			if (answer !== undefined) break;
		}
		console.log(`Skin of ${name}: ${Array.isArray(answer) ? (answer.length > 0 ? "found" : "none") : (answer ?? "nobody could say")}. ${trace.join("; ")}`);
		// Nobody could say: keep showing the last skin that was seen, if any.
		if (answer === undefined && cachedSkin && cachedSkin.length > 0) return cachedSkin;
		const properties = Array.isArray(answer) ? answer : [];
		this.sql.exec("INSERT OR REPLACE INTO skins (name, properties, fetched_at) VALUES (?, ?, ?)", key, JSON.stringify(properties), Date.now());
		return properties;
	}
}
