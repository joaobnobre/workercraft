// Who a client is, for the per-address limits (world/limits.ts).
//
// Spectrum gives the Worker the client's address (`socket.opened`). The Worker
// turns it into a key: the address without its port, or for IPv6 the /64 it
// belongs to, hashed. It hands the key to the world in the address it passes to
// the world's connect(), which the world reads back from its side of the
// socket, so nothing the client sends can end up there. The address itself
// goes no further than the Worker.
//
// No imports, so the tests can load this file as it is.

/** The address the Worker connects to when it does not know the client's address. */
export const UNKNOWN_CLIENT_TARGET = "world:25565";

const KEY_PREFIX = "client-";
const KEY_PATTERN = /^client-([0-9a-f]{32}):\d+$/;

/** For the Worker: the address to connect to the world at, for the client with this key. */
export function worldTarget(key: string | undefined): string {
	return key === undefined ? UNKNOWN_CLIENT_TARGET : `${KEY_PREFIX}${key}:25565`;
}

/** For the world: the client key in the address the Worker connected to, if there is one. */
export function keyFromTarget(localAddress: string | undefined): string | undefined {
	return localAddress === undefined ? undefined : KEY_PATTERN.exec(localAddress)?.[1];
}

/**
 * What one client is counted as: an IPv4 address, or the /64 an IPv6 address
 * is in (one customer usually holds a whole /64), hashed. Undefined when the
 * address is missing or unreadable.
 */
export async function clientKey(remoteAddress: string | undefined): Promise<string | undefined> {
	const network = addressNetwork(remoteAddress);
	if (network === undefined) return undefined;
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`workercraft client ${network}`));
	return [...new Uint8Array(digest, 0, 16)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * "203.0.113.7:12345" gives "203.0.113.7", "[2001:db8:1:2:3:4:5:6]:12345"
 * gives "2001:db8:1:2::/64", and an IPv4 address written as IPv6
 * ("[::ffff:203.0.113.7]:1") the IPv4 address.
 */
export function addressNetwork(address: string | undefined): string | undefined {
	if (!address) return undefined;
	let host = address.trim();
	const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(host);
	if (bracketed) host = bracketed[1]!;
	else if (/^[\d.]+:\d+$/.test(host)) host = host.slice(0, host.lastIndexOf(":"));
	host = host.replace(/%.*$/, ""); // an IPv6 zone, as in fe80::1%eth0

	if (isIpv4(host)) return host;
	const groups = ipv6Groups(host);
	if (!groups) return undefined;
	if (groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff) {
		return `${groups[6]! >> 8}.${groups[6]! & 0xff}.${groups[7]! >> 8}.${groups[7]! & 0xff}`;
	}
	return `${groups
		.slice(0, 4)
		.map((g) => g.toString(16))
		.join(":")}::/64`;
}

function isIpv4(host: string): boolean {
	const parts = host.split(".");
	return parts.length === 4 && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

/** The eight 16-bit groups of an IPv6 address, or undefined if it is not one. */
function ipv6Groups(host: string): number[] | undefined {
	const halves = host.split("::");
	if (halves.length > 2) return undefined;
	const parse = (half: string): number[] | undefined => {
		if (half === "") return [];
		const groups: number[] = [];
		const parts = half.split(":");
		for (const [i, part] of parts.entries()) {
			if (i === parts.length - 1 && isIpv4(part)) {
				const [a, b, c, d] = part.split(".").map(Number) as [number, number, number, number];
				groups.push((a << 8) | b, (c << 8) | d);
			} else if (/^[0-9a-fA-F]{1,4}$/.test(part)) groups.push(parseInt(part, 16));
			else return undefined;
		}
		return groups;
	};
	const head = parse(halves[0]!);
	const tail = halves.length === 2 ? parse(halves[1]!) : [];
	if (!head || !tail) return undefined;
	if (halves.length === 1) return head.length === 8 ? head : undefined;
	if (head.length + tail.length > 7) return undefined;
	return [...head, ...new Array<number>(8 - head.length - tail.length).fill(0), ...tail];
}
