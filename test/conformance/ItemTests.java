// Item stacks with data components, judged like everything else by the game's
// own codecs (see Conformance.java). Real stacks are built with the game's
// classes and put in creative slots; what the server then sends their owner,
// shows other players, drops and saves is decoded and compared with them.
//
// Then a hostile client sends what the game would never send: bytes that do
// not decode, components too large, text that is not plain text, nesting too
// deep, an id that does not exist. The player watching it must never receive
// anything they cannot read, and the server must stay up.

import io.netty.buffer.ByteBuf;
import io.netty.buffer.Unpooled;
import it.unimi.dsi.fastutil.ints.IntList;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import java.util.function.Predicate;
import net.minecraft.ChatFormatting;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Holder;
import net.minecraft.core.RegistryAccess;
import net.minecraft.core.component.DataComponentType;
import net.minecraft.core.component.DataComponents;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.core.registries.Registries;
import net.minecraft.nbt.CompoundTag;
import net.minecraft.nbt.NbtOps;
import net.minecraft.nbt.Tag;
import net.minecraft.network.FriendlyByteBuf;
import net.minecraft.network.RegistryFriendlyByteBuf;
import net.minecraft.network.chat.Component;
import net.minecraft.network.chat.HoverEvent;
import net.minecraft.network.protocol.game.ClientboundContainerSetSlotPacket;
import net.minecraft.network.protocol.game.ClientboundSetEntityDataPacket;
import net.minecraft.network.protocol.game.ClientboundSetEquipmentPacket;
import net.minecraft.network.protocol.game.ServerboundPickItemFromBlockPacket;
import net.minecraft.network.protocol.game.ServerboundSetCarriedItemPacket;
import net.minecraft.network.protocol.game.ServerboundSetCreativeModeSlotPacket;
import net.minecraft.network.protocol.status.ClientboundStatusResponsePacket;
import net.minecraft.network.syncher.EntityDataSerializers;
import net.minecraft.world.effect.MobEffectInstance;
import net.minecraft.world.effect.MobEffects;
import net.minecraft.world.entity.EquipmentSlot;
import net.minecraft.world.entity.decoration.painting.PaintingVariants;
import net.minecraft.world.item.DyeColor;
import net.minecraft.world.item.Instruments;
import net.minecraft.world.item.Item;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.ItemStackTemplate;
import net.minecraft.world.item.Items;
import net.minecraft.world.item.Rarity;
import net.minecraft.world.item.alchemy.PotionContents;
import net.minecraft.world.item.alchemy.Potions;
import net.minecraft.world.item.component.BlockItemStateProperties;
import net.minecraft.world.item.component.BundleContents;
import net.minecraft.world.item.component.CustomData;
import net.minecraft.world.item.component.DyedItemColor;
import net.minecraft.world.item.component.FireworkExplosion;
import net.minecraft.world.item.component.Fireworks;
import net.minecraft.world.item.component.InstrumentComponent;
import net.minecraft.world.item.component.ItemContainerContents;
import net.minecraft.world.item.component.ItemLore;
import net.minecraft.world.item.component.OminousBottleAmplifier;
import net.minecraft.world.item.component.ResolvableProfile;
import net.minecraft.world.item.component.SuspiciousStewEffects;
import net.minecraft.world.item.component.TooltipDisplay;
import net.minecraft.world.item.enchantment.Enchantments;
import net.minecraft.world.item.enchantment.ItemEnchantments;
import net.minecraft.world.level.block.entity.BannerPatternLayers;
import net.minecraft.world.level.block.entity.BannerPatterns;

class ItemTests {
	static final int BACKPACK = 9;
	static final int HOTBAR = 36;
	static final int HEAD = 5;
	static final int DROP = -1;

	static void check(String label, boolean ok, Object detail) {
		Conformance.check(label, ok, detail);
	}

	static void check(String label, boolean ok) {
		Conformance.check(label, ok);
	}

	/**
	 * Whether a stack a client received is the expected one. Each client builds
	 * its own registries, so enchantments and the like are compared by name, in
	 * the form the game saves stacks in.
	 */
	static boolean same(Conformance.Client viewer, ItemStack seen, RegistryAccess builtWith, ItemStack expected) {
		return tag(viewer.registries, seen).equals(tag(builtWith, expected));
	}

