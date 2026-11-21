// /sphere <block> [radius]: a hollow sphere around the player.
// Each block is one RPC call back into the world's Durable Object.

import { definePlugin } from "../../sdk/plugin";

const MAX_RADIUS = 8;

export default definePlugin({
	async onCommand({ player, command, args }, server) {
		if (command !== "sphere") return false;
		const block = args[0] ?? "glass";
		const radius = Math.min(Math.max(Math.floor(Number(args[1] ?? 4)) || 4, 2), MAX_RADIUS);
		const cx = Math.floor(player.x);
		const cy = Math.floor(player.y) + radius;
		const cz = Math.floor(player.z);

		const placing: Promise<boolean>[] = [];
		for (let dx = -radius; dx <= radius; dx++) {
			for (let dy = -radius; dy <= radius; dy++) {
				for (let dz = -radius; dz <= radius; dz++) {
					const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
					if (distance <= radius && distance > radius - 1) placing.push(server.setBlock(cx + dx, cy + dy, cz + dz, block));
				}
			}
		}
		const placed = (await Promise.all(placing)).filter(Boolean).length;
		await server.message(
			player.name,
			placed > 0 ? { text: `Built a ${block} sphere out of ${placed} blocks.`, color: "green" } : { text: `Unknown block "${block}".`, color: "red" },
		);
		return true;
	},
});
