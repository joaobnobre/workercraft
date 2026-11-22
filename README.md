# workercraft

**A Minecraft server with no server.** The Java Edition protocol, written from
scratch in TypeScript, running on Cloudflare Workers. No JVM, no container, no
VM: a Worker takes the TCP connection and a Durable Object is the world.

A demo world runs at **`mc.bad.engineering`** (Java Edition 26.3). It is a
public creative world that checks nobody's account, so expect a mess, and it
may not stay up.

## How it works

Workers got [inbound TCP](https://developers.cloudflare.com/changelog/post/2026-11-19-inbound-tcp/)
in November 2026. That was the missing piece: a Minecraft client speaks a raw
TCP protocol, not HTTP.

```mermaid
flowchart LR
    game["Minecraft client"] -- "TCP" --> spectrum["Cloudflare Spectrum"]
    spectrum --> worker["Worker<br/>handshake, server list ping"]
    worker -- "TCP stream" --> world["Durable Object<br/>the world: players, chunks, SQLite"]
    world -- "RPC" --> plugins["Plugin Workers<br/>guard, welcome, builder"]
```

- **A Worker** accepts the connection and answers server list pings by itself,
  so the server shows as online without anything else running.
- **A Durable Object is the world.** It holds every player's connection, so
  broadcasting is a loop over a `Map`, and it is single-threaded, like a
  Minecraft server's main thread. Changed blocks are rows in its SQLite
  storage; an untouched chunk costs nothing.
- **Plugins are Workers.** Each hook (`onJoin`, `onBlockBreak`, ...) is an RPC
  call over a service binding, and the plugin gets a handle back to the world.
- **The version data is not copied by hand.** Packet ids, registries, tags,
  block states and collision are generated from Mojang's own server jar, and
  the test suite decodes the server's output with Mojang's own packet code.
  The rules of the game (how a stair turns a corner, which way a door hinges)
  are written here, block class by block class.

## Status

Speaks Minecraft **26.3** (protocol 777). Offline mode, creative, flat world.
It can also be built for 26.1.x (protocol 775); see [Tests](#tests).

Works, and covered by the tests:

- Server list ping, login, configuration, joining
- Chunks, with edits and player positions persisted across restarts
- Seeing other players join, move, sneak, swing and leave
- Chat, commands (`/list`, `/tp`), join and leave messages
- Breaking and placing blocks, with a reach check
- Blocks placed the way the game places them: logs along the clicked face,
  stairs and slabs by where the click landed, torches and signs on walls,
  doors and beds as two blocks, fences, panes, walls and stairs joining up
- What a block may be put on, by the game's own rule for each kind of block
  (torches, lanterns, signs, banners, buttons, levers, ladders, rails,
  pressure plates, carpets, doors, redstone, plants, sugar cane, cactus,
  vines, bells and more): a torch stands on a fence post but not on its side,
  a flower grows on grass but not on stone. A refused block is taken back on
  the player's screen. The same rule makes blocks fall off when what holds
  them is broken or changes, such as a torch on a trapdoor that opens
  ([What holds a block](#what-holds-a-block))
- Doors, trapdoors, fence gates, levers and buttons, with their sounds
- Signs: the editor opens, the text is stored and shown to everyone. Dyes,
  glow ink and honeycomb work on them
- Chests, beds, banners and other block entities being drawn
- The item in a player's hand, and their armour, shown to other players
- Inventories remembered between sessions
- Dropping items, seeing them on the ground, picking them up
- Items keeping their enchantments, names, potions, colours, patterns, the
  contents of a shulker box and other data components, checked before anyone
  else sees them ([Items](#items) says which, and where)
- Items on the ground surviving the world going idle and the server restarting
- Middle-click pick block
- Plugins as separate Workers, including cancelling events
- Transfers to another server and cookies, in every phase that has them,
  and plugins deciding who may come in before they appear in the world:
  the [queue example](#a-queue) runs end to end on two servers
- Limits per client address on connections at once and on new connections
  ([Limits per address](#limits-per-address))

Written but not covered by a test: sprinting shown to other players and
`/spawn`. Skins are checked by hand only. The test client asks for cookies
during login only; a plugin asking for one from a command or another play
hook goes through the same code but no test does it.

Not there:

- Survival, mobs, redstone, world generation, a lighting engine.
- Account verification (see [Offline mode](#offline-mode-and-skins)).
- Chests, furnaces and the other blocks with a screen do not open.
- Water and lava can be placed but do not flow, and an empty bucket does not
  pick them up.
- Levers and buttons move and click but power nothing.
- Double chests do not join.
- Item components the server does not understand (books, maps, bundles,
  attribute modifiers, custom data and most of the game's 120 or so types)
  stay with the player who has the item and are lost when it is dropped or
  the player leaves; see [Items](#items). Middle-click with Ctrl does not
  copy a block's data.

How far it has been tried with the real game: two people have been on the
deployed 26.3 server at once, joining, chatting and building with a plugin
command. Placing blocks, signs and doors were tried by hand on the 26.1 build;
on 26.3 they are covered by the conformance test, which proves the game can
read what the server sends, not that it then does the right thing with it.
What a block may be put on is checked there against the game's own rule;
whether a refused block leaves anything behind on a real game's screen has
not been tried. Transfers, cookies and the queue's line above the hotbar have
not been tried with the real game at all: whether it follows the transfer,
takes the cookie along and shows the line is up to the game, and only the
conformance test's client has done so. Item components have not been tried with the real game
either: the conformance test shows that the game decodes every stack the
server sends and that it equals the one built, not that it is drawn right (a
glint, a banner's patterns or a head's skin in someone's hand), nor how the
real game's creative screen behaves when the server's copy of a stack lacks
a component it did not understand.

### What holds a block

Whether a block can stay where it is (vanilla's `canSurvive`) decides both
whether it may be placed and whether it falls off later, so the two agree.
Which faces of a block state can hold something (a full face, the centre for
a torch, a rigid top for a rail) comes from the game itself through
`npm run gen`; the rules, one per game class, are in
`src/world/survival.ts`. Blocks that can hang on several sides (torches,
signs, buttons, lanterns, ladders, vines) try them in the game's order,
nearest to where the player looks first. Simplified:

- There is no light, so mushrooms are taken to be in the dark and crops in
  the light, wherever they are.
- Water does not flow. Sugar cane, seagrass, kelp and spore blossoms look at
  the water that is there, which is only ever what was placed.
- Fire, farmland, dirt paths, scaffolding, bubble columns and piston heads
  have rules about things the server does not do, and stay anywhere. Rails
  are never sloped and pointed dripstone does not grow thicker.
- A block checks again whenever anything next to it changes. The game checks
  some only when the side that holds them changes, which matters only for a
  block saved somewhere it could not have been put: it stays until something
  next to it changes.

### Items

An item stack carries data components besides its type and count:
enchantments, a name, a potion, a colour, the contents of a shulker box, and
so on, each with its own encoding. A client sends a stack with the length of
each value in front of it; the server sends one without, so whoever reads it
must decode every value, and a client that cannot decode one is disconnected.
Anyone can join this server and send anything, so nothing a client sent is
passed on to another client on trust.

The components the server understands are read field by field, checked
(every number in range, every enchantment, potion, pattern or item id one the
game has) and written out again by the server itself: `custom_name`,
`item_name`, `lore`, `rarity`, `enchantments`, `stored_enchantments`,
`enchantment_glint_override`, `unbreakable`, `damage`, `repair_cost`,
`dyed_color`, `base_color`, `potion_contents`, `suspicious_stew_effects`,
`ominous_bottle_amplifier`, `fireworks`, `firework_explosion`,
`banner_patterns`, `tooltip_display`, `instrument`, `painting/variant`,
`block_state`, `profile` and `container`. That covers everything the
creative inventory puts on its items: the conformance test has the game
build its creative tabs and checks that each of the 400 or so items there
with components reaches another player as it was built. Text is rebuilt
from plain text, translations and key names with colour and bold, italic,
underlined, strikethrough and obfuscated; hover and click events, fonts and
the like are dropped, and scores, entity selectors and NBT lookups are
refused. A head may carry a name, an id and a skin property of the kind
Mojang's profile servers hand out, but not a texture of the game's own put in
place of the skin. A shulker box may hold a filled chest, but nothing deeper,
and its contents must be understood too: a bundle inside one makes the whole
contents not understood. Lists have limits (64 enchantments or lines of lore,
16 effects, explosions or patterns, 27 slots in a container), one value may be
4 KB and a stack's components 8 KB in all; past that a component is dropped.

| | Checked components | Any other, or one that fails its check |
|---|---|---|
| The player's own inventory, while they are online | kept | kept, but never sent to anyone |
| Shown to others in a hand, as armour or on the ground | shown, except a container's contents and lore, which nobody sees there | not shown |
| Dropped and picked up, by anyone | kept | lost |
| Saved: inventories and items on the ground | kept, for the same game version | lost |

Unchecked components are not even saved for the player who sent them: names
are not verified, so whoever joins under a name next is not necessarily the
same person, and a value the game cannot decode, sent back on every join,
would lock that name out for good. A stack the game itself could not have
sent (a component type that does not exist, a value running past the end of
the packet) is a broken packet and disconnects its sender, as on a vanilla
server.

Two stacks merge (picking up, topping up a stack) only when their components
are the same, and middle-click only picks a hotbar slot whose item has none,
as in the game. Others are told about a change in a player's hands or armour,
components included, at most once a tick, and drops from the creative
inventory are limited the way a vanilla server limits them.

Items on the ground are saved with their position, stack, age and the rest of
their state, in one transaction: every 30 seconds while someone is online,
the ones that changed, and when the last player leaves, those too and the
ones that aged 30 seconds or more since they were last written. A crash
loses at most those 30 seconds, and an item may then live up to 30 seconds
longer than it should have. The limit of 256 items and their five minutes
of life (counted only while someone is online) are as before.

Items are stored by name, so they survive a change of game version.
Components hold ids that belong to one version (of enchantments, potions, the
items in a container), so they are saved with the protocol they were saved
under, and under another version the item comes back without them. Saved
values are checked again when they are loaded.

## Run it

Developed on Node 26. Generating the version data needs a JDK, version 25 or
newer (`java`, `javac`, `jar` and `javap` on the path).

```sh
npm install
npm run gen     # once: downloads Mojang's server jar and extracts the version data
npm run dev
```

Open Minecraft 26.3, add a server with the address `localhost`, join.
`http://localhost:8787` returns who is online as JSON.

`npm run gen` exists because this repository contains no Mojang code or data.
It downloads the official server jar into `.cache/`, runs the jar's own data
generator, asks its classes a few questions (`scripts/Probe.java`) and writes
`src/generated/v777.json`. The game server itself is never started.

### More than one server

`INSTANCE=<n>` (1 to 99) starts a separate server beside the default one, for
example one per git worktree:

```sh
INSTANCE=2 npm run dev        # or npm run dev:26.1
INSTANCE=2 npm test           # the tests find it too
```

Instance `n` takes the game port `25570+n` and HTTP port `8790+n`, its
Workers' names end in `-n`, and its world is kept in `.wrangler/state-n`.
`npm run dev -- --print` shows what would start, without starting it.
`HOST` and `PORT` still pick any other server for the tests.

A new worktree needs `npm ci` and `npm run gen` (and `npm run gen -- 26.1.2`
for the bot suite). To skip the download, copy another checkout's
`.cache/mc-<version>` first, such as
`mkdir -p .cache && cp -a ../workercraft/.cache/mc-26.3 .cache/`. Copy it
rather than link it: the conformance test compiles into it.

## Plugins

```ts
// plugins/guard/index.ts
import { definePlugin, type BlockEvent, type Server } from "../../sdk/plugin";

async function guard({ player, x, z }: BlockEvent, server: Server) {
	if (Math.abs(x) > 6 || Math.abs(z) > 6) return;
	await server.message(player.name, { text: "Spawn is protected.", color: "red" });
	return { cancel: true };
}

export default definePlugin({ onBlockBreak: guard, onBlockPlace: guard });
```

A plugin is a Worker with its own `wrangler.jsonc`. To load it, bind it to the
world under a name starting with `PLUGIN_` (see `services` in `wrangler.jsonc`)
and add its config to `DEFAULT_CONFIGS` in `scripts/dev.mjs` and to the `deploy`
script. Hooks and the server handle are documented in `src/plugins/api.ts`.

Included: `guard` (spawn protection), `welcome` (greeting, `/hello`) and
`builder` (`/sphere <block> [radius]`). Two more, `limbo` and `gate`, make up
the queue below and are not loaded unless asked for.

Besides the event hooks, a plugin can decide whether a player may come in at
all (`onLogin`, before anything of the world is sent to them), act once a
second on its own (`onTimer`), show a line above the hotbar
(`server.actionBar`), send a player to another server (`server.transfer`)
and store and ask for cookies (`server.storeCookie`, `server.requestCookie`).
`onLogin` fails closed: a plugin that implements it and throws, takes longer
than 5 seconds or cannot be reached turns the player away.

### A queue

`plugins/limbo` is a waiting room: everyone on it stands in line in the order
they joined and sees their place above the hotbar. Every few seconds the
first in line is given a signed ticket as a cookie and transferred to the
destination. `plugins/gate`, on the destination, turns away anyone who does
not arrive by transfer with a valid ticket, before they appear in its world.
The ticket's layout is documented in `plugins/gate/ticket.ts`, plainly
enough to check it in a plugin for a vanilla or Paper server
(`accepts-transfers=true`), which is the realistic destination in production:
a Cloudflare zone gets one TCP Worker application.

What a ticket proves is limited. The servers do not verify accounts, so a
name is whatever the client says; a valid ticket proves that this name went
through the queue in the last minute, nothing more. It is not single-use.

Locally it runs as two servers. Both need the same secret, which stays out of
git: copy `plugins/limbo/.dev.vars.example` to `plugins/limbo/.dev.vars`, set
`QUEUE_SECRET` to a long random value (`openssl rand -hex 32`), and put the
same line in `plugins/gate/.dev.vars`. Then, in two terminals:

```sh
INSTANCE=1 PLUGINS=limbo npm run dev           # the limbo, on localhost:25571
INSTANCE=2 PLUGINS=gate,welcome npm run dev    # the destination, on localhost:25572
```

and join `localhost:25571`. `PLUGINS` picks which plugins an instance loads
instead of the usual ones; the default server and `npm run deploy` never load
these two. The limbo's settings (`DESTINATION`, `ADMIT_EVERY_SECONDS`,
`TICKET_TTL_SECONDS`) are in `plugins/limbo/wrangler.jsonc`; a line in its
`.dev.vars` overrides one, such as `DESTINATION=localhost:25574` for a
destination on another instance.

## Deploy

Inbound TCP reaches a Worker through Spectrum, which needs a Pro or Business
zone (or Spectrum Enterprise). Those plans allow one Worker application on one
TCP port per zone.

The Worker has to be in the same account as the zone. If `wrangler whoami`
lists more than one account, set `CLOUDFLARE_ACCOUNT_ID` first.

1. `npm run deploy` (deploys the plugins, then the world).
2. In the dashboard: Spectrum → Create an Application → type **Workers (tcp)**,
   a subdomain such as `mc`, edge port `25565`, origin Worker `workercraft`.
   Or through the API, with a token that has Zone Settings: Edit, where the
   origin is the Worker's tag from `GET /accounts/<account>/workers/scripts`:

   ```sh
   curl "https://api.cloudflare.com/client/v4/zones/$ZONE_ID/spectrum/apps" \
     --header "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
     --json '{"dns":{"type":"CNAME","name":"mc.example.com"},"protocol":"tcp/25565","traffic_type":"worker","origin_worker_id":"<WORKER_TAG>"}'
   ```
3. Join `mc.<your domain>`.

Things worth knowing:

- The deployed world starts empty: the world built under `wrangler dev` stays
  in `.wrangler/state` on your machine.
- After a deploy the world keeps running the old code for a couple of minutes
  while players are connected, then restarts and disconnects them.
- `wrangler tail` does not show what the world logs. The Workers Observability
  query API does.
- The limits per address rely on Spectrum telling the Worker the client's
  address. Cloudflare documents that it does; it has not been checked on the
  deployed server yet. Without it nothing is limited, and the world logs that
  once.

Open questions for production, none of them answered by the beta docs yet:

- How CPU time is limited for a Durable Object holding a TCP stream open for
  hours. Locally, 100 players all moving cost a few CPU-seconds per 10 seconds.
- How long such a connection may stay open.
- What Spectrum charges for traffic on Pro and Business.

### Limits per address

One address may not fill the server or flood it with connections. The
variables are in `wrangler.jsonc`, next to `MAX_PLAYERS`:

| Variable | Default | What |
|---|---|---|
| `MAX_CONNECTIONS_PER_ADDRESS` | `10` | Connections in the world at once |
| `JOINS_PER_ADDRESS` | `20/60` | New joining connections: 20 at once, then one more every 3 seconds (20 per 60) |
| `PINGS_PER_ADDRESS` | `120/60` | Server list pings, the same way: 120 at once, then two a second |

`0` turns a limit off. An address is an IPv4 address, or for IPv6 the /64 it
is in, because one customer usually holds a whole /64. A player over a limit
is turned away at login with a message saying why; a ping over its limit gets
no answer, so the server shows as unreachable in that player's list. Several
players behind one address (a household, a school, a LAN party) are normal,
which is why the defaults are not lower.

The Worker passes the world a hash of the address, not the address, and the
world keeps those hashes in memory only: a restart forgets them. Neither
stores, logs nor reports an address. A connection whose address is unknown is
not limited.

## Offline mode and skins

The server does not verify accounts, so anyone can join under any name. That
is fine for a demo and wrong for a server people care about. Verifying
accounts needs the protocol's encryption step (RSA key exchange, then
AES-CFB8), which is the next thing to build.

Skins are looked up by player name: from Mojang's public profile API, and,
because Mojang turns away requests coming from Cloudflare's network, from
playerdb.co and then minetools.eu when Mojang gives no answer. That sends the
names of the players who join to those services. The skin itself is signed by
Mojang and the game checks the signature, so none of them can make one up. Set
the `SKINS` variable to `off` to look nothing up.

## Tests

Both suites run against a server that is already running, and both build
things in its world, at a random spot far from spawn.

```sh
npm run dev          # in one terminal
npm test             # in another
```

`npm test` is a conformance test judged by the game itself. A small Java
program (`test/conformance/Conformance.java`) joins like a client and decodes
everything the server sends with the packet code in Mojang's server jar, the
same code the real game runs. It fails on a packet the game could not read or
one with bytes left over, builds the registries from the configuration packets
the way the game does, and reads chunks with the game's chunk reader. It uses
the jar that `npm run gen` downloaded. `JOIN_ONLY=1 npm test` only joins and
looks, without building.

`INSTANCE=1 npm run test:queue` runs the queue example instead, against its
limbo, with the destination running too ([A queue](#a-queue)). It waits in
line, is transferred, follows the transfer to the destination with its
ticket and gets in, and checks that a player who did not come by transfer,
one without a ticket, one with a tampered, expired or somebody else's ticket,
and one whose game never answers are all turned away before they appear in
the world. It reads the secret from `plugins/gate/.dev.vars` (or
`QUEUE_SECRET`) and makes tickets of its own from the documented layout.
Plain `npm test` says it skipped this.

`npm run test:bots` is the older, larger suite: mineflayer bots that play
through most features. Their library stops at Minecraft 26.1, so the server
has to be built for that version first: `npm run gen -- 26.1.2`, then
`npm run dev:26.1`. Its checks have time limits and fail at random on a busy
machine.

Both read `INSTANCE`, or `HOST` and `PORT`, to find the server
([More than one server](#more-than-one-server)).

`npm run test:limits` checks the [limits per address](#limits-per-address). It
needs a server started with low limits, so it can reach them; the command is
at the top of `test/limits.mjs`. It takes about a minute.

`INSTANCE=<n> npm run test:restart` checks that items on the ground survive
the server stopping: it starts its own server on an instance that is not
running, drops items, lets the world go idle, drops more while a player stays
online past a save, kills the server, starts it again and looks for all of
them with the conformance test's client (26.3). It takes about a minute.

## Other game versions

```sh
npm run gen -- 26.3    # any release; writes src/generated/v<protocol>.json
```

`tsconfig.json` says which of those files the server is built with
(`#version-data`); `tsconfig.26.1.json` is the same build for 26.1.x.

A newer version usually also changes the layout of some packets. Those live in
`src/protocol/packets.ts`, `src/world/session.ts` and `src/world/chunks.ts`,
where each difference between 26.1 and 26.3 is marked with `BEFORE_26_3`. The
conformance test, compiled against the new jar, says which packets the new
game can no longer read.

A world does not depend on the version: blocks are stored by name, so one
saved under 26.1 opens under 26.3. A block the running version does not have
shows as air and is kept in storage. Items are stored by name too; their
components only come back under the version they were saved with
([Items](#items)), and an item on the ground that the version does not have
is kept in storage.

## Layout

| Path | What |
|---|---|
| `src/index.ts` | The Worker: handshake, server list ping, pipe to the world |
| `src/world/world.ts` | The Durable Object: players, movement, chat, blocks |
| `src/world/session.ts` | One connection: protocol phases and packet parsing |
| `src/world/limits.ts`, `src/net/address.ts` | Limits per client address |
| `src/world/chunks.ts` | Block storage and the chunk packet |
| `src/world/blockstates.ts` | Block state ids to properties and back |
| `src/world/building.ts` | Placement rules, neighbour reactions, right-clicks, signs |
| `src/world/survival.ts` | What a block can rest on or hang from |
| `src/world/items.ts` | Physics of dropped items |
| `src/world/skins.ts` | Offline UUIDs and the skin lookup |
| `src/protocol/` | Packet builders and the version data |
| `src/protocol/components.ts` | Item components: which are understood, checked and passed on |
| `src/net/` | Varints, framing, NBT |
| `src/plugins/`, `sdk/` | Plugin API, host and SDK |
| `plugins/` | Example plugin Workers; `limbo` and `gate` are the queue |
| `scripts/gen-data.mjs`, `scripts/Probe.java` | Generate version data from the server jar |
| `scripts/dev.mjs` | `npm run dev`: the world and its plugins in one `wrangler dev` |
| `test/conformance/` | The conformance test, judged by Mojang's packet code; `ItemTests.java` for items |
| `test/restart.mjs` | Items on the ground across a restart |
| `test/e2e.mjs` | The bot suite (26.1 build only) |
| `test/limits.mjs` | The test of the limits per address |

## License

[MIT](LICENSE). Not affiliated with Mojang or Microsoft. "Minecraft" is a
trademark of Mojang Synergies AB.
