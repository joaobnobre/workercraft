// A conformance test that uses the game's own code as the judge.
//
// It connects to a running server the way a Minecraft client does, and decodes
// every packet the server sends with the packet codecs from Mojang's jar, the
// same code the real game runs. A packet the game could not read fails the
// run, and so does one with bytes left over. It also builds the registries
// from what the server sent, the way the game does when it joins, and reads
// chunks with the game's chunk section reader.
//
// It does not prove what the game then does with a packet it could read.
//
//   node test/conformance.mjs [version]        (compiles and runs this)
//
// With JOIN_ONLY set it pings, joins, reads the chunks around spawn and leaves
// without touching the world, which makes it safe to point at a world someone
// cares about. It also says who is online and whether each has a signed skin;
// PLAYER names the account to join as (somebody already online under that
// name is disconnected).

import io.netty.buffer.ByteBuf;
import io.netty.buffer.Unpooled;
import java.io.DataInputStream;
import java.io.EOFException;
import java.io.OutputStream;
import java.net.Socket;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.function.BooleanSupplier;
import java.util.function.Predicate;
import java.util.stream.Stream;
import net.minecraft.SharedConstants;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.core.HolderLookup;
import net.minecraft.core.Registry;
import net.minecraft.core.RegistryAccess;
import net.minecraft.core.RegistrySynchronization;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.nbt.CompoundTag;
import net.minecraft.nbt.NbtOps;
import net.minecraft.network.FriendlyByteBuf;
import net.minecraft.network.ProtocolInfo;
import net.minecraft.network.RegistryFriendlyByteBuf;
import net.minecraft.network.protocol.Packet;
import net.minecraft.network.protocol.common.ClientboundDisconnectPacket;
import net.minecraft.network.protocol.common.ClientboundKeepAlivePacket;
import net.minecraft.network.protocol.common.ClientboundUpdateTagsPacket;
import net.minecraft.network.protocol.common.ServerboundClientInformationPacket;
import net.minecraft.network.protocol.common.ServerboundKeepAlivePacket;
import net.minecraft.network.protocol.configuration.ClientboundFinishConfigurationPacket;
import net.minecraft.network.protocol.configuration.ClientboundRegistryDataPacket;
import net.minecraft.network.protocol.configuration.ClientboundSelectKnownPacks;
import net.minecraft.network.protocol.configuration.ConfigurationProtocols;
import net.minecraft.network.protocol.configuration.ServerboundFinishConfigurationPacket;
import net.minecraft.network.protocol.configuration.ServerboundSelectKnownPacks;
import net.minecraft.network.protocol.game.ClientboundAddEntityPacket;
import net.minecraft.network.protocol.game.ClientboundBlockEntityDataPacket;
import net.minecraft.network.protocol.game.ClientboundBlockUpdatePacket;
import net.minecraft.network.protocol.game.ClientboundChunkBatchFinishedPacket;
import net.minecraft.network.protocol.game.ClientboundContainerSetSlotPacket;
import net.minecraft.network.protocol.game.ClientboundLevelChunkWithLightPacket;
import net.minecraft.network.protocol.game.ClientboundLoginPacket;
import net.minecraft.network.protocol.game.ClientboundOpenSignEditorPacket;
import net.minecraft.network.protocol.game.ClientboundPlayerInfoRemovePacket;
import net.minecraft.network.protocol.game.ClientboundPlayerInfoUpdatePacket;
import net.minecraft.network.protocol.game.ClientboundPlayerPositionPacket;
import net.minecraft.network.protocol.game.ClientboundRemoveEntitiesPacket;
import net.minecraft.network.protocol.game.ClientboundSetEntityDataPacket;
import net.minecraft.network.protocol.game.ClientboundSetEquipmentPacket;
import net.minecraft.network.protocol.game.ClientboundSetHeldSlotPacket;
import net.minecraft.network.protocol.game.ClientboundSoundPacket;
import net.minecraft.network.protocol.game.ClientboundSwingAnimationPacket;
import net.minecraft.network.protocol.game.ClientboundSystemChatPacket;
import net.minecraft.network.protocol.game.GameProtocols;
import net.minecraft.network.protocol.game.ServerboundAcceptTeleportationPacket;
import net.minecraft.network.protocol.game.ServerboundChatCommandPacket;
import net.minecraft.network.protocol.game.ServerboundChunkBatchReceivedPacket;
import net.minecraft.network.protocol.game.ServerboundMovePlayerPacket;
import net.minecraft.network.protocol.game.ServerboundPickItemFromBlockPacket;
import net.minecraft.network.protocol.game.ServerboundPlayerActionPacket;
import net.minecraft.network.protocol.game.ServerboundPlayerInputPacket;
import net.minecraft.network.protocol.game.ServerboundPunchPacket;
import net.minecraft.network.protocol.game.ServerboundSignUpdatePacket;
import net.minecraft.network.protocol.game.ServerboundSetCarriedItemPacket;
import net.minecraft.network.protocol.game.ServerboundSetCreativeModeSlotPacket;
import net.minecraft.network.protocol.game.ServerboundUseItemOnPacket;
import net.minecraft.network.protocol.handshake.ClientIntent;
import net.minecraft.network.protocol.handshake.ClientIntentionPacket;
import net.minecraft.network.protocol.handshake.HandshakeProtocols;
import net.minecraft.network.protocol.login.ClientboundLoginDisconnectPacket;
import net.minecraft.network.protocol.login.ClientboundLoginFinishedPacket;
import net.minecraft.network.protocol.login.LoginProtocols;
import net.minecraft.network.protocol.login.ServerboundHelloPacket;
import net.minecraft.network.protocol.login.ServerboundLoginAcknowledgedPacket;
import net.minecraft.network.protocol.ping.ClientboundPongResponsePacket;
import net.minecraft.network.protocol.ping.ServerboundPingRequestPacket;
import net.minecraft.network.protocol.status.ClientboundStatusResponsePacket;
import net.minecraft.network.protocol.status.ServerboundStatusRequestPacket;
import net.minecraft.network.protocol.status.StatusProtocols;
import net.minecraft.network.syncher.EntityDataSerializers;
import net.minecraft.network.syncher.SynchedEntityData;
import net.minecraft.resources.RegistryDataLoader;
import net.minecraft.resources.ResourceKey;
import net.minecraft.server.Bootstrap;
import net.minecraft.server.level.ClientInformation;
import net.minecraft.server.packs.PackType;
import net.minecraft.server.packs.repository.KnownPack;
import net.minecraft.server.packs.repository.PackRepository;
import net.minecraft.server.packs.repository.ServerPacksSource;
import net.minecraft.server.packs.resources.MultiPackResourceManager;
import net.minecraft.server.packs.resources.ResourceProvider;
import net.minecraft.tags.TagLoader;
import net.minecraft.tags.TagNetworkSerialization;
import net.minecraft.world.InteractionHand;
import net.minecraft.world.entity.EntityTypes;
import net.minecraft.world.entity.EquipmentSlot;
import net.minecraft.world.entity.Pose;
import net.minecraft.world.entity.player.Input;
import net.minecraft.world.item.Item;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.Items;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.entity.SignText;
import net.minecraft.world.level.block.entity.SignTextSlot;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.block.state.properties.Property;
import net.minecraft.world.level.chunk.LevelChunkSection;
import net.minecraft.world.level.chunk.PalettedContainerFactory;
import net.minecraft.world.phys.BlockHitResult;
import net.minecraft.world.phys.Vec3;

