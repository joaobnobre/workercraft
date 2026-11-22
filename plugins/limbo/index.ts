// A queue. Everyone on this server is waiting in line, in the order they
// joined, and sees their place above the hotbar. Every ADMIT_EVERY_SECONDS
// the first in line gets a signed ticket as a cookie (see ../gate/ticket.ts)
// and is transferred to DESTINATION, which checks the ticket (plugins/gate,
// or a plugin on a vanilla or Paper server with accepts-transfers=true).
//
// It keeps no state of its own: the line is the world's player list, which is
// in order of joining, and the timer's count says when the next turn is.
// Building is switched off; this is a waiting room.
//
// Env: QUEUE_SECRET (shared with the destination), DESTINATION ("host:port").
// Optional: ADMIT_EVERY_SECONDS (5), TICKET_TTL_SECONDS (60).

import { definePlugin, type Server } from "../../sdk/plugin";
import { TICKET_KEY, issueTicket } from "../gate/ticket";

interface Env {
	QUEUE_SECRET?: string;
	DESTINATION?: string;
	ADMIT_EVERY_SECONDS?: string;
	TICKET_TTL_SECONDS?: string;
}

function destination(env: Env): { host: string; port: number } {
	const match = /^(.+):(\d{1,5})$/.exec(env.DESTINATION ?? "");
	if (!match) throw new Error(`DESTINATION must be "host:port", not "${env.DESTINATION ?? ""}"`);
	return { host: match[1]!, port: Number(match[2]) };
}

export default definePlugin<Env>((env) => {
	const every = Math.max(1, Math.floor(Number(env.ADMIT_EVERY_SECONDS ?? 5)) || 5);
	const ttl = Math.max(5, Math.floor(Number(env.TICKET_TTL_SECONDS ?? 60)) || 60);

	async function admit(name: string, server: Server): Promise<void> {
		const { host, port } = destination(env);
		await server.storeCookie(name, TICKET_KEY, await issueTicket(env.QUEUE_SECRET ?? "", name, ttl));
		await server.transfer(name, host, port);
	}

	const cancel = { cancel: true };

	return {
		async onJoin({ player }, server) {
			await server.message(player.name, { text: "You are in the queue. Your place in line is shown above your hotbar.", color: "gold" });
		},

		async onTimer({ count }, server) {
			const line = await server.players();
			const turnNow = count % every === 0;
			const next = every - (count % every);
			if (turnNow && line[0]) {
				await admit(line[0].name, server);
				line.shift();
			}
			await Promise.all(
				line.map((player, index) =>
					server.actionBar(player.name, {
						text: "",
						extra: [
							{ text: `Place in queue: ${index + 1} of ${line.length}`, color: "gold" },
							{ text: index === 0 ? `  ·  your turn in ${turnNow ? every : next} s` : "", color: "gray" },
						],
					}),
				),
			);
		},

		onBlockBreak: () => cancel,
		onBlockPlace: () => cancel,
	};
});