	static Tag tag(RegistryAccess registries, ItemStack stack) {
		return ItemStack.OPTIONAL_CODEC.encodeStart(registries.createSerializationContext(NbtOps.INSTANCE), stack).getOrThrow();
	}

	/** What others are shown of a stack: everything but what only its holder can see. */
	static ItemStack shown(ItemStack stack) {
		return new ItemStack(stack.typeHolder(), stack.getCount(), stack.getComponentsPatch().forget(type -> type == DataComponents.LORE || type == DataComponents.CONTAINER));
	}

	/** What the watcher was last told the holder has in that slot. */
	static ItemStack showing(Conformance.Client watcher, Conformance.Client holder, EquipmentSlot slot) {
		ItemStack last = ItemStack.EMPTY;
		for (ClientboundSetEquipmentPacket p : watcher.received(ClientboundSetEquipmentPacket.class)) {
			if (p.getEntity() != holder.entityId) continue;
			for (var entry : p.getSlots()) if (entry.getFirst() == slot) last = entry.getSecond();
		}
		return last;
	}

	static boolean holds(Conformance.Client watcher, Conformance.Client holder, EquipmentSlot slot, Predicate<ItemStack> matches) throws InterruptedException {
		return Conformance.until(() -> matches.test(showing(watcher, holder, slot)));
	}

	static String lastHeld(Conformance.Client watcher, Conformance.Client holder) {
		ItemStack last = showing(watcher, holder, EquipmentSlot.MAINHAND);
		return last + " " + last.getComponentsPatch();
	}

	/** Puts stone in the hand and waits until the watcher sees it, so that the next change shows. */
	static void showStone(Conformance.Client holder, Conformance.Client watcher) throws Exception {
		hold(holder, new ItemStack(Items.STONE));
		holds(watcher, holder, EquipmentSlot.MAINHAND, seen -> seen.is(Items.STONE));
	}

	static void hold(Conformance.Client client, ItemStack stack) throws Exception {
		client.send(new ServerboundSetCreativeModeSlotPacket(HOTBAR, stack));
		client.send(new ServerboundSetCarriedItemPacket(0));
	}

	static Conformance.Client join(String host, int port, String name) throws Exception {
		Conformance.Client client = new Conformance.Client(host, port, name);
		client.join();
		check(name + " joins", Conformance.until(() -> client.error != null || client.entityId >= 0, 15000) && client.error == null, client.error);
		return client;
	}

	static boolean goTo(Conformance.Client client, double x, double z, float pitch) throws Exception {
		client.command("tp " + x + " -60 " + z);
		boolean arrived = Conformance.until(() -> client.position != null && Math.abs(client.position.x - x) < 0.01 && Math.abs(client.position.z - z) < 0.01 && client.block(BlockPos.containing(x, -60, z)) != null);
		client.moveTo(x, -60, z, 0, pitch);
		Thread.sleep(100);
		return arrived;
	}

	// ---- stacks the game would not send ----

	/** The id the game gives the creative slot packet, read off one it encodes. */
	static int creativeSlotPacketId(Conformance.Client client) throws Exception {
		ByteBuf body = Unpooled.buffer();
		client.outbound.codec().encode(body, new ServerboundSetCreativeModeSlotPacket(HOTBAR, ItemStack.EMPTY));
		return new FriendlyByteBuf(body).readVarInt();
	}

	/**
	 * A creative slot packet written by hand: a stack of one `item` whose
	 * components are pairs of a type id and the bytes of its value, each value
	 * with its length in front the way the game sends it.
	 */
	static void sendRawStack(Conformance.Client client, int slot, Item item, Object... components) throws Exception {
		FriendlyByteBuf body = new FriendlyByteBuf(Unpooled.buffer());
		body.writeVarInt(creativeSlotPacketId(client));
		body.writeShort(slot);
		body.writeVarInt(1).writeVarInt(BuiltInRegistries.ITEM.getId(item));
		body.writeVarInt(components.length / 2).writeVarInt(0);
		for (int i = 0; i < components.length; i += 2) {
			Object type = components[i];
			byte[] value = (byte[]) components[i + 1];
			body.writeVarInt(type instanceof Integer id ? id : BuiltInRegistries.DATA_COMPONENT_TYPE.getId((DataComponentType<?>) type));
			body.writeVarInt(value.length).writeBytes(value);
		}
		FriendlyByteBuf framed = new FriendlyByteBuf(Unpooled.buffer());
		framed.writeVarInt(body.readableBytes()).writeBytes(body);
		byte[] bytes = new byte[framed.readableBytes()];
		framed.readBytes(bytes);
		synchronized (client.out) {
			client.out.write(bytes);
			client.out.flush();
		}
	}