@SuppressWarnings({ "unchecked", "rawtypes" })
public class Conformance {
	static final int MIN_Y = -64;
	static final int SECTIONS = 24;
	static int failures = 0;
	static boolean componentsBound = false;

	/** The game redirects System.out into its log, so print past it. */
	static void say(String line) {
		Bootstrap.realStdoutPrintln(line);
	}

	static void check(String label, boolean ok, Object detail) {
		say((ok ? "ok   " : "FAIL ") + label + (detail == null ? "" : "  (" + detail + ")"));
		if (!ok) failures++;
	}

	static void check(String label, boolean ok) {
		check(label, ok, null);
	}

	static boolean until(BooleanSupplier condition, long timeoutMs) throws InterruptedException {
		long deadline = System.currentTimeMillis() + timeoutMs;
		while (!condition.getAsBoolean()) {
			if (System.currentTimeMillis() > deadline) return false;
			Thread.sleep(25);
		}
		return true;
	}

	static boolean until(BooleanSupplier condition) throws InterruptedException {
		return until(condition, 5000);
	}

	/** One connection, playing the part of the game client. */
	static class Client {
		final String name;
		final String host;
		final int port;
		Socket socket;
		DataInputStream in;
		OutputStream out;
		ProtocolInfo inbound;
		ProtocolInfo outbound;
		volatile String phase = "login";
		volatile String error;
		volatile boolean closed;

		/** Every packet received, in order. */
		final List<Packet<?>> packets = new CopyOnWriteArrayList<>();
		final Map<String, Integer> counts = new ConcurrentHashMap<>();
		final Map<ResourceKey<? extends Registry<?>>, List<RegistrySynchronization.PackedRegistryEntry>> registryData = new HashMap<>();
		Map<ResourceKey<? extends Registry<?>>, TagNetworkSerialization.NetworkPayload> tags = new HashMap<>();
		List<KnownPack> offeredPacks = List.of();
		boolean entriesSentInFull;
		volatile RegistryAccess registries;
		PalettedContainerFactory containers;
		final Map<Long, LevelChunkSection[]> chunks = new ConcurrentHashMap<>();
		final Map<BlockPos, BlockState> changedBlocks = new ConcurrentHashMap<>();
		final Map<BlockPos, CompoundTag> blockEntities = new ConcurrentHashMap<>();
		final Map<Integer, ItemStack> inventory = new ConcurrentHashMap<>();
		volatile int entityId = -1;
		volatile int heldSlot = -1;
		volatile Vec3 position;
		int sequence = 1;

