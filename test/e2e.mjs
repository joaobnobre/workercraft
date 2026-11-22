// End-to-end test: real protocol clients (mineflayer bots) against a running
// server. The bots speak Minecraft 26.1, so the server has to be built for
// that version: start it with `npm run dev:26.1`, then `npm run test:bots`.
// (test/conformance.mjs is the test for the version the server normally runs.)
//
// The bots parse every packet with the protocol definitions for this game
// version, so a malformed packet fails the run, not just a wrong value.

import { once } from "node:events";
import { createRequire } from "node:module";
import { devInstance } from "../scripts/instance.mjs";

const require = createRequire(import.meta.url);
const mineflayer = require("mineflayer");
const mc = require("minecraft-protocol");
const { Vec3 } = require("vec3");

const host = process.env.HOST ?? "127.0.0.1";
const port = Number(process.env.PORT ?? devInstance().gamePort);
const version = process.env.MC_VERSION ?? "26.1";

let failures = 0;
function check(label, ok, detail = "") {
	console.log(`${ok ? "ok  " : "FAIL"} ${label}${detail ? `  (${detail})` : ""}`);
	if (!ok) failures++;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Polls until fn() returns something truthy, or gives up and returns undefined. */
async function until(fn, timeoutMs = 5000) {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const value = fn();
		if (value) return value;
		if (Date.now() > deadline) return undefined;
		await sleep(50);
	}
}

async function join(username) {
	const bot = mineflayer.createBot({ host, port, username, auth: "offline", version, checkTimeoutInterval: 60_000 });
	bot.messages = [];
	bot.errors = [];
	bot.on("messagestr", (message) => bot.messages.push(message));
	bot.on("error", (error) => bot.errors.push(error.message));
	bot.on("kicked", (reason) => bot.errors.push(`kicked: ${JSON.stringify(reason)}`));
	await Promise.race([once(bot, "spawn"), sleep(10_000).then(() => Promise.reject(new Error(`${username} did not spawn: ${bot.errors.join("; ")}`)))]);
	return bot;
}

const sawMessage = (bot, text) => until(() => bot.messages.find((message) => message.includes(text)));

