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

## Putting it on the internet (Fly.io)

Fly's free allowance covers one small always-on machine with a volume, which is
exactly the shape this needs.

```sh
# once
fly launch --no-deploy --copy-config          # claim an app name
fly volumes create island_data --size 1       # accounts must survive a deploy
fly secrets set SESSION_SECRET="$(openssl rand -base64 32)"

# every time
fly deploy
```

Then tell the game where the server is. Either edit one line —

```js
// src/net/config.js
export const DEFAULT_SERVER = 'wss://your-app-name.fly.dev/ws';
```

— or leave it empty and type `your-app-name.fly.dev` into the box the friends
screen shows the first time it cannot find a server. The address is remembered
per browser, so it is asked once.

Check it came up:

```sh
curl https://your-app-name.fly.dev/health
```

### Two things in `fly.toml` that matter

**`auto_stop_machines = false`.** A suspended machine drops every open
websocket, which drops every match in progress. This is a game server; it does
not get to sleep.

**The volume.** Accounts and the friend graph are one JSON file under `/data`.
Without a volume it lives on the machine's ephemeral disk and every deploy
signs everybody out permanently.

### One machine, deliberately

Rooms live in memory and the store is a local file, so two machines would be
two separate games — your friend online on one and invisible on the other.
Scaling past one means moving both out of the process; the note at the top of
`store.mjs` says what to replace.

---

## Other hosts

Nothing here is Fly-specific. Anything that can run a container and give it a
persistent directory works:

| | |
|---|---|
| `PORT` | what to listen on (default 8787) |
| `DATA` | where `island.json` lives (default `server/data`) |
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
