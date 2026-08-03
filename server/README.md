# Island Settlers — the multiplayer server

Accounts, a friends list, invitations, and authoritative real-time matches.
No dependencies: `node:http`, `node:crypto`, `node:worker_threads` and nothing
else. Node 20 or newer.

---

## Try it on this machine first

```sh
STATIC=1 node server/index.mjs
```

Open <http://localhost:8787>. `STATIC=1` makes the server hand out the game
files as well as run the multiplayer, so the page and the websocket share an
origin and there is nothing to configure — press **PLAY WITH FRIENDS**, make an
account, open a lobby, press **START**. Empty seats become bots.

To play against somebody else on the same wifi, they open
`http://<your-ip>:8787` on their phone. Two accounts, add each other, invite,
start.

---

## Putting it on the internet

### Railway (what this is deployed on)

Connect the repo and it builds from the `Dockerfile` — `railway.json` pins the
rest. Three things to set in the dashboard, once:

1. **A volume.** Add one and mount it at `/data`. Without it the accounts file
   lives on the container's own disk and every account vanishes at the next
   deploy, silently.
2. **`SESSION_SECRET`.** Any long random string. Without it a restart signs
   everybody out, and the server says so in the log every boot.
3. **`DATA=/data`** — optional. If you leave it unset the server reads
   Railway's own `RAILWAY_VOLUME_MOUNT_PATH`, so it finds the volume wherever
   you mounted it. Set it only if you want to pin the path yourself, and then
   make sure the two agree.

Railway injects `PORT`; the server reads it and binds `0.0.0.0`. Nothing to do.

Then point the game at it — `DEFAULT_SERVER` in `src/net/config.js`, or type the
address into the box on the friends screen, which overrides it per browser.

**Check it worked** before trusting it with anybody's account:

```sh
curl https://<your-app>.up.railway.app/health
```

The two fields that matter:

```json
"store": { "persists": true, "writable": true },
"user":  { "droppedPrivileges": true, "tookVolume": true }
```

`persists` says the file is on the volume. `writable` says the bytes actually
landed — those are different failures and the second one is the quiet one. A
mounted volume the container cannot write to serves perfectly and loses
everything at the next deploy, which is exactly what happened on the first
deploy here. The server now starts as root, takes the directory, and drops to
`node` before it opens a socket; `tookVolume` is it saying so.

### Fly.io

```sh
fly launch --no-deploy --copy-config          # claim an app name
fly volumes create island_data --size 1       # accounts must survive a deploy
fly secrets set SESSION_SECRET="$(openssl rand -base64 32)"
fly deploy
```

`fly.toml` pins `DATA=/data` explicitly, because Fly publishes no equivalent of
`RAILWAY_VOLUME_MOUNT_PATH`.

**`auto_stop_machines = false`** matters more than it looks: a suspended machine
drops every open websocket, which drops every match in progress. This is a game
server; it does not get to sleep. Same reason `sleepApplication` is false in
`railway.json`.

### One machine, deliberately

Rooms live in memory and the store is a local file, so two instances would be
two separate games — your friend online on one and invisible on the other.
Scaling past one means moving both out of the process; the note at the top of
`store.mjs` says what to replace.

---

## Other hosts

Nothing here is tied to either. Anything that can run a container and give it a
persistent directory works:

| | |
|---|---|
| `PORT` | what to listen on (default 8787) |
| `DATA` | where `island.json` lives — falls back to `RAILWAY_VOLUME_MOUNT_PATH`, then `server/data` |
| `RUN_AS` | who to drop to after taking the volume (default `node`) |
| `SESSION_SECRET` | signs session tokens — **set it**, or every restart signs everybody out |
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
| `users.mjs` | accounts and the friend graph |
| `rooms.mjs` | lobbies: four seats, two settings, a host |
| `matchhost.mjs` | one worker thread per running match, and killing it when it hangs |
| `matchworker.mjs` | **the match** — the real rules at 60Hz |
| `store.mjs` | one JSON file, written atomically |
| `auth.mjs` | scrypt passwords, HMAC session tokens |

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
so is the item scatter, so four bytes deal nineteen identical hexes and three
hundred identical pickups on every machine. After that it is the events the
rules emit — which the browser replays through its own rules, so every sound,
particle and animation fires exactly as it does offline — plus twenty position
snapshots a second.

---

## Testing it

```sh
node tools/nettest.mjs          # 39 checks: sign-up, friends, invites, a match
node tools/nettest.mjs --keep   # leave the server running afterwards
```

It boots a real server, opens two real websockets, and plays a real match
through the real client mirror. Nothing is stubbed.

And the same 39 checks against a **deployed** server, over wss, through
whatever proxy is in front of it:

```sh
node tools/nettest.mjs --remote=your-app.up.railway.app
```

That is the only way to find out whether a host will really hold a websocket
open for the length of a match, and whether the volume is genuinely mounted,
rather than believing a config file about it. It signs up two throwaway
accounts with random names per run and touches nothing else.