	static byte[] bytes(java.util.function.Consumer<FriendlyByteBuf> write) {
		FriendlyByteBuf buffer = new FriendlyByteBuf(Unpooled.buffer());
		write.accept(buffer);
		byte[] out = new byte[buffer.readableBytes()];
		buffer.readBytes(out);
		return out;
	}

	/** A value written with the game's own codec for its type. */
	static <T> byte[] encoded(Conformance.Client client, DataComponentType<T> type, T value) {
		RegistryFriendlyByteBuf buffer = new RegistryFriendlyByteBuf(Unpooled.buffer(), client.registries);
		type.streamCodec().encode(buffer, value);
		byte[] out = new byte[buffer.readableBytes()];
		buffer.readBytes(out);
		return out;
	}

	static ItemStack with(Item item, java.util.function.Consumer<ItemStack> setUp) {
		ItemStack stack = new ItemStack(item);
		setUp.accept(stack);
		return stack;
	}

	static ItemStack shulkerOf(ItemStack... contents) {
		return with(Items.SHULKER_BOX, s -> s.set(DataComponents.CONTAINER, ItemContainerContents.fromItems(List.of(contents))));
	}

	static void run(String host, int port, String suffix, int baseX, int baseZ) throws Exception {
		Conformance.Client dana = join(host, port, "dana_" + suffix);
		Conformance.Client erin = join(host, port, "erin_" + suffix);
		if (dana.error != null || erin.error != null) return;
		check("two players meet to trade items", goTo(dana, baseX + 0.5, baseZ + 0.5, 90) && goTo(erin, baseX + 3.5, baseZ + 0.5, 0), dana.position + " / " + erin.position);

		RegistryAccess registries = dana.registries;
		var enchantments = registries.lookupOrThrow(Registries.ENCHANTMENT);
		ItemEnchantments.Mutable sharp = new ItemEnchantments.Mutable(ItemEnchantments.EMPTY);
		sharp.set(enchantments.getOrThrow(Enchantments.SHARPNESS), 5);
		sharp.set(enchantments.getOrThrow(Enchantments.UNBREAKING), 3);
		ItemEnchantments.Mutable mending = new ItemEnchantments.Mutable(ItemEnchantments.EMPTY);
		mending.set(enchantments.getOrThrow(Enchantments.MENDING), 1);

		ItemStack sword = with(Items.DIAMOND_SWORD, s -> {
			s.set(DataComponents.CUSTOM_NAME, Component.literal("Excalibur").withStyle(ChatFormatting.GOLD, ChatFormatting.BOLD));
			s.set(DataComponents.ENCHANTMENTS, sharp.toImmutable());
			s.set(DataComponents.LORE, new ItemLore(List.of(Component.literal("pulled from a stone"), Component.translatable("item.minecraft.diamond_sword").withStyle(ChatFormatting.ITALIC))));
			s.set(DataComponents.DAMAGE, 12);
			s.set(DataComponents.REPAIR_COST, 3);
			s.set(DataComponents.UNBREAKABLE, net.minecraft.util.Unit.INSTANCE);
			s.set(DataComponents.RARITY, Rarity.EPIC);
		});
		ItemStack potion = with(Items.POTION, s -> s.set(DataComponents.POTION_CONTENTS,
			new PotionContents(Optional.of(Potions.STRONG_HEALING), Optional.of(0x3366ff), List.of(new MobEffectInstance(MobEffects.SPEED, 600, 1)), Optional.empty())));
		ItemStack banner = with(Items.BANNER.white(), s -> {
			var patterns = registries.lookupOrThrow(Registries.BANNER_PATTERN);
			s.set(DataComponents.BANNER_PATTERNS, new BannerPatternLayers.Builder().add(patterns.getOrThrow(BannerPatterns.STRIPE_BOTTOM), DyeColor.RED).add(patterns.getOrThrow(BannerPatterns.BORDER), DyeColor.BLACK).build());
			s.set(DataComponents.ITEM_NAME, Component.translatable("block.minecraft.ominous_banner").withStyle(ChatFormatting.GOLD));
			s.set(DataComponents.RARITY, Rarity.UNCOMMON);
			s.set(DataComponents.TOOLTIP_DISPLAY, new TooltipDisplay(false, new LinkedHashSet<>(List.of(DataComponents.BANNER_PATTERNS))));
		});
		Map<String, ItemStack> stacks = new LinkedHashMap<>();
		stacks.put("a plain sword", new ItemStack(Items.DIAMOND_SWORD));
		stacks.put("the same sword named, enchanted and damaged", sword);
		stacks.put("an enchanted book", with(Items.ENCHANTED_BOOK, s -> s.set(DataComponents.STORED_ENCHANTMENTS, mending.toImmutable())));
		stacks.put("a potion", potion);
		stacks.put("a tipped arrow", with(Items.TIPPED_ARROW, s -> s.set(DataComponents.POTION_CONTENTS, new PotionContents(Potions.SWIFTNESS))));
		stacks.put("a player head", with(Items.PLAYER_HEAD, s -> s.set(DataComponents.PROFILE, ResolvableProfile.createUnresolved("Notch"))));
		stacks.put("a head of a known profile", with(Items.PLAYER_HEAD, s -> s.set(DataComponents.PROFILE, ResolvableProfile.createResolved(new com.mojang.authlib.GameProfile(UUID.fromString("069a79f4-44e9-4726-a5be-fca90e38aaf5"), "Notch")))));
		stacks.put("a firework rocket", with(Items.FIREWORK_ROCKET, s -> s.set(DataComponents.FIREWORKS, new Fireworks(2, List.of(new FireworkExplosion(FireworkExplosion.Shape.STAR, IntList.of(0xff0000, 0x00ff00), IntList.of(0x0000ff), true, false))))));
		stacks.put("a firework star", with(Items.FIREWORK_STAR, s -> s.set(DataComponents.FIREWORK_EXPLOSION, new FireworkExplosion(FireworkExplosion.Shape.CREEPER, IntList.of(0x123456), IntList.of(), false, true))));
		stacks.put("a banner with patterns", banner);
		stacks.put("a goat horn", with(Items.GOAT_HORN, s -> s.set(DataComponents.INSTRUMENT, new InstrumentComponent(registries.lookupOrThrow(Registries.INSTRUMENT).getOrThrow(Instruments.SING_GOAT_HORN)))));
		stacks.put("a painting", with(Items.PAINTING, s -> s.set(DataComponents.PAINTING_VARIANT, registries.lookupOrThrow(Registries.PAINTING_VARIANT).getOrThrow(PaintingVariants.KEBAB))));
		stacks.put("a light block", with(Items.LIGHT, s -> s.set(DataComponents.BLOCK_STATE, new BlockItemStateProperties(Map.of("level", "7")))));
		stacks.put("a suspicious stew", with(Items.SUSPICIOUS_STEW, s -> s.set(DataComponents.SUSPICIOUS_STEW_EFFECTS, new SuspiciousStewEffects(List.of(new SuspiciousStewEffects.Entry(MobEffects.NIGHT_VISION, 100))))));
		stacks.put("an ominous bottle", with(Items.OMINOUS_BOTTLE, s -> s.set(DataComponents.OMINOUS_BOTTLE_AMPLIFIER, new OminousBottleAmplifier(3))));
		stacks.put("a book without its glint", with(Items.ENCHANTED_BOOK, s -> s.set(DataComponents.ENCHANTMENT_GLINT_OVERRIDE, false)));
		stacks.put("a filled shulker box", shulkerOf(sword.copy(), potion.copy(), new ItemStack(Items.STONE, 64)));
		stacks.put("a shulker box holding a filled chest", shulkerOf(with(Items.CHEST, s -> s.set(DataComponents.CONTAINER, ItemContainerContents.fromItems(List.of(new ItemStack(Items.DIAMOND, 3)))))));

		// ---- in hand, as others see it ----
		List<String> labels = new ArrayList<>(stacks.keySet());
		for (int i = 0; i < labels.size(); i++) {
			ItemStack stack = stacks.get(labels.get(i));
			hold(dana, stack);
			check("others see " + labels.get(i) + " in hand", holds(erin, dana, EquipmentSlot.MAINHAND, seen -> same(erin, seen, registries, shown(stack))), lastHeld(erin, dana));
			dana.send(new ServerboundSetCreativeModeSlotPacket(BACKPACK + i, stack)); // kept for the return below
		}
		// Everything the creative inventory offers with components of its own,
		// built by the game from the registries this server sent.
		net.minecraft.world.item.CreativeModeTabs.tryRebuildTabContents(net.minecraft.world.flag.FeatureFlags.DEFAULT_FLAGS, true, registries);
		List<ItemStack> creative = new ArrayList<>();
		java.util.Set<Tag> seenBefore = new java.util.HashSet<>(); // the search tab repeats the others
		for (var tab : BuiltInRegistries.CREATIVE_MODE_TAB) {
			for (ItemStack stack : tab.getDisplayItems()) if (!stack.getComponentsPatch().isEmpty() && seenBefore.add(tag(registries, stack))) creative.add(stack);
		}
		List<String> notShown = new ArrayList<>();
		for (ItemStack stack : creative) {
			hold(dana, stack);
			if (!holds(erin, dana, EquipmentSlot.MAINHAND, seen -> same(erin, seen, registries, shown(stack)))) notShown.add(stack + " " + stack.getComponentsPatch());
		}
		check("others see each of the " + creative.size() + " creative inventory items with components as they are", creative.size() > 100 && notShown.isEmpty(), notShown.stream().limit(3).toList());

		ItemStack cap = with(Items.LEATHER_HELMET, s -> s.set(DataComponents.DYED_COLOR, new DyedItemColor(0xb02e26)));
		dana.send(new ServerboundSetCreativeModeSlotPacket(HEAD, cap));
		check("others see a dyed leather cap worn", holds(erin, dana, EquipmentSlot.HEAD, seen -> same(erin, seen, registries, cap)), showing(erin, dana, EquipmentSlot.HEAD));

		// ---- middle click ----
		ItemStack namedGrass = with(Items.GRASS_BLOCK, s -> s.set(DataComponents.CUSTOM_NAME, Component.literal("Fancy grass")));
		hold(dana, namedGrass);
		Thread.sleep(100);
		int slotsBefore = dana.received(ClientboundContainerSetSlotPacket.class).size();
		dana.send(new ServerboundPickItemFromBlockPacket(BlockPos.containing(baseX, -61, baseZ), false));
		check("middle click does not take a renamed stack for the block's item", Conformance.until(() -> dana.received(ClientboundContainerSetSlotPacket.class).stream().skip(slotsBefore)
			.anyMatch(p -> p.getSlot() != HOTBAR && ItemStack.matches(p.getItem(), new ItemStack(Items.GRASS_BLOCK)))), dana.received(ClientboundContainerSetSlotPacket.class).stream().skip(slotsBefore).map(p -> p.getSlot() + "=" + p.getItem()).toList());

		// ---- dropped, and picked up by someone else ----
		ItemStack box = stacks.get("a filled shulker box");
		dana.send(new ServerboundSetCreativeModeSlotPacket(DROP, box));
		check("a dropped shulker box shows for others", erin.awaitPacket(ClientboundSetEntityDataPacket.class,
			p -> p.packedItems().stream().anyMatch(v -> v.serializer() == EntityDataSerializers.ITEM_STACK && same(erin, (ItemStack) v.value(), registries, shown(box)))));
		goTo(dana, baseX + 30.5, baseZ + 0.5, 0); // out of reach before it can be picked up
		erin.moveTo(baseX + 0.5, -60, baseZ + 0.5, 0, 0);
		check("whoever picks it up gets its contents too", Conformance.until(() -> erin.inventory.values().stream().anyMatch(stack -> same(erin, stack, registries, box)), 8000), erin.inventory);

		// ---- leaving and coming back ----
		dana.quit();
		Thread.sleep(300);
		Conformance.Client back = join(host, port, dana.name);
		if (back.error != null) return;
		check("the inventory comes back with its components", Conformance.until(() -> back.inventory.size() >= labels.size() + 1), back.inventory.size() + " slots");
		for (int i = 0; i < labels.size(); i++) {
			ItemStack saved = back.inventory.get(BACKPACK + i);
			check(labels.get(i) + " is remembered", saved != null && same(back, saved, registries, stacks.get(labels.get(i))), saved == null ? "missing" : saved + " " + saved.getComponentsPatch());
		}
		check("the dyed cap is remembered", back.inventory.get(HEAD) != null && same(back, back.inventory.get(HEAD), registries, cap), back.inventory.get(HEAD));

		hostile(host, port, suffix, baseX + 8, baseZ, erin);

		ClientboundStatusResponsePacket status = new Conformance.Client(host, port, "ping").ping();
		check("the server is still up", status.status().version().isPresent());
		for (Conformance.Client client : List.of(erin, back)) check("nothing " + client.name + " received was unreadable", client.error == null, client.error);
		erin.quit();
		back.quit();
	}

