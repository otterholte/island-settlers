# Island Settlers — the multiplayer server

Room codes and authoritative real-time matches. No dependencies: `node:http`,
`node:crypto`, `node:worker_threads` and nothing else. Node 20 or newer.

**No accounts and no database.** A room is five characters; a player is a
device id their own browser invented and a name they typed on their own
machine. Everything the server holds is in memory and is meant to be — a
process that is not running holds no rooms and no matches for a persisted
account to reattach to.

---

## Try it on this machine first

```sh
STATIC=1 node server/index.mjs
```

Open <http://localhost:8787>. `STATIC=1` makes the server hand out the game
files as well as run the multiplayer, so the page and the websocket share an
origin and there is nothing to configure — press **PLAY WITH FRIENDS**, type a
name, **CREATE A ROOM**, press **START**. Empty seats become bots.

To play against somebody else on the same wifi, they open
`http://<your-ip>:8787` on their phone, type the five-character code off your
screen, and press **JOIN**. That is the whole flow: nobody adds anybody, nobody
accepts anybody.

---

## Putting it on the internet

### Railway (what this is deployed on)

Connect the repo and it builds from the `Dockerfile` — `railway.json` pins the
rest. **Nothing to configure.** Railway injects `PORT`; the server reads it and
binds `0.0.0.0`.

There is no volume to attach and no secret to set. There used to be both, and
both were a source of silent failure: a volume that mounts but is not writable
serves perfectly and loses every account at the next deploy, and a
`SESSION_SECRET` that is generated at boot instead of configured signs everybody
out on every redeploy without saying so. Deleting the accounts deleted both
problems. If the old deploy has a volume attached, it is simply unused now and
can be removed.

Then point the game at it — `DEFAULT_SERVER` in `src/net/config.js`, or type the
address into the box behind **SERVER** on the multiplayer screen, which
overrides it per browser.

**Check it worked:**

```sh
curl https://<your-app>.up.railway.app/health
```

```json
{ "ok": true, "protocol": 2, "players": 0, "rooms": 0, "openRooms": 0 }
```

`protocol` has to match the page's. A mismatch is refused at the handshake
rather than half-served, so an out-of-date tab is told to reload instead of
making requests that half work.

### Fly.io

```sh
fly launch --no-deploy --copy-config          # claim an app name
fly deploy
```

**`auto_stop_machines = false`** matters more than it looks: a suspended machine
drops every open websocket, which drops every match in progress. This is a game
server; it does not get to sleep. Same reason `sleepApplication` is false in
`railway.json`.

### One machine, deliberately

Rooms live in memory, so two instances would be two separate games: a code made
on one would not exist on the other. That is precisely the failure the whole
screen was rewritten to make impossible, so do not reintroduce it by scaling
out. Scaling past one means moving the room registry into something both
processes can see.

---

## Other hosts

Nothing here is tied to either. Anything that can run a container works — there
is no directory to persist:

| | |
|---|---|
| `PORT` | what to listen on (default 8787) |
| `HOST` | what to bind (default `0.0.0.0`) |
| `STATIC` | `1` to also serve the game files |
| `MAX_MATCHES` | concurrent matches (default 6; each is ~40MB) |

On your own machine behind a home router, the easiest way to let friends in
without touching port forwarding is a Cloudflare Tunnel:

```sh
cloudflared tunnel --url http://localhost:8787
```

It prints an `https://…trycloudflare.com` address; give the game that.

---

## What the pieces are

| file | what it owns |
|---|---|
| `index.mjs` | listening, `/health`, optional static files, shutdown |
| `wsock.mjs` | RFC 6455 — the handshake, the frame codec, keepalive |
| `hub.mjs` | every request a client can make, and who may make it |
| `players.mjs` | device id in, player out. The whole of "signing in" |
| `rooms.mjs` | rooms: a five-character code, four seats, two settings, a host |
| `matchhost.mjs` | one worker thread per running match, and killing it when it hangs |
| `matchworker.mjs` | **the match** — the real rules at 60Hz |

`../src/net/protocol.js` is shared with the browser. It is the only definition
of every message name, so the two ends cannot drift.

### Why a worker per match

`board/layout.js` deals the island while it is still evaluating, and
`reshuffle()` then mutates those same tile objects in place so that every
module holding a reference keeps pointing at a live board. That is the right
design for a game with one island on screen, and it means **exactly one island
can exist per module registry**. A worker gets its own registry, so one worker
is one island is one match — and not one line of the game had to be refactored
into factories to make that true.

### What is on the wire

Almost nothing. The board is a **seed**: `reshuffle(seed)` is deterministic and
so is the item scatter, so four bytes deal nineteen identical hexes and 576
identical pickups on every machine. After that it is the events the rules emit —
which the browser replays through its own rules, so every sound, particle and
animation fires exactly as it does offline — plus twenty position snapshots a
second.

That paragraph was **false** for the whole first version of multiplayer, and it
is the reason "it was clear it wasn't the same game". `board/nodes.js` scattered
its item field once, at module load, seeded off the numbers of the throwaway
random board every process deals on its way up, and the re-deal only re-tagged
what each item *was* — it never moved one. Same terrain, same tokens, same
docks, 576 trees and sheep in different places on every screen, and a pickup
replayed by item id landing thirty metres from where it happened.
`tools/boardsync.mjs` now proves the claim in separate processes instead of
asserting it in a comment.

---

## Testing it

```sh
node tools/boardsync.mjs        # the same seed deals the same island, in
                                # separate processes — terrain, docks, graph,
                                # every item position and every prop
node tools/nettest.mjs          # 42 checks: hello, room codes, a whole match
node tools/nettest.mjs --keep   # leave the server running afterwards
```

`nettest` boots a real server, opens two real websockets, joins one to the
other's room **by typing the code**, and plays a real match through the real
client mirror — one mirror per client, fed only by that client's own socket, so
the last checks are two independent boards being compared with each other.
Nothing is stubbed.

And the same 42 checks against a **deployed** server, over wss, through whatever
proxy is in front of it:

```sh
node tools/nettest.mjs --remote=your-app.up.railway.app
```

That is the only way to find out whether a host will really hold a websocket
open for the length of a match, rather than believing a config file about it. It
uses throwaway device ids per run and touches nothing else.
