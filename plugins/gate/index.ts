// The destination side of the queue (see plugins/limbo): lets in only players
// who arrive by transfer carrying a valid queue ticket (see ./ticket.ts).
//
// Everyone else is turned away before they appear in the world. If this
// plugin is down or slow, the world turns players away too (onLogin fails
// closed, see src/plugins/api.ts).
//
// Env: QUEUE_SECRET, the same secret the limbo signs with. Optional:
// QUEUE_ADDRESS, the limbo's address, named in the message to those turned
// away.

import { definePlugin, type Text } from "../../sdk/plugin";
import { TICKET_KEY, checkTicket } from "./ticket";

interface Env {
	QUEUE_SECRET?: string;
	QUEUE_ADDRESS?: string;
}

export default definePlugin<Env>((env) => {
	const refuse = (why: string): { cancel: true; reason: Text } => ({
		cancel: true,
		reason: {
			text: "",
			extra: [
				{ text: `${why}\n\n`, color: "red" },
				{ text: env.QUEUE_ADDRESS ? `Join the queue at ${env.QUEUE_ADDRESS} first.` : "Join through the queue first.", color: "gray" },
			],
		},
	});

	return {
		async onLogin({ name, transferred }, server) {
			if (!env.QUEUE_SECRET) throw new Error("QUEUE_SECRET is not set"); // which turns everyone away
			// Only a transferred client can carry a cookie from another server.
			if (!transferred) return refuse("This server is only reachable through its queue.");
			// This rejects when the game does not answer in time. Letting that throw
			// turns the player away, since onLogin fails closed.
			const ticket = await server.requestCookie(name, TICKET_KEY);
			if (!ticket) return refuse("You have no queue ticket.");
			const check = await checkTicket(env.QUEUE_SECRET, name, ticket);
			if (check === "expired") return refuse("Your queue ticket has expired.");
			if (check !== "ok") return refuse("Your queue ticket is not valid.");
		},
	};
});