	// ---- dropped items across a restart (test/restart.mjs) ----

	/** What test/restart.mjs drops: before the world goes idle, and before it is killed with a player online. */
	static Map<String, ItemStack> restartStacks(RegistryAccess registries, boolean idle) {
		Map<String, ItemStack> stacks = new LinkedHashMap<>();
		if (idle) {
			ItemEnchantments.Mutable sharp = new ItemEnchantments.Mutable(ItemEnchantments.EMPTY);
			sharp.set(registries.lookupOrThrow(Registries.ENCHANTMENT).getOrThrow(Enchantments.SHARPNESS), 4);
			ItemStack sword = with(Items.DIAMOND_SWORD, s -> {
				s.set(DataComponents.CUSTOM_NAME, Component.literal("Left behind").withStyle(ChatFormatting.AQUA));
				s.set(DataComponents.ENCHANTMENTS, sharp.toImmutable());
			});
			stacks.put("a named, enchanted sword", sword);
			stacks.put("a filled shulker box", shulkerOf(sword.copy(), new ItemStack(Items.STONE, 64)));
		} else {
			stacks.put("a potion", with(Items.POTION, s -> s.set(DataComponents.POTION_CONTENTS, new PotionContents(Potions.SWIFTNESS))));
			stacks.put("sixteen firework rockets", with(Items.FIREWORK_ROCKET, s -> {
				s.set(DataComponents.FIREWORKS, new Fireworks(3, List.of()));
				s.setCount(16);
			}));
		}
		return stacks;
	}