		Client(String host, int port, String name) {
			this.host = host;
			this.port = port;
			this.name = name;
		}

		void send(Packet<?> packet) throws Exception {
			ByteBuf body = Unpooled.buffer();
			outbound.codec().encode(body, packet);
			ByteBuf framed = Unpooled.buffer();
			new FriendlyByteBuf(framed).writeVarInt(body.readableBytes());
			framed.writeBytes(body);
			byte[] bytes = new byte[framed.readableBytes()];
			framed.readBytes(bytes);
			synchronized (out) {
				out.write(bytes);
				out.flush();
			}
		}

		private byte[] readFrame() throws Exception {
			int length = 0;
			for (int shift = 0; ; shift += 7) {
				int b = in.readUnsignedByte();
				length |= (b & 0x7f) << shift;
				if ((b & 0x80) == 0) break;
			}
			byte[] frame = new byte[length];
			in.readFully(frame);
			return frame;
		}

		/** Reads one packet with the game's codec for the current phase. */
		private Packet<?> read() throws Exception {
			byte[] frame = readFrame();
			ByteBuf buffer = Unpooled.wrappedBuffer(frame);
			int id = new FriendlyByteBuf(buffer.duplicate()).readVarInt();
			Packet<?> packet;
			try {
				packet = (Packet<?>) inbound.codec().decode(buffer);
			} catch (Throwable problem) {
				throw new IllegalStateException("The game cannot read " + phase + " packet 0x" + Integer.toHexString(id) + " (" + frame.length + " bytes): " + problem, problem);
			}
			if (buffer.isReadable()) {
				throw new IllegalStateException(packet.getClass().getSimpleName() + " has " + buffer.readableBytes() + " bytes left over of " + frame.length);
			}
			packets.add(packet);
			counts.merge(packet.getClass().getSimpleName(), 1, Integer::sum);
			return packet;
		}

		void connect() throws Exception {
			socket = new Socket(host, port);
			socket.setTcpNoDelay(true);
			in = new DataInputStream(socket.getInputStream());
			out = socket.getOutputStream();
		}

		/** A server list ping. Returns the status the game decoded. */
		ClientboundStatusResponsePacket ping() throws Exception {
			connect();
			outbound = HandshakeProtocols.SERVERBOUND;
			send(new ClientIntentionPacket(SharedConstants.getProtocolVersion(), host, port, ClientIntent.STATUS));
			outbound = StatusProtocols.SERVERBOUND;
			inbound = StatusProtocols.CLIENTBOUND;
			phase = "status";
			send(ServerboundStatusRequestPacket.INSTANCE);
			ClientboundStatusResponsePacket status = (ClientboundStatusResponsePacket) read();
			send(new ServerboundPingRequestPacket(42L));
			ClientboundPongResponsePacket pong = (ClientboundPongResponsePacket) read();
			if (pong.time() != 42L) throw new IllegalStateException("Pong carried " + pong.time());
			socket.close();
			return status;
		}

		/** Logs in and then keeps reading on a background thread. */
		void join() throws Exception {
			connect();
			outbound = HandshakeProtocols.SERVERBOUND;
			send(new ClientIntentionPacket(SharedConstants.getProtocolVersion(), host, port, ClientIntent.LOGIN));
			outbound = LoginProtocols.SERVERBOUND;
			inbound = LoginProtocols.CLIENTBOUND;
			send(new ServerboundHelloPacket(name, UUID.randomUUID()));
			Thread reader = new Thread(() -> {
				try {
					while (!closed) handle(read());
				} catch (EOFException | java.net.SocketException end) {
					if (!closed) error = "The server closed the connection during " + phase;
				} catch (Throwable problem) {
					error = String.valueOf(problem.getMessage() == null ? problem : problem.getMessage());
					if (System.getenv("CONFORMANCE_TRACE") != null) problem.printStackTrace();
				}
				closed = true;
			}, "reader-" + name);
			reader.setDaemon(true);
			reader.start();
		}

		void quit() throws Exception {
			closed = true;
			socket.close();
		}

