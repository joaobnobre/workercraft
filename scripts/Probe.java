// Asks the game's own code for what its data reports leave out. Compiled and
// run by gen-data.mjs against the server jar; the server is never started.
//
// Prints one JSON object: for every block its Java class, whether it can be
// walked through, whether it fills its cube, its block entity type and its
// sounds; plus the ids the protocol uses for entity data.

import java.lang.reflect.Field;
import java.lang.reflect.Modifier;
import java.util.ArrayList;
import java.util.List;
import net.minecraft.SharedConstants;
import net.minecraft.core.BlockPos;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.network.syncher.EntityDataAccessor;
import net.minecraft.network.syncher.EntityDataSerializer;
import net.minecraft.network.syncher.EntityDataSerializers;
import net.minecraft.server.Bootstrap;
import net.minecraft.world.entity.Pose;
import net.minecraft.world.level.EmptyBlockGetter;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.SoundType;
import net.minecraft.world.level.block.entity.BlockEntityType;
import net.minecraft.world.level.block.state.BlockState;

public class Probe {
	public static void main(String[] args) throws Exception {
		SharedConstants.tryDetectVersion();
		Bootstrap.bootStrap();

		List<String> blocks = new ArrayList<>();
		for (Block block : BuiltInRegistries.BLOCK) {
			boolean passable = true;
			boolean fullCube = true;
			for (BlockState state : block.getStateDefinition().getPossibleStates()) {
				try {
					passable &= state.getCollisionShape(EmptyBlockGetter.INSTANCE, BlockPos.ZERO).isEmpty();
					fullCube &= state.isCollisionShapeFullBlock(EmptyBlockGetter.INSTANCE, BlockPos.ZERO);
				} catch (RuntimeException needsARealWorld) {
					passable = false;
					fullCube = false;
				}
			}
			BlockState state = block.defaultBlockState();
			int blockEntity = -1;
			if (state.hasBlockEntity()) {
				for (BlockEntityType<?> type : BuiltInRegistries.BLOCK_ENTITY_TYPE) {
					if (type.isValid(state)) blockEntity = BuiltInRegistries.BLOCK_ENTITY_TYPE.getId(type);
				}
			}
			Class<?> named = block.getClass();
			while (named.getSimpleName().isEmpty()) named = named.getSuperclass(); // anonymous subclasses
			SoundType sound = state.getSoundType();
			blocks.add(
				quote(BuiltInRegistries.BLOCK.getKey(block).getPath()) + ":{" +
				"\"class\":" + quote(named.getSimpleName()) +
				",\"passable\":" + passable +
				",\"fullCube\":" + fullCube +
				",\"blockEntity\":" + blockEntity +
				",\"placeSound\":" + BuiltInRegistries.SOUND_EVENT.getId(sound.getPlaceSound()) +
				",\"breakSound\":" + BuiltInRegistries.SOUND_EVENT.getId(sound.getBreakSound()) +
				",\"volume\":" + sound.getVolume() +
				",\"pitch\":" + sound.getPitch() + "}");
		}

		List<String> serializers = new ArrayList<>();
		for (Field field : EntityDataSerializers.class.getDeclaredFields()) {
			if (!Modifier.isStatic(field.getModifiers()) || !EntityDataSerializer.class.isAssignableFrom(field.getType())) continue;
			field.setAccessible(true);
			serializers.add(quote(field.getName()) + ":" + EntityDataSerializers.getSerializedId((EntityDataSerializer<?>) field.get(null)));
		}

		// Loading a class registers its entity data fields, so parents go first.
		List<String> accessors = new ArrayList<>();
		for (String name : new String[] { "Entity", "LivingEntity", "Avatar", "player.Player", "item.ItemEntity" }) {
			Class<?> type;
			try {
				type = Class.forName("net.minecraft.world.entity." + name);
			} catch (ClassNotFoundException notInThisVersion) {
				continue;
			}
			for (Field field : type.getDeclaredFields()) {
				if (!Modifier.isStatic(field.getModifiers()) || field.getType() != EntityDataAccessor.class) continue;
				field.setAccessible(true);
				accessors.add(quote(type.getSimpleName() + "." + field.getName()) + ":" + ((EntityDataAccessor<?>) field.get(null)).id());
			}
		}

		List<String> poses = new ArrayList<>();
		for (Pose pose : Pose.values()) poses.add(quote(pose.name()) + ":" + pose.ordinal());

		Bootstrap.realStdoutPrintln(
			"PROBE{\"blocks\":{" + String.join(",", blocks) + "}" +
			",\"entityDataSerializers\":{" + String.join(",", serializers) + "}" +
			",\"entityDataAccessors\":{" + String.join(",", accessors) + "}" +
			",\"poses\":{" + String.join(",", poses) + "}}");
		System.exit(0);
	}

	private static String quote(String text) {
		return "\"" + text.replace("\\", "\\\\").replace("\"", "\\\"") + "\"";
	}
}
