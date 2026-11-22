// Asks the game's own code for what its data reports leave out. Compiled and
// run by gen-data.mjs against the server jar; the server is never started.
//
// Prints one JSON object: for every block its Java class, whether it can be
// walked through, whether it fills its cube, its block entity type, its
// sounds, what each of its states offers to blocks resting on it, and which
// classes decide whether it can stay where it is; plus the ids the protocol
// uses for entity data.

import java.lang.reflect.Field;
import java.lang.reflect.Modifier;
import java.util.ArrayList;
import java.util.List;
import net.minecraft.SharedConstants;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.tags.TagKey;
import net.minecraft.world.level.BlockGetter;
import net.minecraft.world.level.LevelReader;
import net.minecraft.world.level.block.SupportType;
import net.minecraft.world.level.block.state.BlockBehaviour;
import net.minecraft.world.level.material.FluidState;
import net.minecraft.world.level.material.Fluids;
import net.minecraft.world.phys.shapes.VoxelShape;
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
			List<String> faces = new ArrayList<>();
			int firstId = Block.getId(block.getStateDefinition().getPossibleStates().get(0));
			for (BlockState each : block.getStateDefinition().getPossibleStates()) {
				if (Block.getId(each) != firstId + faces.size()) throw new IllegalStateException("States of " + block + " are not numbered in order");
				faces.add(Integer.toString(faces(each)));
			}
			blocks.add(
				quote(BuiltInRegistries.BLOCK.getKey(block).getPath()) + ":{" +
				"\"class\":" + quote(named.getSimpleName()) +
				",\"faces\":[" + String.join(",", faces) + "]" +
				survival(block) +
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

	/**
	 * What other blocks may rest on or hang from this state, as bits. In the
	 * order of Direction (down, up, north, south, west, east), from bit 0: the
	 * faces that are sturdy for a full block, then for something in the centre
	 * (a torch), then for something rigid (a rail); the faces its support or
	 * collision shape fill completely (what a vine clings to); whether the
	 * collision shape fills the top face and the bottom face; isSolid;
	 * isSolidRender; whether the collision shape touches the top face at all;
	 * and its fluid: 0 none, 1 water, 2 flowing water, 3 lava. States are
	 * asked in the order the game numbers them.
	 */
	private static int faces(BlockState state) {
		int bits = 0;
		try {
			VoxelShape support = state.getBlockSupportShape(EmptyBlockGetter.INSTANCE, BlockPos.ZERO);
			VoxelShape collision = state.getCollisionShape(EmptyBlockGetter.INSTANCE, BlockPos.ZERO);
			for (Direction face : Direction.values()) {
				int f = face.ordinal();
				if (state.isFaceSturdy(EmptyBlockGetter.INSTANCE, BlockPos.ZERO, face, SupportType.FULL)) bits |= 1 << f;
				if (state.isFaceSturdy(EmptyBlockGetter.INSTANCE, BlockPos.ZERO, face, SupportType.CENTER)) bits |= 1 << (6 + f);
				if (state.isFaceSturdy(EmptyBlockGetter.INSTANCE, BlockPos.ZERO, face, SupportType.RIGID)) bits |= 1 << (12 + f);
				if (Block.isFaceFull(support, face) || Block.isFaceFull(collision, face)) bits |= 1 << (18 + f);
			}
			if (Block.isFaceFull(collision, Direction.UP)) bits |= 1 << 24;
			if (Block.isFaceFull(collision, Direction.DOWN)) bits |= 1 << 25;
			if (!collision.getFaceShape(Direction.UP).isEmpty()) bits |= 1 << 28;
		} catch (RuntimeException needsARealWorld) {
			// Shapes that depend on the world around them: nothing rests on these.
		}
		if (state.isSolid()) bits |= 1 << 26;
		if (state.isSolidRender()) bits |= 1 << 27;
		FluidState fluid = state.getFluidState();
		if (fluid.is(Fluids.WATER)) bits |= 1 << 29;
		else if (fluid.is(Fluids.FLOWING_WATER)) bits |= 2 << 29;
		else if (fluid.is(Fluids.LAVA) || fluid.is(Fluids.FLOWING_LAVA)) bits |= 3 << 29; // tags are not bound here
		return bits;
	}

	/**
	 * Which of the game's classes decide whether this block can stay where it
	 * is: the one that declares its canSurvive (left out when that is the
	 * default, which always says yes) and its mayPlaceOn, plus the tags and the
	 * growth direction the block was built with.
	 */
	private static String survival(Block block) {
		Class<?> survive = declaring(block.getClass(), "canSurvive", BlockState.class, LevelReader.class, BlockPos.class);
		if (survive == null || survive == BlockBehaviour.class) return "";
		Class<?> mayPlaceOn = declaring(block.getClass(), "mayPlaceOn", BlockState.class, BlockGetter.class, BlockPos.class);
		List<String> tags = new ArrayList<>();
		String growth = null;
		for (Class<?> type = block.getClass(); type != null; type = type.getSuperclass()) {
			for (Field field : type.getDeclaredFields()) {
				if (Modifier.isStatic(field.getModifiers())) continue;
				try {
					field.setAccessible(true);
					Object value = field.get(block);
					if (value instanceof TagKey<?> tag) tags.add(quote(field.getName()) + ":" + quote(tag.location().getPath()));
					else if (value instanceof Direction direction && field.getName().equals("growthDirection")) growth = direction.getSerializedName();
				} catch (ReflectiveOperationException | RuntimeException inaccessible) {
					// not needed
				}
			}
		}
		return ",\"survive\":" + quote(survive.getSimpleName()) +
			(mayPlaceOn == null ? "" : ",\"mayPlaceOn\":" + quote(mayPlaceOn.getSimpleName())) +
			(tags.isEmpty() ? "" : ",\"tags\":{" + String.join(",", tags) + "}") +
			(growth == null ? "" : ",\"growth\":" + quote(growth));
	}

	private static Class<?> declaring(Class<?> type, String name, Class<?>... parameters) {
		for (; type != null; type = type.getSuperclass()) {
			try {
				type.getDeclaredMethod(name, parameters);
				return type;
			} catch (NoSuchMethodException notHere) {
				// keep looking
			}
		}
		return null;
	}

	private static String quote(String text) {
		return "\"" + text.replace("\\", "\\\\").replace("\"", "\\\"") + "\"";
	}
}
