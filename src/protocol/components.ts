// Item data components: what an item stack carries besides its type and count,
// such as enchantments, a name, a potion or the contents of a shulker box.
//
// On the wire a stack is its count, its item and a "patch": components added
// to the item's defaults, each a type id and a value, then types it removes.
// Each type has its own encoding, and there are over a hundred. A client
// sending a stack (the creative inventory) puts a length in front of every
// value; the server sending one does not, so whoever reads it must know every
// value's layout to find where the next one starts. A value that does not
// decode, or decodes to something the game refuses, disconnects the client
// reading it.
//
// So nothing a client sent is passed on to another client on trust. The
// components below are understood: their bytes are read field by field, every
// number and registry id is checked, text is rebuilt from the parts that are
// plain text and style, and the server writes the value out again itself.
// Only such "checked" components are shown to other players, dropped, picked
// up by someone else and saved. Any other component, or one that fails its
// check, is kept with the stack for as long as it stays with the player who
// sent it, and is lost when it leaves them (dropped, saved, or shown).

import { ProtocolError, Reader, Writer } from "../net/bytes";
import { readNbt, writeNbt, type Nbt, type ReadTag } from "../net/nbt";
import { PROTOCOL, componentId, componentName, data, registrySize, stackSize } from "./version";

export interface Component {
	type: number;
	/** The value as the server writes it, or null when the stack removes this component from its item. */
	value: Uint8Array | null;
	/** Understood and checked here, see above. */
	checked: boolean;
}

export interface Stack {
	item: number;
	count: number;
	/** Sorted by type. Absent or empty when the stack is just its item. */
	components?: readonly Component[];
}

/** Who a stack is written for. */
export type Audience = "owner" | "others";

/** Largest value of one component kept, as received. */
const MAX_COMPONENT_BYTES = 4096;
/** Largest `container` value: up to 27 stacks with components of their own. */
const MAX_CONTAINER_BYTES = 8192;
/**
 * Largest total of a stack's component values. A full inventory is then at
 * most about 370 KB in memory and in its storage row, and a hostile client
 * cannot use components to fill the Durable Object's memory.
 */
const MAX_STACK_BYTES = 8192;
/** More added or removed components than this in one stack is a broken packet: the game has about 120 types. */
const MAX_PATCH_ENTRIES = 256;
/** Containers in containers in a stack: a shulker box holding a filled chest is 2. */
const MAX_CONTAINER_DEPTH = 2;
const MAX_NBT_DEPTH = 16;

const ITEM_COUNT = registrySize("minecraft:item");
const COMPONENT_COUNT = data.componentTypes.length;

// ---- reading checked values --------------------------------------------------
//
// Each check reads one value as the game's codec would, refuses anything it
// would refuse (and some things it would allow but no honest client sends),
// and writes the value again. Lists are capped well below the game's limits.

/** `depth` is how many containers the value is in: 0 for a component of the stack itself. */
type Check = (r: Reader, w: Writer, depth: number) => void;

function refuse(why: string): never {
	throw new ProtocolError(why);
}

function varint(r: Reader, w: Writer, min: number, max: number): number {
	const value = r.varint();
	if (value < min || value > max) refuse(`${value} is out of range`);
	w.varint(value);
	return value;
}

function int(r: Reader, w: Writer): void {
	w.i32(r.i32());
}

function bool(r: Reader, w: Writer): boolean {
	const value = r.u8() !== 0; // the game takes any byte but 0 as true
	w.bool(value);
	return value;
}

function count(r: Reader, w: Writer, max: number): number {
	return varint(r, w, 0, max);
}

function string(r: Reader, w: Writer, maxLength: number, pattern?: RegExp): string {
	const value = r.string(maxLength);
	if (pattern && !pattern.test(value)) refuse("Unexpected characters");
	w.string(value);
	return value;
}

function optional(r: Reader, w: Writer, value: () => void): void {
	if (bool(r, w)) value();
}

/** An entry of a registry, by id. */
function entry(r: Reader, w: Writer, registry: string): void {
	varint(r, w, 0, registrySize(registry) - 1);
}

/**
 * An entry of a registry that could also be spelled out in full: 0 means a
 * full definition follows, anything else is the id plus one. Only ids are
 * accepted.
 */
function reference(r: Reader, w: Writer, registry: string): void {
	varint(r, w, 1, registrySize(registry));
}

const dyeColor = (r: Reader, w: Writer) => void varint(r, w, 0, 15);
const uuid = (r: Reader, w: Writer) => void w.bytes(r.bytes(16));