	/**
	 * One step of test/restart.mjs, from RESTART_PHASE: "idle" drops items and
	 * leaves, so that the world goes idle; "crash" drops items and stays
	 * online past the periodic save, then waits to be cut off; "after" joins
	 * the restarted server and looks for both.
	 */
	public static void main(String[] args) throws Exception {
		net.minecraft.SharedConstants.tryDetectVersion();
		net.minecraft.server.Bootstrap.bootStrap();
		String host = args[0];
		int port = Integer.parseInt(args[1]);
		String phase = System.getenv("RESTART_PHASE");
		String tag = System.getenv("RESTART_TAG");
		String[] at = System.getenv("RESTART_AT").split(",");
		int x = Integer.parseInt(at[0]);
		int z = Integer.parseInt(at[1]);
		try {
			if (phase.equals("after")) checkAfterRestart(host, port, tag, x, z);
			else dropBeforeRestart(host, port, tag, x, z, phase.equals("idle"));
		} catch (Throwable problem) {
			check("the " + phase + " step finishes", false, problem);
		}
		Conformance.say(Conformance.failures == 0 ? "All checks passed." : Conformance.failures + " check(s) failed.");
		System.exit(Conformance.failures == 0 ? 0 : 1);
	}

	static void dropBeforeRestart(String host, int port, String tag, int x, int z, boolean idle) throws Exception {
		Conformance.Client client = join(host, port, (idle ? "leaver_" : "stayer_") + tag);
		if (client.error != null) return;
		double spotX = x + (idle ? 0.5 : 10.5);
		check("the dropper gets to the spot", goTo(client, spotX, z + 0.5, 90), client.position);
		for (ItemStack stack : restartStacks(client.registries, idle).values()) client.send(new ServerboundSetCreativeModeSlotPacket(DROP, stack));
		Thread.sleep(500);
		goTo(client, spotX + 30, z + 0.5, 0); // out of reach, so nobody picks them up
		if (idle) {
			client.quit();
			Thread.sleep(1000);
			Conformance.say("dropped, and the world is empty");
			return;
		}
		Thread.sleep(32_000); // past one periodic save
		check("nothing the dropper received was unreadable", client.error == null, client.error);
		Conformance.say("READY: kill the server now");
		Thread.sleep(120_000);
	}

