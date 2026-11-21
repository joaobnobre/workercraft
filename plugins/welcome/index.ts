// Greets players and adds a /hello command.

import { definePlugin } from "../../sdk/plugin";

export default definePlugin({
	async onJoin({ player }, server) {
		await server.message(player.name, {
			text: "",
			extra: [
				{ text: `Welcome, ${player.name}! `, color: "gold" },
				{ text: "This world is a Durable Object and this message came from a plugin Worker.", color: "gray" },
			],
		});
	},

	async onCommand({ player, command }, server) {
		if (command !== "hello") return false;
		const online = await server.players();
		await server.broadcast({ text: `${player.name} says hello to all ${online.length} of you.`, color: "aqua" });
		return true;
	},
});