const PLAYER_NAME = /^[A-Za-z0-9_]{1,16}$/;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
const IDENTIFIER_PART = /^[a-z0-9_.]+$/;

/** A mob effect's strength and duration, and the weaker one it hides. */
function effectDetails(r: Reader, w: Writer, hidden: number): void {
	varint(r, w, 0, 255); // amplifier
	varint(r, w, -1, 0x7fffffff); // duration, -1 is forever
	bool(r, w); // ambient
	bool(r, w); // particles
	bool(r, w); // icon
	optional(r, w, () => (hidden < 4 ? effectDetails(r, w, hidden + 1) : refuse("Too many hidden effects")));
}

function fireworkExplosion(r: Reader, w: Writer): void {
	varint(r, w, 0, 4); // shape
	for (let list = 0; list < 2; list++) {
		const colors = count(r, w, 16); // colours, then fade colours
		for (let i = 0; i < colors; i++) int(r, w);
	}
	bool(r, w); // trail
	bool(r, w); // twinkle
}

function profileProperties(r: Reader, w: Writer): void {
	const properties = count(r, w, 1);
	for (let i = 0; i < properties; i++) {
		if (string(r, w, 64) !== "textures") refuse("Only a skin may be attached to a profile");
		string(r, w, 2048, BASE64);
		optional(r, w, () => string(r, w, 1024, BASE64)); // signature
	}
}

/** A stack inside a container, in the form the server writes (no lengths). */
function containedStack(r: Reader, w: Writer, depth: number): void {
	const item = varint(r, w, 1, ITEM_COUNT - 1); // never air
	varint(r, w, 1, stackSize(item));
	const added = count(r, w, 32);
	const removed = count(r, w, 32);
	for (let i = 0; i < added; i++) {
		const type = r.varint();
		const check = checks.get(type);
		if (!check || (type === CONTAINER && depth + 1 >= MAX_CONTAINER_DEPTH)) refuse("A contained stack has a component that is not understood, or is nested too deeply");
		w.varint(type);
		check(r, w, depth + 1);
	}
	for (let i = 0; i < removed; i++) {
		const type = r.varint();
		if (!checks.has(type)) refuse("A contained stack removes a component that is not understood");
		w.varint(type);
	}
}

const CHECKS: Record<string, Check> = {
	custom_name: (r, w) => text(r, w),
	item_name: (r, w) => text(r, w),
	lore: (r, w) => {
		const lines = count(r, w, 64);
		for (let i = 0; i < lines; i++) text(r, w);
	},
	rarity: (r, w) => void varint(r, w, 0, 3),
	enchantments: (r, w) => enchantments(r, w),
	stored_enchantments: (r, w) => enchantments(r, w),
	enchantment_glint_override: (r, w) => void bool(r, w),
	unbreakable: () => {},
	damage: (r, w) => void varint(r, w, 0, 1 << 20),
	repair_cost: (r, w) => void varint(r, w, 0, 0x7fffffff),
	dyed_color: int,
	base_color: dyeColor,
	potion_contents: (r, w) => {
		optional(r, w, () => entry(r, w, "minecraft:potion"));
		optional(r, w, () => int(r, w)); // custom colour
		const effects = count(r, w, 16);
		for (let i = 0; i < effects; i++) {
			entry(r, w, "minecraft:mob_effect");
			effectDetails(r, w, 0);
		}
		optional(r, w, () => string(r, w, 64, IDENTIFIER_PART)); // the name's translation key suffix
	},
	suspicious_stew_effects: (r, w) => {
		const effects = count(r, w, 16);
		for (let i = 0; i < effects; i++) {
			entry(r, w, "minecraft:mob_effect");
			varint(r, w, -1, 0x7fffffff); // duration
		}
	},
	ominous_bottle_amplifier: (r, w) => void varint(r, w, 0, 4),
	fireworks: (r, w) => {
		varint(r, w, 0, 255); // flight duration
		const explosions = count(r, w, 16);
		for (let i = 0; i < explosions; i++) fireworkExplosion(r, w);
	},
	firework_explosion: fireworkExplosion,
	banner_patterns: (r, w) => {
		const layers = count(r, w, 16);
		for (let i = 0; i < layers; i++) {
			reference(r, w, "minecraft:banner_pattern");
			dyeColor(r, w);
		}
	},
	tooltip_display: (r, w) => {
		bool(r, w); // hide the whole tooltip
		const hidden = count(r, w, COMPONENT_COUNT);
		for (let i = 0; i < hidden; i++) varint(r, w, 0, COMPONENT_COUNT - 1);
	},
	instrument: (r, w) => reference(r, w, "minecraft:instrument"),
	"painting/variant": (r, w) => reference(r, w, "minecraft:painting_variant"),
	block_state: (r, w) => {
		const properties = count(r, w, 16);
		for (let i = 0; i < properties; i++) {
			string(r, w, 64, IDENTIFIER_PART);
			string(r, w, 64, IDENTIFIER_PART);
		}
	},
	profile: (r, w) => {
		if (bool(r, w)) {
			// A complete profile: id, name and properties.
			uuid(r, w);
			string(r, w, 16, PLAYER_NAME);
			profileProperties(r, w);
		} else {
			optional(r, w, () => string(r, w, 16, PLAYER_NAME));
			optional(r, w, () => uuid(r, w));
			profileProperties(r, w);
		}
		// Then a skin, cape, elytra and model chosen from the game's own
		// textures, overriding the profile's. None are accepted.
		for (let i = 0; i < 4; i++) if (bool(r, w)) refuse("Skin overrides are not accepted");
	},
	container: (r, w, depth) => {
		const slots = count(r, w, 27);
		for (let i = 0; i < slots; i++) optional(r, w, () => containedStack(r, w, depth));
	},
};