	static void checkAfterRestart(String host, int port, String tag, int x, int z) throws Exception {
		Conformance.Client client = join(host, port, "looker_" + tag);
		if (client.error != null) return;
		for (boolean idle : List.of(true, false)) {
			double spotX = x + (idle ? 0.5 : 10.5);
			// Every dropped item is sent to whoever joins.
			for (Map.Entry<String, ItemStack> expected : restartStacks(client.registries, idle).entrySet()) {
				boolean found = Conformance.until(() -> client.received(net.minecraft.network.protocol.game.ClientboundAddEntityPacket.class).stream()
					.filter(p -> p.getType() == net.minecraft.world.entity.EntityTypes.ITEM && Math.abs(p.getX() - spotX) < 1.5 && Math.abs(p.getZ() - (z + 0.5)) < 1.5)
					.anyMatch(p -> client.received(ClientboundSetEntityDataPacket.class).stream().anyMatch(data -> data.id() == p.getId() && data.packedItems().stream()
						.anyMatch(v -> v.serializer() == EntityDataSerializers.ITEM_STACK && same(client, (ItemStack) v.value(), client.registries, shown(expected.getValue()))))));
				check(expected.getKey() + (idle ? " dropped before the world went idle" : " dropped before the server was killed") + " is still there", found);
			}
		}
		check("nothing the looker received was unreadable", client.error == null, client.error);
		client.quit();
	}

