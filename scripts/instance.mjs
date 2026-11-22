// Which local server to use. Unset INSTANCE means the default one; INSTANCE=<n>
// (1 to 99) a separate copy, started with `INSTANCE=<n> npm run dev`, that the
// tests then find without being told its port. See scripts/dev.mjs.

export function devInstance(env = process.env) {
	const value = env.INSTANCE ?? "";
	if (value === "") return { id: undefined, suffix: "", gamePort: 25565, httpPort: 8787, persistTo: ".wrangler/state" };
	if (!/^[1-9][0-9]?$/.test(value)) throw new Error(`INSTANCE must be a number from 1 to 99, not "${value}"`);
	const id = Number(value);
	return { id, suffix: `-${id}`, gamePort: 25570 + id, httpPort: 8790 + id, persistTo: `.wrangler/state-${id}` };
}