function enchantments(r: Reader, w: Writer): void {
	const entries = count(r, w, 64);
	for (let i = 0; i < entries; i++) {
		entry(r, w, "minecraft:enchantment");
		varint(r, w, 1, 255); // level
	}
}

/** Checks by type id, for the types this game version has. */
const checks = new Map<number, Check>();
for (const [name, check] of Object.entries(CHECKS)) {
	const id = componentId(name);
	if (id !== undefined) checks.set(id, check);
}
const CONTAINER = componentId("container") ?? -1;
/** Checked, but only good for whoever holds the stack, so not shown to others. */
const NOT_SHOWN = new Set([CONTAINER, componentId("lore") ?? -1]);

// ---- text --------------------------------------------------------------------
//
// Text is NBT read through the game's text codec, which accepts far more than
// text: scores, entity selectors, NBT lookups, click and hover events. Only
// literal text, translations and key names are taken, with colour and the
// bold/italic/underlined/strikethrough/obfuscated flags. Anything else that
// selects what the text is refuses it; any other style is dropped.

const TEXT_MAX_DEPTH = 8;
const TEXT_MAX_PARTS = 64;
const TEXT_MAX_CHARACTERS = 512;
const COLORS = new Set([
	"black", "dark_blue", "dark_green", "dark_aqua", "dark_red", "dark_purple", "gold", "gray",
	"dark_gray", "blue", "green", "aqua", "red", "light_purple", "yellow", "white",
]);
const FLAGS = ["bold", "italic", "underlined", "strikethrough", "obfuscated"];
const OTHER_CONTENTS = ["score", "selector", "nbt", "object", "sprite", "atlas", "player"];

function text(r: Reader, w: Writer): void {
	writeNbt(w, textPart(readNbt(r, MAX_NBT_DEPTH), 0, { parts: TEXT_MAX_PARTS, characters: TEXT_MAX_CHARACTERS }));
}

function spend(budget: { parts: number; characters: number }, characters: number): void {
	budget.parts--;
	budget.characters -= characters;
	if (budget.parts < 0 || budget.characters < 0) refuse("The text is too long");
}

/** A list may wrap each element in a compound with an empty key, when its elements are not all of one type. */
function unwrap(tag: ReadTag): ReadTag {
	return tag instanceof Map && tag.size === 1 && tag.has("") ? tag.get("")! : tag;
}

function stringOf(tag: ReadTag | undefined, maxLength: number): string {
	if (typeof tag !== "string" || tag.length > maxLength) refuse("Expected a short string");
	return tag;
}

type TextNbt = string | { [key: string]: Nbt };