		private void handle(Packet<?> packet) throws Exception {
			if (packet instanceof ClientboundLoginDisconnectPacket p) throw new IllegalStateException("Refused at login: " + p.reason().getString());
			if (packet instanceof ClientboundDisconnectPacket p) throw new IllegalStateException("Disconnected: " + p.reason().getString());

			if (packet instanceof ClientboundLoginFinishedPacket) {
				send(ServerboundLoginAcknowledgedPacket.INSTANCE);
				inbound = ConfigurationProtocols.CLIENTBOUND;
				outbound = ConfigurationProtocols.SERVERBOUND;
				phase = "configuration";
				send(new ServerboundClientInformationPacket(ClientInformation.createDefault()));
			} else if (packet instanceof ClientboundSelectKnownPacks p) {
				// The game answers with the packs it has itself, which is its own
				// version's "core" pack and nothing else.
				offeredPacks = p.knownPacks();
				send(new ServerboundSelectKnownPacks(offeredPacks.stream().filter(pack -> pack.equals(KnownPack.vanilla("core"))).toList()));
			} else if (packet instanceof ClientboundRegistryDataPacket p) {
				registryData.put(p.registry(), p.entries());
				if (p.entries().stream().anyMatch(entry -> entry.data().isPresent())) entriesSentInFull = true;
			} else if (packet instanceof ClientboundUpdateTagsPacket p) {
				tags = p.tags();
			} else if (packet instanceof ClientboundFinishConfigurationPacket) {
				registries = buildRegistries();
				containers = PalettedContainerFactory.create(registries);
				send(ServerboundFinishConfigurationPacket.INSTANCE);
				inbound = GameProtocols.CLIENTBOUND_TEMPLATE.bind(RegistryFriendlyByteBuf.decorator(registries));
				outbound = GameProtocols.SERVERBOUND_TEMPLATE.bind(RegistryFriendlyByteBuf.decorator(registries), new GameProtocols.Context() {
					public boolean hasInfiniteMaterials() {
						return true;
					}

					public boolean canUseCommandBlocks() {
						return false;
					}
				});
				phase = "play";
			} else if (packet instanceof ClientboundLoginPacket p) {
				entityId = p.playerId();
			} else if (packet instanceof ClientboundKeepAlivePacket p) {
				send(new ServerboundKeepAlivePacket(p.getId()));
			} else if (packet instanceof ClientboundPlayerPositionPacket p) {
				position = p.change().position();
				send(acceptTeleport(p));
			} else if (packet instanceof ClientboundChunkBatchFinishedPacket) {
				send(new ServerboundChunkBatchReceivedPacket(20f));
			} else if (packet instanceof ClientboundLevelChunkWithLightPacket p) {
				readChunk(p);
			} else if (packet instanceof ClientboundBlockUpdatePacket p) {
				changedBlocks.put(p.getPos(), p.getBlockState());
			} else if (packet instanceof ClientboundBlockEntityDataPacket p) {
				blockEntities.put(p.getPos(), p.getTag());
			} else if (packet instanceof ClientboundContainerSetSlotPacket p) {
				inventory.put(p.getSlot(), p.getItem());
			} else if (packet instanceof ClientboundSetHeldSlotPacket p) {
				heldSlot = p.slot();
			}
		}

		private static Packet<?> acceptTeleport(ClientboundPlayerPositionPacket p) {
			Vec3 at = p.change().position();
			return new ServerboundAcceptTeleportationPacket(p.id(), at.x, at.y, at.z, p.change().yRot(), p.change().xRot());
		}

		/**
		 * Builds the registries from the configuration packets the way the game
		 * does: entries sent without data are looked up in the vanilla data pack
		 * the client already has, the rest are decoded from the packet.
		 */
		private RegistryAccess buildRegistries() throws Exception {
			RegistryAccess.Frozen builtIn = RegistryAccess.fromRegistryOfRegistries(BuiltInRegistries.REGISTRY);
			for (RegistryDataLoader.RegistryData<?> expected : RegistryDataLoader.SYNCHRONIZED_REGISTRIES) {
				if (!registryData.containsKey(expected.key())) throw new IllegalStateException("The server never sent registry " + expected.key().identifier());
			}
			Map<ResourceKey<? extends Registry<?>>, RegistryDataLoader.NetworkedRegistryData> entries = new HashMap<>();
			registryData.forEach((key, list) -> entries.put(key, new RegistryDataLoader.NetworkedRegistryData(list, tags.getOrDefault(key, TagNetworkSerialization.NetworkPayload.EMPTY))));
			PackRepository packs = ServerPacksSource.createVanillaTrustedRepository();
			packs.reload();
			packs.setSelected(List.of("vanilla"));
			MultiPackResourceManager vanillaData = new MultiPackResourceManager(PackType.SERVER_DATA, packs.openAllSelected());
			ResourceProvider knownData = vanillaData::getResource;
			// Tags of the built-in registries (blocks, items, ...) are put in place
			// first, because the synced registries refer to them.
			List<Registry.PendingTags<?>> pendingTags = new ArrayList<>();
			for (Map.Entry<ResourceKey<? extends Registry<?>>, TagNetworkSerialization.NetworkPayload> tagged : tags.entrySet()) {
				Optional<Registry> found = builtIn.lookup((ResourceKey) tagged.getKey());
				if (found.isEmpty()) {
					if (!registryData.containsKey(tagged.getKey())) throw new IllegalStateException("Tags for unknown registry " + tagged.getKey().identifier());
					continue;
				}
				Registry registry = found.get();
				tagged.getValue().tags().forEach((tag, ids) -> ids.forEach(id -> {
					if (id < 0 || id >= registry.size()) throw new IllegalStateException("Tag " + tag + " of " + tagged.getKey().identifier() + " names entry " + id + ", which does not exist");
				}));
				pendingTags.add(registry.prepareTagReload(tagged.getValue().resolve(registry)));
			}
			List<HolderLookup.RegistryLookup<?>> context = TagLoader.buildUpdatedLookups(builtIn, pendingTags);
			RegistryAccess.Frozen synced = RegistryDataLoader.load(entries, knownData, context, RegistryDataLoader.SYNCHRONIZED_REGISTRIES, Runnable::run).join();
			RegistryAccess.Frozen all = new RegistryAccess.ImmutableRegistryAccess(Stream.concat(builtIn.registries(), synced.registries())).freeze();
			synchronized (Conformance.class) {
				pendingTags.forEach(Registry.PendingTags::apply);
				// Items get their default components once the registries exist. They
				// live in the game's global tables, so once per run is enough.
				if (!componentsBound) BuiltInRegistries.DATA_COMPONENT_INITIALIZERS.build(all).forEach(pending -> pending.apply());
				componentsBound = true;
			}
			return all;
		}