	static void hostile(String host, int port, String suffix, int x, int z, Conformance.Client erin) throws Exception {
		Conformance.Client mallory = join(host, port, "mallory_" + suffix);
		if (mallory.error != null) return;
		goTo(mallory, x + 0.5, z + 0.5, 90);
		goTo(erin, x + 3.5, z + 0.5, 0);
		ItemStack plainSword = new ItemStack(Items.DIAMOND_SWORD);
		ItemStack plainStick = new ItemStack(Items.STICK);

		hold(mallory, new ItemStack(Items.STONE));
		check("others see the hostile player's stone", holds(erin, mallory, EquipmentSlot.MAINHAND, seen -> seen.is(Items.STONE)));
		sendRawStack(mallory, HOTBAR, Items.DIAMOND_SWORD, DataComponents.CUSTOM_NAME, new byte[] { 10, (byte) 0xff, (byte) 0xff, 0 });
		check("a name whose bytes do not decode is not shown", holds(erin, mallory, EquipmentSlot.MAINHAND, seen -> ItemStack.matches(seen, plainSword)), lastHeld(erin, mallory));

		showStone(mallory, erin);
		sendRawStack(mallory, HOTBAR, Items.DIAMOND_SWORD, DataComponents.ENCHANTMENTS, bytes(b -> b.writeVarInt(1).writeVarInt(9999).writeVarInt(1)));
		check("an enchantment that does not exist is not shown", holds(erin, mallory, EquipmentSlot.MAINHAND, seen -> ItemStack.matches(seen, plainSword)), lastHeld(erin, mallory));

		showStone(mallory, erin);
		sendRawStack(mallory, HOTBAR, Items.DIAMOND_SWORD, DataComponents.CUSTOM_NAME, bytes(b -> {
			CompoundTag selector = new CompoundTag();
			selector.putString("selector", "@a");
			b.writeNbt(selector);
		}));
		check("a name that is an entity selector is not shown", holds(erin, mallory, EquipmentSlot.MAINHAND, seen -> ItemStack.matches(seen, plainSword)), lastHeld(erin, mallory));

		ItemStack hovering = with(Items.DIAMOND_SWORD, s -> s.set(DataComponents.CUSTOM_NAME, Component.literal("Hover me").withStyle(style -> style.withHoverEvent(new HoverEvent.ShowText(Component.literal("surprise"))).withColor(ChatFormatting.RED))));
		ItemStack hoveringShown = with(Items.DIAMOND_SWORD, s -> s.set(DataComponents.CUSTOM_NAME, Component.literal("Hover me").withStyle(ChatFormatting.RED)));
		hold(mallory, hovering);
		check("a name keeps its text and colour, not its hover text", holds(erin, mallory, EquipmentSlot.MAINHAND, seen -> ItemStack.matches(seen, hoveringShown)), lastHeld(erin, mallory));
		mallory.send(new ServerboundSetCreativeModeSlotPacket(BACKPACK, hovering));

		showStone(mallory, erin);
		hold(mallory, with(Items.DIAMOND_SWORD, s -> s.set(DataComponents.CUSTOM_NAME, Component.literal("x".repeat(5000)))));
		check("an oversized name is not shown", holds(erin, mallory, EquipmentSlot.MAINHAND, seen -> ItemStack.matches(seen, plainSword)), lastHeld(erin, mallory));

		CompoundTag secret = new CompoundTag();
		secret.putString("secret", "only the server and its sender know");
		ItemStack tagged = with(Items.STICK, s -> s.set(DataComponents.CUSTOM_DATA, CustomData.of(secret)));
		hold(mallory, tagged);
		check("a component the server does not understand is not shown", holds(erin, mallory, EquipmentSlot.MAINHAND, seen -> ItemStack.matches(seen, plainStick)), lastHeld(erin, mallory));
		mallory.send(new ServerboundSetCreativeModeSlotPacket(BACKPACK + 1, tagged));

		// Dropped, these come back to erin with what may leave their sender, and no more.
		ItemStack deep = shulkerOf(shulkerOf(shulkerOf(new ItemStack(Items.STONE))));
		ItemStack bundled = shulkerOf(with(Items.BUNDLE, s -> s.set(DataComponents.BUNDLE_CONTENTS, new BundleContents(List.of(new ItemStackTemplate(Items.DIAMOND, 2))))));
		ItemStack named = with(Items.DIAMOND_SWORD, s -> s.set(DataComponents.CUSTOM_NAME, Component.literal("x".repeat(5000))));
		int before = erin.received(ClientboundContainerSetSlotPacket.class).size();
		for (ItemStack stack : List.of(deep, bundled, named)) mallory.send(new ServerboundSetCreativeModeSlotPacket(DROP, stack));
		Thread.sleep(200);
		goTo(mallory, x + 30.5, z + 0.5, 0);
		erin.moveTo(x + 0.5, -60, z + 0.5, 0, 0);
		Predicate<ItemStack> emptyBox = stack -> ItemStack.matches(stack, new ItemStack(Items.SHULKER_BOX));
		check("shulker boxes nested too deeply, or holding a bundle, arrive empty", Conformance.until(() -> erin.inventory.values().stream().filter(emptyBox).count() >= 2, 8000), erin.received(ClientboundContainerSetSlotPacket.class).stream().skip(before).map(p -> p.getSlot() + "=" + p.getItem() + " " + p.getItem().getComponentsPatch()).toList());
		check("an oversized name is not picked up either", Conformance.until(() -> erin.inventory.values().stream().anyMatch(stack -> ItemStack.matches(stack, plainSword)), 8000), erin.inventory);

		mallory.quit();
		Thread.sleep(300);
		Conformance.Client back = join(host, port, mallory.name);
		if (back.error == null) {
			check("a returning player gets the cleaned name back", Conformance.until(() -> back.inventory.get(BACKPACK) != null && ItemStack.matches(back.inventory.get(BACKPACK), hoveringShown)), back.inventory.get(BACKPACK));
			check("what the server did not understand was not saved", Conformance.until(() -> back.inventory.get(BACKPACK + 1) != null && ItemStack.matches(back.inventory.get(BACKPACK + 1), plainStick)), back.inventory.get(BACKPACK + 1));
			check("nothing the returning player received was unreadable", back.error == null, back.error);
			back.quit();
		}

		// A component type that does not exist is a broken packet, as it is for the game.
		Conformance.Client trent = join(host, port, "trent_" + suffix);
		if (trent.error != null) return;
		sendRawStack(trent, HOTBAR, Items.STICK, 9999, new byte[] { 1 });
		check("a component type that does not exist disconnects its sender", Conformance.until(() -> trent.error != null, 5000) && trent.error.contains("Bad packet"), trent.error);
		check("the watching player is unaffected", erin.error == null, erin.error);
	}
}