function textPart(tag: ReadTag, depth: number, budget: { parts: number; characters: number }): TextNbt {
	if (depth > TEXT_MAX_DEPTH) refuse("The text is nested too deeply");
	if (typeof tag === "string") {
		spend(budget, tag.length);
		return tag;
	}
	if (Array.isArray(tag)) {
		// A list is its first element followed by the rest.
		if (tag.length === 0) refuse("Empty text list");
		const [first, ...rest] = tag.map(unwrap);
		const out = asCompound(textPart(first!, depth + 1, budget));
		const extra = [...((out.extra as Nbt[] | undefined) ?? []), ...rest.map((part) => asCompound(textPart(part, depth + 1, budget)))];
		return extra.length > 0 ? { ...out, extra } : out;
	}
	if (!(tag instanceof Map)) refuse("Not text");

	const out: { [key: string]: Nbt } = {};
	const type = tag.get("type");
	if (OTHER_CONTENTS.some((key) => tag.has(key)) || (type !== undefined && !["text", "translatable", "keybind"].includes(stringOf(type, 16)))) {
		refuse("Only plain text is accepted");
	}
	if (tag.has("text")) {
		out.text = stringOf(tag.get("text"), TEXT_MAX_CHARACTERS);
		spend(budget, out.text.length);
	} else if (tag.has("translate")) {
		out.translate = stringOf(tag.get("translate"), 256);
		spend(budget, out.translate.length);
		if (tag.has("fallback")) {
			out.fallback = stringOf(tag.get("fallback"), TEXT_MAX_CHARACTERS);
			spend(budget, out.fallback.length);
		}
		const args = tag.get("with");
		if (args !== undefined) {
			if (!Array.isArray(args) || args.length === 0 || args.length > 16) refuse("Bad translation arguments");
			out.with = args.map(unwrap).map((arg) => {
				// An argument may also be a plain number or yes/no, shown as written.
				if (typeof arg === "number" || typeof arg === "bigint") return { text: String(arg) };
				return asCompound(textPart(arg, depth + 1, budget));
			});
		}
	} else if (tag.has("keybind")) {
		out.keybind = stringOf(tag.get("keybind"), 64);
		if (!IDENTIFIER_PART.test(out.keybind)) refuse("Bad key name");
		spend(budget, out.keybind.length);
	} else refuse("Text without content");

	const color = tag.get("color");
	if (color !== undefined) {
		const name = stringOf(color, 16);
		if (!COLORS.has(name) && !/^#[0-9a-fA-F]{6}$/.test(name)) refuse("Bad colour");
		out.color = name;
	}
	for (const flag of FLAGS) {
		const value = tag.get(flag);
		if (value === undefined) continue;
		if (typeof value !== "number") refuse("Bad style flag");
		out[flag] = value !== 0;
	}
	const extra = tag.get("extra");
	if (extra !== undefined) {
		if (!Array.isArray(extra) || extra.length === 0) refuse("Bad extra text");
		out.extra = extra.map(unwrap).map((part) => asCompound(textPart(part, depth + 1, budget)));
	}
	return Object.keys(out).length === 1 && out.text !== undefined ? (out.text as string) : out;
}

function asCompound(part: TextNbt): { [key: string]: Nbt } {
	return typeof part === "string" ? { text: part } : part;
}

// ---- stacks --------------------------------------------------------------------

/** Checks a value as received. One that fails is kept as it came, unchecked. */
function checkValue(type: number, raw: Uint8Array): Component {
	const check = checks.get(type);
	if (check) {
		try {
			const r = new Reader(raw);
			const w = new Writer(raw.length + 16);
			check(r, w, 0);
			if (r.remaining === 0 && w.length <= maxBytes(type)) return { type, value: w.finish(), checked: true };
		} catch {
			// not what the game would read: kept unchecked
		}
	}
	return { type, value: raw.slice(), checked: false };
}

function maxBytes(type: number): number {
	return type === CONTAINER ? MAX_CONTAINER_BYTES : MAX_COMPONENT_BYTES;
}

/** Sorts by type and keeps within the size limit of a stack, checked components first. */
function finish(byType: Map<number, Component>): Component[] | undefined {
	let budget = MAX_STACK_BYTES;
	const kept: Component[] = [];
	for (const checked of [true, false]) {
		for (const component of byType.values()) {
			if (component.checked !== checked) continue;
			const size = component.value?.length ?? 0;
			if (size > budget) continue;
			budget -= size;
			kept.push(component);
		}
	}
	return kept.length === 0 ? undefined : kept.sort((a, b) => a.type - b.type);
}

function componentType(r: Reader): number {
	const type = r.varint();
	if (type < 0 || type >= COMPONENT_COUNT) throw new ProtocolError(`Unknown item component type ${type}`);
	return type;
}

/**
 * Reads a stack the way a client sends one, with the length of each value in
 * front of it. Undefined for an empty stack. A stack the game itself could
 * not have written (an unknown item or component type, a length past the end)
 * throws; a component that is merely not understood, or too large, does not.
 */
export function readClientStack(r: Reader): Stack | undefined {
	const count = r.varint();
	if (count <= 0) return undefined;
	const item = r.varint();
	if (item < 0 || item >= ITEM_COUNT) throw new ProtocolError(`Unknown item ${item}`);
	const added = r.varint();
	const removed = r.varint();
	if (added < 0 || removed < 0 || added + removed > MAX_PATCH_ENTRIES) throw new ProtocolError("Too many item components");
	const byType = new Map<number, Component>();
	for (let i = 0; i < added; i++) {
		const type = componentType(r);
		const length = r.varint();
		if (length < 0 || length > r.remaining) throw new ProtocolError("Item component runs past the end");
		const raw = r.bytes(length);
		if (length > maxBytes(type)) byType.delete(type); // too large to keep
		else byType.set(type, checkValue(type, raw));
	}
	for (let i = 0; i < removed; i++) {
		const type = componentType(r);
		byType.set(type, { type, value: null, checked: checks.has(type) });
	}
	if (item === 0) return undefined; // air
	return { item, count, components: finish(byType) };
}

function visible(stack: Stack, audience: Audience): readonly Component[] {
	const components = stack.components ?? [];
	return audience === "owner" ? components : components.filter((c) => c.checked && !NOT_SHOWN.has(c.type));
}

/** Writes a stack the way the server sends one. An absent stack is an empty slot. */
export function writeStack(w: Writer, stack: Stack | undefined, audience: Audience): void {
	if (!stack || stack.count <= 0) {
		w.varint(0);
		return;
	}
	w.varint(stack.count).varint(stack.item);
	const components = visible(stack, audience);
	const added = components.filter((c) => c.value !== null);
	w.varint(added.length).varint(components.length - added.length);
	for (const c of added) w.varint(c.type).bytes(c.value!);
	for (const c of components) if (c.value === null) w.varint(c.type);
}

/** The components that may leave the player who holds the stack: dropped, or saved. */
export function portable(components: readonly Component[] | undefined): readonly Component[] | undefined {
	const kept = components?.filter((c) => c.checked);
	return kept && kept.length > 0 ? kept : undefined;
}

function sameBytes(a: Uint8Array | null, b: Uint8Array | null): boolean {
	if (a === null || b === null) return a === b;
	return a.length === b.length && a.every((byte, i) => byte === b[i]);
}

/** Whether two stacks are the same item with the same components, so that they stack. */
export function sameKind(a: Stack, b: Stack): boolean {
	if (a.item !== b.item) return false;
	const x = a.components ?? [];
	const y = b.components ?? [];
	return x.length === y.length && x.every((c, i) => c.type === y[i]!.type && c.checked === y[i]!.checked && sameBytes(c.value, y[i]!.value));
}

/** Identifies what other players see of a stack, to tell when that changes. */
export function shownAs(stack: Stack | undefined): string {
	if (!stack) return "";
	let key = String(stack.item);
	for (const c of visible(stack, "others")) key += `|${c.type}:${c.value === null ? "-" : base64(c.value)}`;
	return key;
}

// ---- storage -------------------------------------------------------------------
//
// Items are stored by name. Component types are too, but their values hold ids
// (of enchantments, potions, items in a container) that belong to one game
// version. Saved components therefore carry the protocol they were saved
// under, and are dropped, keeping the item, when the server speaks another.
// Values are checked again when they are loaded.

export interface SavedComponents {
	/** The protocol they were saved under. */
	v: number;
	/** Type name and value in base64, or null for a removed component. */
	c: [type: string, value: string | null][];
}

export function saveComponents(components: readonly Component[] | undefined): SavedComponents | undefined {
	const kept = portable(components);
	if (!kept) return undefined;
	return { v: PROTOCOL, c: kept.map((c) => [componentName(c.type)!, c.value === null ? null : base64(c.value)]) };
}

/** Never throws: whatever does not load is left out. */
export function loadComponents(saved: unknown): Component[] | undefined {
	const s = saved as SavedComponents | undefined;
	if (!s || s.v !== PROTOCOL || !Array.isArray(s.c)) return undefined;
	const byType = new Map<number, Component>();
	for (const entry of s.c) {
		if (!Array.isArray(entry) || typeof entry[0] !== "string") continue;
		const type = componentId(entry[0]);
		if (type === undefined || !checks.has(type)) continue;
		if (entry[1] === null) {
			byType.set(type, { type, value: null, checked: true });
			continue;
		}
		let raw: Uint8Array;
		try {
			raw = unbase64(String(entry[1]));
		} catch {
			continue;
		}
		const component = raw.length <= maxBytes(type) ? checkValue(type, raw) : undefined;
		if (component?.checked) byType.set(type, component);
	}
	return finish(byType);
}

function base64(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary);
}

function unbase64(text: string): Uint8Array {
	return Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
}