		/** Reads a chunk's sections with the game's own reader. */
		private void readChunk(ClientboundLevelChunkWithLightPacket packet) {
			FriendlyByteBuf data = packet.chunkData().getReadBuffer();
			LevelChunkSection[] sections = new LevelChunkSection[SECTIONS];
			for (int i = 0; i < SECTIONS; i++) {
				sections[i] = new LevelChunkSection(containers);
				sections[i].read(data);
			}
			if (data.isReadable()) throw new IllegalStateException("Chunk " + packet.x() + "," + packet.z() + " has " + data.readableBytes() + " bytes left over");
			// Block entities first: a waiting test takes the chunk's arrival to mean all of it is there.
			packet.chunkData().forEachBlockEntityTag(packet.x(), packet.z(), (pos, type, tag) -> {
				BlockState state = sections[(pos.getY() - MIN_Y) >> 4].getBlockState(pos.getX() & 15, pos.getY() & 15, pos.getZ() & 15);
				if (!type.isValid(state)) throw new IllegalStateException("Chunk lists a " + BuiltInRegistries.BLOCK_ENTITY_TYPE.getKey(type) + " at " + pos + " where there is " + state);
				// The game hands every entry the same position object, so keep a copy.
				blockEntities.put(pos.immutable(), tag == null ? new CompoundTag() : tag);
			});
			changedBlocks.keySet().removeIf(pos -> pos.getX() >> 4 == packet.x() && pos.getZ() >> 4 == packet.z());
			chunks.put(chunkKey(packet.x(), packet.z()), sections);
		}

		static long chunkKey(int x, int z) {
			return ((long) x << 32) | (z & 0xffffffffL);
		}

		/** The block the client believes is at a position, or null when that chunk is not loaded. */
		BlockState block(BlockPos pos) {
			BlockState changed = changedBlocks.get(pos);
			if (changed != null) return changed;
			LevelChunkSection[] sections = chunks.get(chunkKey(pos.getX() >> 4, pos.getZ() >> 4));
			int section = (pos.getY() - MIN_Y) >> 4;
			if (sections == null || section < 0 || section >= SECTIONS) return null;
			return sections[section].getBlockState(pos.getX() & 15, pos.getY() & 15, pos.getZ() & 15);
		}

		String describe(BlockPos pos) {
			return String.valueOf(block(pos));
		}

		<T extends Packet<?>> List<T> received(Class<T> type) {
			return (List<T>) packets.stream().filter(type::isInstance).toList();
		}

		<T extends Packet<?>> boolean awaitPacket(Class<T> type, Predicate<T> matches) throws InterruptedException {
			return until(() -> received(type).stream().anyMatch(matches));
		}

		boolean sawChat(String text) throws InterruptedException {
			return awaitPacket(ClientboundSystemChatPacket.class, p -> p.content().getString().contains(text));
		}

		void command(String line) throws Exception {
			send(new ServerboundChatCommandPacket(line));
		}

		void hold(Item item) throws Exception {
			send(new ServerboundSetCreativeModeSlotPacket(37, new ItemStack(item)));
			send(new ServerboundSetCarriedItemPacket(1));
			Thread.sleep(60);
		}

		/** A right click on a face of a block, at the middle of that face unless `height` says otherwise. */
		void click(BlockPos pos, Direction face, double height) throws Exception {
			Vec3 at = new Vec3(pos.getX() + 0.5 + face.getStepX() * 0.5, pos.getY() + height, pos.getZ() + 0.5 + face.getStepZ() * 0.5);
			send(new ServerboundUseItemOnPacket(InteractionHand.MAIN_HAND, new BlockHitResult(at, face, pos, false), sequence++));
		}

		void click(BlockPos pos, Direction face) throws Exception {
			click(pos, face, face == Direction.UP ? 1 : face == Direction.DOWN ? 0 : 0.5);
		}

		void breakBlock(BlockPos pos) throws Exception {
			send(new ServerboundPlayerActionPacket(ServerboundPlayerActionPacket.Action.START_DESTROY_BLOCK, pos, Direction.UP, sequence++));
		}

		/** Tells the server where the player is and which way they look. */
		void moveTo(double x, double y, double z, float yaw, float pitch) throws Exception {
			position = new Vec3(x, y, z);
			send(new ServerboundMovePlayerPacket.PosRot(x, y, z, yaw, pitch, true, false));
		}
	}

