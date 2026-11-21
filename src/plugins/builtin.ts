// The server's own commands, written against the same API plugins get.

import type { Hooks } from "./api";

export const SPAWN = { x: 0.5, y: -60, z: 0.5 };

export const builtin: Hooks = {
	async onCommand({ player, command, args }, server) {
		switch (command) {
			case "spawn":
				await server.teleport(player.name, SPAWN.x, SPAWN.y, SPAWN.z);
				return true;
			case "list": {
				const players = await server.players();
				await server.message(player.name, { text: `${players.length} online: ${players.map((p) => p.name).join(", ")}`, color: "gray" });
				return true;
			}
			case "tp": {
				const [x, y, z] = args.map(Number);
				if (args.length !== 3 || [x, y, z].some((n) => !Number.isFinite(n))) {
					await server.message(player.name, { text: "Usage: /tp <x> <y> <z>", color: "red" });
				} else {
					await server.teleport(player.name, x!, y!, z!);
				}
				return true;
			}
			case "help":
				await server.message(player.name, { text: "Commands: /spawn, /list, /tp <x> <y> <z>", color: "gray" });
				return true;
		}
	},
};