async function main() {
	// A fresh spot each run, because the world remembers earlier runs.
	const baseX = 1000 + Math.floor(Math.random() * 100_000);
	const baseZ = 1000 + Math.floor(Math.random() * 100_000);
	const suffix = Math.random().toString(36).slice(2, 6);
	const nameA = `alice_${suffix}`;
	const nameB = `bob_${suffix}`;

	// ---- server list ping ----
	const before = await mc.ping({ host, port, version });
	check("server list ping answers", before.version?.protocol > 0, `${before.version?.name}, ${before.players?.online} online`);

	// ---- joining ----
	const alice = await join(nameA);
	check("first player spawns", true, `at ${alice.entity.position}`);
	check("game mode is creative", alice.game.gameMode === "creative", alice.game.gameMode);

	// ---- plugins (separate Workers, reached over RPC) ----
	check("welcome plugin greets on join", Boolean(await sawMessage(alice, `Welcome, ${nameA}!`)), alice.messages.at(-1));
	const protectedBlock = new Vec3(2, -61, 2);
	await until(() => alice.blockAt(protectedBlock));
	alice._client.write("block_dig", { status: 0, location: protectedBlock, face: 1, sequence: 90 });
	check("guard plugin explains the refusal", Boolean(await sawMessage(alice, "Spawn is protected")), alice.messages.at(-1));
	check("guard plugin cancels breaking near spawn", alice.blockAt(protectedBlock)?.name === "grass_block", alice.blockAt(protectedBlock)?.name);

	alice.chat(`/tp ${baseX}.5 -60 ${baseZ}.5`);
	const arrived = await until(() => Math.abs(alice.entity.position.x - (baseX + 0.5)) < 0.01 && alice.entity.position);
	check("/tp moves the player", Boolean(arrived), `${alice.entity.position}`);

	const ground = await until(() => alice.blockAt(new Vec3(baseX, -61, baseZ)));
	check("chunks decode: ground is grass", ground?.name === "grass_block", ground?.name);
	check("chunks decode: bedrock at the bottom", alice.blockAt(new Vec3(baseX, -64, baseZ))?.name === "bedrock");
	check("chunks decode: air above ground", alice.blockAt(new Vec3(baseX, -60, baseZ))?.name === "air");
	check("player lands on the ground", Boolean(await until(() => alice.entity.onGround)), `y=${alice.entity.position.y}`);

	const bob = await join(nameB);
	check("second player spawns", true);
	check("first player is told about the join", Boolean(await sawMessage(alice, `${nameB} joined`)), alice.messages.at(-1));
	check("ping counts both players", (await mc.ping({ host, port, version })).players.online >= 2);

	bob.chat(`/tp ${baseX + 2}.5 -60 ${baseZ}.5`);
	await until(() => Math.abs(bob.entity.position.x - (baseX + 2.5)) < 0.01);

	// ---- seeing each other ----
	const bobSeenByAlice = await until(() => alice.players[nameB]?.entity);
	const aliceSeenByBob = await until(() => bob.players[nameA]?.entity);
	check("players see each other", Boolean(bobSeenByAlice && aliceSeenByBob));

	const startX = bobSeenByAlice?.position.x;
	bob.setControlState("forward", true);
	await sleep(700);
	bob.setControlState("forward", false);
	const movedInAlicesView = await until(() => bobSeenByAlice && Math.abs(bobSeenByAlice.position.z - bob.entity.position.z) < 0.5 && bobSeenByAlice.position.distanceTo(new Vec3(startX, -60, baseZ + 0.5)) > 0.5);
	check("movement reaches other players", Boolean(movedInAlicesView), `bob at ${bob.entity.position}, alice sees ${bobSeenByAlice?.position}`);

	// ---- chat and commands ----
	bob.chat("hello from a durable object");
	check("chat reaches other players", Boolean(await sawMessage(alice, `<${nameB}> hello from a durable object`)), alice.messages.at(-1));
	alice.chat("/list");
	check("/list answers", Boolean(await sawMessage(alice, "online:")), alice.messages.at(-1));
	alice.chat("/definitely_not_a_command");
	check("unknown command is reported", Boolean(await sawMessage(alice, "Unknown")), alice.messages.at(-1));

	// ---- blocks ----
	const broken = new Vec3(baseX + 1, -61, baseZ);
	alice._client.write("block_dig", { status: 0, location: broken, face: 1, sequence: 1 });
	check("breaking a block reaches other players", Boolean(await until(() => bob.blockAt(broken)?.name === "air")), bob.blockAt(broken)?.name);
	check("breaking a block is confirmed to the breaker", Boolean(await until(() => alice.blockAt(broken)?.name === "air")));

	const Item = require("prismarine-item")(alice.registry);
	const stone = alice.registry.itemsByName.stone;
	alice._client.write("set_creative_slot", { slot: 36, item: Item.toNotch(new Item(stone.id, 1)) });
	alice.setQuickBarSlot(0);
	const placed = new Vec3(baseX, -60, baseZ + 1);
	alice._client.write("block_place", {
		hand: 0,
		location: placed.offset(0, -1, 0),
		direction: 1,
		cursorX: 0.5,
		cursorY: 1,
		cursorZ: 0.5,
		insideBlock: false,
		worldBorderHit: false,
		sequence: 2,
	});
	const placeSounds = [];
	const onPlaceSound = (packet) => placeSounds.push(packet);
	bob._client.on("sound_effect", onPlaceSound);
	check("placing a block reaches other players", Boolean(await until(() => bob.blockAt(placed)?.name === "stone")), bob.blockAt(placed)?.name);
	check("other players hear a block being placed", Boolean(await until(() => placeSounds.length > 0, 2000)), JSON.stringify(placeSounds[0]));
	bob._client.off("sound_effect", onPlaceSound);

	const far = new Vec3(baseX + 40, -61, baseZ);
	alice._client.write("block_dig", { status: 0, location: far, face: 1, sequence: 3 });
	await sleep(500);
	check("blocks out of reach cannot be broken", bob.blockAt(far)?.name !== "air", bob.blockAt(far)?.name);

	// ---- items ----
	bob._client.write("pick_item_from_block", { position: new Vec3(baseX + 5, -61, baseZ + 5), includeData: false });
	check("middle click gives the block's item", Boolean(await until(() => bob.inventory.slots[36]?.name === "grass_block")), bob.inventory.slots[36]?.name);

	const isDroppedItem = (entity) => entity.name === "item";
	await alice.look(0, -Math.PI / 2, true); // straight down, so the item lands at her feet
	await sleep(200);
	let aliceGotItBack = false;
	alice.inventory.on("updateSlot", (slot, _old, item) => (aliceGotItBack ||= item?.name === "stone"));
	alice._client.write("block_dig", { status: 4, location: new Vec3(0, 0, 0), face: 0, sequence: 4 });
	// Items dropped earlier lie around too (they are saved), so look for the one at her feet.
	const atAlicesFeet = (entity) => isDroppedItem(entity) && entity.position.distanceTo(alice.entity.position) < 3;
	const seenByBob = await until(() => Object.values(bob.entities).find(atAlicesFeet));
	check("a dropped item appears for other players", Boolean(seenByBob), seenByBob && `${seenByBob.position}`);
	check("the item can be picked up again", Boolean(await until(() => aliceGotItBack, 6000)));
	check("a picked-up item disappears for other players", Boolean(seenByBob && (await until(() => !bob.entities[seenByBob.id]))));

	// ---- building like vanilla ----
	// Alice stands at (baseX, baseZ) and looks north. Everything is built on the
	// ground around her, within reach.
	const FACE = { down: 0, up: 1, north: 2, south: 3, west: 4, east: 5 };
	let sequence = 100;
	const hold = async (bot, name) => {
		bot._client.write("set_creative_slot", { slot: 37, item: Item.toNotch(new Item(bot.registry.itemsByName[name].id, 1)) });
		bot.setQuickBarSlot(1);
		await sleep(60);
	};
	const click = (bot, at, face, cursor = {}) =>
		bot._client.write("block_place", {
			hand: 0,
			location: at,
			direction: FACE[face],
			cursorX: cursor.x ?? 0.5,
			cursorY: cursor.y ?? (face === "up" ? 1 : 0.5),
			cursorZ: cursor.z ?? 0.5,
			insideBlock: false,
			worldBorderHit: false,
			sequence: sequence++,
		});
	const groundAt = (dx, dz) => new Vec3(baseX + dx, -61, baseZ + dz);
	const above = (dx, dz, dy = 0) => new Vec3(baseX + dx, -60 + dy, baseZ + dz);
	/** Polls until the block bob sees at `at` is `name` with these properties. */
	const sees = async (at, name, properties = {}) => {
		const matches = () => {
			const block = bob.blockAt(at);
			const actual = block?.getProperties() ?? {};
			return block?.name === name && Object.entries(properties).every(([key, value]) => String(actual[key]) === String(value));
		};
		await until(matches, 3000);
		const block = bob.blockAt(at);
		return [matches(), `${block?.name} ${JSON.stringify(block?.getProperties())}`];
	};

	await alice.look(0, 0, true); // north
	await sleep(250);

	await hold(alice, "oak_log");
	click(alice, placed, "east");
	check("a log lies along the face it was placed on", ...(await sees(placed.offset(1, 0, 0), "oak_log", { axis: "x" })));

	await hold(alice, "oak_stairs");
	click(alice, groundAt(-2, -2), "up");
	check("stairs face the way the player looks", ...(await sees(above(-2, -2), "oak_stairs", { facing: "north", half: "bottom", shape: "straight" })));
	await alice.look(Math.PI / 2, 0, true); // west
	await sleep(250);
	click(alice, groundAt(-2, -3), "up");
	check("stairs turn into a corner next to another stair", ...(await sees(above(-2, -2), "oak_stairs", { shape: "outer_left" })));
	click(alice, above(-2, -3), "west", { y: 0.8 });
	check("stairs placed on the upper half of a side are upside down", ...(await sees(above(-3, -3), "oak_stairs", { half: "top" })));
	await alice.look(0, 0, true);
	await sleep(250);

	bob._client.write("pick_item_from_block", { position: above(-2, -2), includeData: false });
	check("middle click works on a block that is not in its default state", Boolean(await until(() => bob.heldItem?.name === "oak_stairs")), bob.heldItem?.name);

	await hold(alice, "oak_slab");
	click(alice, groundAt(2, -2), "up");
	check("a slab starts as a bottom slab", ...(await sees(above(2, -2), "oak_slab", { type: "bottom" })));
	click(alice, above(2, -2), "up");
	check("a second slab makes a double slab", ...(await sees(above(2, -2), "oak_slab", { type: "double" })));
	click(alice, above(2, -2), "east", { y: 0.8 });
	check("a slab placed on the upper half of a side is a top slab", ...(await sees(above(3, -2), "oak_slab", { type: "top" })));

	await hold(alice, "oak_fence");
	click(alice, groundAt(2, 2), "up");
	click(alice, groundAt(3, 2), "up");
	check("fences connect to each other", ...(await sees(above(2, 2), "oak_fence", { east: true, west: false })));
	alice._client.write("block_dig", { status: 0, location: above(3, 2), face: 1, sequence: sequence++ });
	check("fences disconnect when the neighbour is broken", ...(await sees(above(2, 2), "oak_fence", { east: false })));

	// A torch on the side of a block, which falls off when the block goes.
	await hold(alice, "stone");
	click(alice, groundAt(-2, 2), "up");
	await sees(above(-2, 2), "stone");
	await hold(alice, "torch");
	click(alice, above(-2, 2), "west");
	check("a torch on the side of a block is a wall torch", ...(await sees(above(-3, 2), "wall_torch", { facing: "west" })));
	click(alice, above(-2, 2), "up");
	check("a torch on top of a block stands", ...(await sees(above(-2, 2, 1), "torch")));
	alice._client.write("block_dig", { status: 0, location: above(-2, 2), face: 1, sequence: sequence++ });
	check("torches fall off when their block is broken", (await sees(above(-3, 2), "air"))[0] && (await sees(above(-2, 2, 1), "air"))[0]);

	// Doors are two blocks, open on a click, and break as one.
	await hold(alice, "oak_door");
	click(alice, groundAt(0, -3), "up");
	check("a door has a lower half", ...(await sees(above(0, -3), "oak_door", { half: "lower", facing: "north", open: false })));
	check("a door has an upper half", ...(await sees(above(0, -3, 1), "oak_door", { half: "upper", facing: "north" })));
	const sounds = [];
	bob._client.on("sound_effect", (packet) => sounds.push(packet));
	click(alice, above(0, -3), "south");
	check("clicking a door opens both halves", (await sees(above(0, -3), "oak_door", { open: true }))[0] && (await sees(above(0, -3, 1), "oak_door", { open: true }))[0]);
	check("other players hear the door", Boolean(await until(() => sounds.length > 0, 2000)), `${sounds.length} sound(s)`);
	alice._client.write("block_dig", { status: 0, location: above(0, -3), face: 1, sequence: sequence++ });
	check("breaking a door removes both halves", (await sees(above(0, -3), "air"))[0] && (await sees(above(0, -3, 1), "air"))[0]);

	await hold(alice, "lever");
	click(alice, groundAt(1, -3), "up");
	check("a lever attaches to the floor", ...(await sees(above(1, -3), "lever", { face: "floor", powered: false })));
	click(alice, above(1, -3), "up");
	check("a lever flips when clicked", ...(await sees(above(1, -3), "lever", { powered: true })));

	await hold(alice, "stone_button");
	click(alice, groundAt(-1, -3), "up");
	await sees(above(-1, -3), "stone_button", { powered: false });
	click(alice, above(-1, -3), "up");
	check("a button is pressed by a click", ...(await sees(above(-1, -3), "stone_button", { powered: true })));
	check("a button pops back out by itself", ...(await sees(above(-1, -3), "stone_button", { powered: false })));

	await hold(alice, "chest");
	click(alice, groundAt(4, 0), "up");
	check("a chest faces the player", ...(await sees(above(4, 0), "chest", { facing: "south" })));

	// Signs: placing one opens the editor, and the text reaches everyone.
	const signPosition = above(-4, 0);
	const editorOpened = once(alice._client, "open_sign_entity");
	await hold(alice, "oak_sign");
	click(alice, groundAt(-4, 0), "up");
	check("a sign stands facing the player", ...(await sees(signPosition, "oak_sign", { rotation: 0 })));
	const [opened] = await Promise.race([editorOpened, sleep(3000).then(() => [undefined])]);
	check("placing a sign opens its editor", opened?.location.x === signPosition.x && opened?.isFrontText === true, JSON.stringify(opened));
	alice._client.write("update_sign", { location: signPosition, isFrontText: true, text1: "hello sign", text2: "", text3: "line three", text4: "" });
	const signText = (bot) => JSON.stringify(bot.blockAt(signPosition)?.blockEntity ?? null);
	check("sign text reaches other players", Boolean(await until(() => signText(bob).includes("hello sign") && signText(bob).includes("line three"))), signText(bob));
	click(alice, signPosition, "south");
	const [reopened] = await Promise.race([once(alice._client, "open_sign_entity"), sleep(3000).then(() => [undefined])]);
	check("clicking a sign opens its editor again", reopened?.location.z === signPosition.z, JSON.stringify(reopened));
	alice._client.write("update_sign", { location: signPosition, isFrontText: reopened?.isFrontText ?? true, text1: "hello sign", text2: "", text3: "line three", text4: "" });
	await hold(alice, "oak_sign");
	click(alice, placed, "west");
	check("a sign on the side of a block is a wall sign", ...(await sees(placed.offset(-1, 0, 0), "oak_wall_sign", { facing: "west" })));

	await hold(alice, "stone");
	click(alice, groundAt(0, 0), "up");
	await sleep(400);
	check("a block cannot be placed inside a player", bob.blockAt(above(0, 0))?.name === "air", bob.blockAt(above(0, 0))?.name);

	// ---- what other players see in your hand ----
	await hold(alice, "diamond_sword");
	const aliceInBobsView = bob.players[nameA]?.entity;
	check("held items are shown to other players", Boolean(await until(() => aliceInBobsView?.equipment[0]?.name === "diamond_sword")), aliceInBobsView?.equipment[0]?.name);
	alice.setQuickBarSlot(5);
	check("an empty hand is shown to other players", Boolean(await until(() => !aliceInBobsView?.equipment[0])), aliceInBobsView?.equipment[0]?.name);
	alice.setQuickBarSlot(1);
	await sleep(100);

	// ---- plugin commands ----
	let worstLatency = 0;
	let measuring = true;
	const latencyProbe = (async () => {
		while (measuring) {
			const started = Date.now();
			await mc.ping({ host, port, version });
			worstLatency = Math.max(worstLatency, Date.now() - started);
			await sleep(50);
		}
	})();
	alice.chat("/hello");
	check("plugin command broadcasts", Boolean(await sawMessage(bob, `${nameA} says hello to all 2 of you`)), bob.messages.at(-1));
	alice.chat("/sphere gold_block 3");
	const sphereTop = new Vec3(Math.floor(alice.entity.position.x), Math.floor(alice.entity.position.y) + 6, Math.floor(alice.entity.position.z));
	check("plugin builds through the server API", Boolean(await until(() => bob.blockAt(sphereTop)?.name === "gold_block")), bob.blockAt(sphereTop)?.name);
	check("plugin reports back to the player", Boolean(await sawMessage(alice, "Built a gold_block sphere")), alice.messages.at(-1));
	alice.chat("/sphere glass 8");
	check("a large build finishes", Boolean(await sawMessage(alice, "Built a glass sphere")), alice.messages.at(-1));
	measuring = false;
	await latencyProbe;
	check("the server stays responsive during a large build", worstLatency < 500, `worst ping ${worstLatency} ms`);

	// ---- leaving ----
	const alicePosition = alice.entity.position.clone();
	alice.quit();
	check("leaving removes the player for others", Boolean(await until(() => !bob.players[nameA]?.entity)));
	check("others are told about the leave", Boolean(await sawMessage(bob, `${nameA} left`)), bob.messages.at(-1));
	bob.quit();
	await sleep(500);

	// ---- persistence ----
	const again = await join(nameA);
	check("position is remembered", again.entity.position.distanceTo(alicePosition) < 1.5, `${again.entity.position}`);
	const stillBroken = await until(() => again.blockAt(broken));
	check("broken block is still broken after rejoining", stillBroken?.name === "air", stillBroken?.name);
	check("placed block is still there after rejoining", again.blockAt(placed)?.name === "stone", again.blockAt(placed)?.name);
	check("untouched ground next to it is intact", again.blockAt(new Vec3(baseX + 3, -61, baseZ + 3))?.name === "grass_block");
	const savedSign = JSON.stringify(again.blockAt(signPosition)?.blockEntity ?? null);
	check("sign text is still there after rejoining", savedSign.includes("hello sign"), savedSign);
	check("block states are remembered", again.blockAt(above(-2, -2))?.getProperties().shape === "outer_left", JSON.stringify(again.blockAt(above(-2, -2))?.getProperties()));
	check("the inventory is remembered", Boolean(await until(() => again.inventory.slots[37]?.name === "diamond_sword")), again.inventory.slots[37]?.name);
	check("the selected hotbar slot is remembered", again.quickBarSlot === 1, `slot ${again.quickBarSlot}`);
	again.quit();

	for (const bot of [alice, bob, again]) check(`no client errors for ${bot.username}`, bot.errors.length === 0, bot.errors.join("; "));
}

main()
	.catch((error) => {
		console.error(error);
		failures++;
	})
	.finally(async () => {
		await sleep(300);
		console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) failed.`);
		process.exit(failures === 0 ? 0 : 1);
	});