	static boolean is(BlockState state, net.minecraft.world.level.block.Block block, String... properties) {
		if (state == null || !state.is(block)) return false;
		for (String pair : properties) {
			String[] parts = pair.split("=");
			Property<?> property = state.getBlock().getStateDefinition().getProperty(parts[0]);
			if (property == null || !String.valueOf(state.getValue(property)).equals(parts[1])) return false;
		}
		return true;
	}

	public static void main(String[] args) throws Exception {
		String host = args.length > 0 ? args[0] : "127.0.0.1";
		int port = args.length > 1 ? Integer.parseInt(args[1]) : 25565;
		SharedConstants.tryDetectVersion();
		Bootstrap.bootStrap();
		say("Judging with Minecraft " + SharedConstants.getCurrentVersion().name() + " (protocol " + SharedConstants.getProtocolVersion() + ")");

		try {
			run(host, port);
		} catch (Throwable problem) {
			check("the run finishes", false, problem);
			if (System.getenv("CONFORMANCE_TRACE") != null) problem.printStackTrace();
		}
		say(failures == 0 ? "\nAll checks passed." : "\n" + failures + " check(s) failed.");
		System.exit(failures == 0 ? 0 : 1);
	}

	static void run(String host, int port) throws Exception {
		String suffix = Long.toString(System.nanoTime() % 1679616, 36);
		// A fresh spot each run, because the world remembers earlier runs.
		int baseX = 1000 + (int) (Math.random() * 100_000);
		int baseZ = 1000 + (int) (Math.random() * 100_000);

		// ---- server list ping ----
		ClientboundStatusResponsePacket status = new Client(host, port, "ping").ping();
		check("server list ping decodes", status.status().version().isPresent(), status.status().version().map(v -> v.name() + ", protocol " + v.protocol()).orElse("no version"));
		check("the server announces this protocol", status.status().version().map(v -> v.protocol() == SharedConstants.getProtocolVersion()).orElse(false));

		// ---- joining ----
		boolean joinOnly = System.getenv("JOIN_ONLY") != null;
		Client alice = new Client(host, port, joinOnly && System.getenv("PLAYER") != null ? System.getenv("PLAYER") : "alice_" + suffix);
		alice.join();
		boolean inGame = until(() -> alice.error != null || alice.entityId >= 0, 15000);
		check("login and configuration are accepted", inGame && alice.error == null, alice.error);
		if (alice.error != null) return;
		check("registries build from what the server sent", alice.registries != null, alice.registryData.size() + " registries, " + alice.tags.size() + " tagged");
		check("the server offered this version's data pack", alice.offeredPacks.contains(KnownPack.vanilla("core")), alice.offeredPacks);
		check("registry entries came as names only", !alice.entriesSentInFull);
		check("a first position arrives", until(() -> alice.position != null), alice.position);
		check("spawn chunks decode", until(() -> alice.error != null || alice.chunks.size() >= 9), alice.chunks.size() + " chunks");
		check("the plugin's greeting arrives", alice.sawChat("Welcome, " + alice.name));
		if (joinOnly) {
			until(() -> alice.error != null || alice.chunks.size() >= 49, 8000);
			int built = 0;
			for (int x = -24; x <= 24; x++) for (int z = -24; z <= 24; z++) for (int y = -60; y <= -50; y++) {
				BlockState state = alice.block(new BlockPos(x, y, z));
				if (state != null && !state.isAir()) built++;
			}
			say("     " + alice.chunks.size() + " chunks read, " + built + " blocks above the ground within 24 blocks of spawn, " + alice.blockEntities.size() + " block entities");
			for (ClientboundPlayerInfoUpdatePacket listing : alice.received(ClientboundPlayerInfoUpdatePacket.class)) {
				for (ClientboundPlayerInfoUpdatePacket.Entry entry : listing.newEntries()) {
					var textures = entry.profile().properties().get("textures");
					boolean signed = textures.stream().anyMatch(property -> property.signature() != null && !property.signature().isEmpty());
					say("     online: " + entry.profile().name() + (textures.isEmpty() ? ", no skin" : signed ? ", skin with a signature" : ", skin WITHOUT a signature"));
				}
			}
			check("nothing received was unreadable", alice.error == null, alice.error);
			alice.quit();
			return;
		}

		alice.command("tp " + baseX + ".5 -60 " + baseZ + ".5");
		check("a command moves the player", until(() -> alice.position != null && Math.abs(alice.position.x - (baseX + 0.5)) < 0.01), alice.position);
		BlockPos feet = new BlockPos(baseX, -60, baseZ);
		check("chunks around the new place decode", until(() -> alice.error != null || alice.block(feet) != null));
		check("the ground is grass", is(alice.block(feet.below()), Blocks.GRASS_BLOCK), alice.describe(feet.below()));
		check("bedrock is at the bottom", is(alice.block(new BlockPos(baseX, -64, baseZ)), Blocks.BEDROCK), alice.describe(new BlockPos(baseX, -64, baseZ)));
		check("above the ground is air", is(alice.block(feet), Blocks.AIR), alice.describe(feet));

		// ---- a second player ----
		Client bob = new Client(host, port, "bob_" + suffix);
		bob.join();
		check("a second player joins", until(() -> bob.error != null || bob.entityId >= 0, 15000) && bob.error == null, bob.error);
		if (bob.error != null) return;
		check("the first player is told", alice.sawChat(bob.name + " joined"));
		check("the first player gets the newcomer's tab list entry",
			alice.awaitPacket(ClientboundPlayerInfoUpdatePacket.class, p -> p.newEntries().stream().anyMatch(e -> e.profile().name().equals(bob.name))));
		check("the first player gets the newcomer's entity",
			alice.awaitPacket(ClientboundAddEntityPacket.class, p -> p.getId() == bob.entityId && p.getType() == EntityTypes.PLAYER));
		check("the newcomer gets the first player's entity",
			bob.awaitPacket(ClientboundAddEntityPacket.class, p -> p.getId() == alice.entityId && p.getType() == EntityTypes.PLAYER));
		bob.command("tp " + (baseX + 2) + ".5 -60 " + baseZ + ".5");
		check("the second player arrives", until(() -> bob.position != null && Math.abs(bob.position.x - (baseX + 2.5)) < 0.01 && bob.block(feet) != null), bob.position);

		// Alice looks north (yaw 180) from the middle of her block.
		alice.moveTo(baseX + 0.5, -60, baseZ + 0.5, 180, 0);
		Thread.sleep(150);

		// ---- building ----
		BlockPos ground = feet.below();
		alice.hold(Items.OAK_STAIRS);
		BlockPos stairs = feet.offset(-2, 0, -2);
		alice.click(stairs.below(), Direction.UP);
		check("stairs face the way the player looks", until(() -> is(bob.block(stairs), Blocks.OAK_STAIRS, "facing=north", "half=bottom", "shape=straight")), bob.describe(stairs));
		check("others see what the builder holds",
			bob.awaitPacket(ClientboundSetEquipmentPacket.class, p -> p.getEntity() == alice.entityId && p.getSlots().stream().anyMatch(s -> s.getFirst() == EquipmentSlot.MAINHAND && s.getSecond().is(Items.OAK_STAIRS))));
		check("others hear a block being placed", bob.awaitPacket(ClientboundSoundPacket.class, p -> p.getSound().value().location().getPath().equals("block.wood.place")),
			bob.received(ClientboundSoundPacket.class).stream().map(p -> p.getSound().value().location().getPath()).toList());

		alice.hold(Items.OAK_SLAB);
		BlockPos slab = feet.offset(2, 0, -2);
		alice.click(slab.below(), Direction.UP);
		check("a slab starts as a bottom slab", until(() -> is(bob.block(slab), Blocks.OAK_SLAB, "type=bottom")), bob.describe(slab));
		alice.click(slab, Direction.UP);
		check("a second slab makes a double slab", until(() -> is(bob.block(slab), Blocks.OAK_SLAB, "type=double")), bob.describe(slab));

		alice.hold(Items.OAK_DOOR);
		BlockPos door = feet.offset(0, 0, -3);
		alice.click(door.below(), Direction.UP);
		check("a door has two halves", until(() -> is(bob.block(door), Blocks.OAK_DOOR, "half=lower", "facing=north", "open=false") && is(bob.block(door.above()), Blocks.OAK_DOOR, "half=upper")),
			bob.describe(door) + " / " + bob.describe(door.above()));
		int soundsBefore = bob.received(ClientboundSoundPacket.class).size();
		alice.click(door, Direction.SOUTH);
		check("clicking a door opens it", until(() -> is(bob.block(door), Blocks.OAK_DOOR, "open=true") && is(bob.block(door.above()), Blocks.OAK_DOOR, "open=true")), bob.describe(door));
		check("others hear the door", until(() -> bob.received(ClientboundSoundPacket.class).size() > soundsBefore));
		alice.breakBlock(door);
		check("breaking a door removes both halves", until(() -> is(bob.block(door), Blocks.AIR) && is(bob.block(door.above()), Blocks.AIR)), bob.describe(door) + " / " + bob.describe(door.above()));

		alice.hold(Items.CHEST);
		BlockPos chest = feet.offset(4, 0, 0);
		alice.click(chest.below(), Direction.UP);
		check("a chest faces the player", until(() -> is(bob.block(chest), Blocks.CHEST, "facing=south")), bob.describe(chest));

		// ---- signs ----
		alice.hold(Items.OAK_SIGN);
		BlockPos sign = feet.offset(-4, 0, 0);
		alice.click(sign.below(), Direction.UP);
		check("a sign stands facing the player", until(() -> is(bob.block(sign), Blocks.OAK_SIGN, "rotation=0")), bob.describe(sign));
		check("placing a sign opens its editor", alice.awaitPacket(ClientboundOpenSignEditorPacket.class, p -> p.pos().equals(sign)));
		alice.send(new ServerboundSignUpdatePacket(sign, List.of("hello sign", "", "line three", ""), SignTextSlot.FRONT));
		check("sign text reaches other players", until(() -> signLine(bob, sign, 0).equals("hello sign") && signLine(bob, sign, 2).equals("line three")), bob.blockEntities.get(sign));

		// ---- items and poses ----
		alice.send(new ServerboundPlayerActionPacket(ServerboundPlayerActionPacket.Action.DROP_ITEM, BlockPos.ZERO, Direction.DOWN, 0));
		check("a dropped item appears for others", bob.awaitPacket(ClientboundAddEntityPacket.class, p -> p.getType() == EntityTypes.ITEM));
		check("the dropped item says what it is",
			bob.awaitPacket(ClientboundSetEntityDataPacket.class, p -> p.packedItems().stream().anyMatch(v -> v.serializer() == EntityDataSerializers.ITEM_STACK && ((ItemStack) v.value()).is(Items.OAK_SIGN))));

		alice.send(new ServerboundPlayerInputPacket(new Input(false, false, false, false, false, true, false)));
		check("others see a player sneak",
			bob.awaitPacket(ClientboundSetEntityDataPacket.class, p -> p.id() == alice.entityId && p.packedItems().stream().anyMatch(v -> v.serializer() == EntityDataSerializers.POSE && v.value() == Pose.CROUCHING)));
		alice.send(new ServerboundPlayerInputPacket(Input.EMPTY));

		int before = bob.packets.size();
		alice.send(new ServerboundPunchPacket());
		check("others see an arm swing", until(() -> bob.packets.stream().skip(before).anyMatch(p -> p instanceof ClientboundSwingAnimationPacket swing && swing.entityId() == alice.entityId)),
			bob.packets.stream().skip(before).map(p -> p.getClass().getSimpleName()).distinct().toList());

		bob.send(new ServerboundPickItemFromBlockPacket(stairs, false));
		check("middle click gives the block's item", until(() -> bob.inventory.values().stream().anyMatch(stack -> stack.is(Items.OAK_STAIRS))), bob.inventory);

		// ---- leaving and coming back ----
		alice.hold(Items.DIAMOND_SWORD);
		check("others see the item in hand change",
			bob.awaitPacket(ClientboundSetEquipmentPacket.class, p -> p.getEntity() == alice.entityId && p.getSlots().stream().anyMatch(s -> s.getFirst() == EquipmentSlot.MAINHAND && s.getSecond().is(Items.DIAMOND_SWORD))));
		alice.quit();
		check("leaving removes the player from the tab list", bob.awaitPacket(ClientboundPlayerInfoRemovePacket.class, p -> true));
		check("leaving removes the player's entity", bob.awaitPacket(ClientboundRemoveEntitiesPacket.class, p -> p.entityIds().contains(alice.entityId)));
		Thread.sleep(300);

		Client again = new Client(host, port, alice.name);
		again.join();
		check("the player can come back", until(() -> again.error != null || again.entityId >= 0, 15000) && again.error == null, again.error);
		if (again.error != null) return;
		check("the position is remembered", until(() -> again.position != null) && Math.abs(again.position.x - (baseX + 0.5)) < 1.5, again.position);
		check("the inventory is remembered", until(() -> again.inventory.values().stream().anyMatch(stack -> stack.is(Items.DIAMOND_SWORD))), again.inventory);
		check("the selected hotbar slot is remembered", again.heldSlot == 1, "slot " + again.heldSlot);
		check("the chunk brings the sign back with its text", until(() -> again.error != null || again.block(sign) != null) && signLine(again, sign, 0).equals("hello sign"),
			again.describe(sign) + ", block entity " + again.blockEntities.get(sign) + ", " + again.chunks.size() + " chunks, at " + again.position);
		check("the chunk lists the chest", again.blockEntities.containsKey(chest), again.describe(chest));
		check("block states are remembered", is(again.block(stairs), Blocks.OAK_STAIRS, "facing=north"), again.describe(stairs));
		Thread.sleep(500);

		for (Client client : List.of(alice, bob, again)) check("nothing " + client.name + " received was unreadable", client.error == null, client.error);
		Map<String, Integer> seen = new java.util.TreeMap<>();
		for (Client client : List.of(alice, bob, again)) client.counts.forEach((type, count) -> seen.merge(type, count, Integer::sum));
		say("\nPacket types decoded: " + seen.size());
		seen.forEach((type, count) -> say("  " + count + " x " + type));
		bob.quit();
		again.quit();
	}

	/** A line of a sign's front text, read with the game's own codec for sign text. */
	static String signLine(Client client, BlockPos pos, int line) {
		CompoundTag tag = client.blockEntities.get(pos);
		if (tag == null || !tag.contains("front_text")) return "";
		SignText text = SignText.CODEC.parse(client.registries.createSerializationContext(NbtOps.INSTANCE), tag.get("front_text")).getOrThrow();
		return text.getMessages(false).get(line).getString();
	}
}
