// Spawn protection: nobody can build or break near where players arrive.

import { definePlugin, type BlockEvent, type Server } from "../../sdk/plugin";

const RADIUS = 6;

async function guard({ player, x, z }: BlockEvent, server: Server) {
	if (Math.abs(x) > RADIUS || Math.abs(z) > RADIUS) return;
	await server.message(player.name, { text: "Spawn is protected. Walk a few blocks away to build.", color: "red" });
	return { cancel: true };
}

export default definePlugin({ onBlockBreak: guard, onBlockPlace: guard });
