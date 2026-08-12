# Island Settlers — scaling to 200–500 simultaneous matches

*Measured 12 Aug 2026 against commit `HEAD` of the public repo, using
`tools/loadbench.mjs` (added alongside this document). Re-run it on whatever
box you actually buy before trusting any number here.*

---

## The short version

**The simulation is far cheaper than the code comments assume, and capacity is
not your problem.** A match costs about **0.008–0.011 of a CPU core** and
**15–25 MB**, not the "40MB and a meaningful slice of a core" the server README
implies. On that basis:

| | 200 matches (800 players) | 500 matches (2,000 players) |
|---|---|---|
| CPU | ~3.5 cores | ~8.5 cores |
| Provision (60% target) | **4 vCPU** | **10–12 vCPU** |
| RAM | ~5 GB | ~12.5 GB |
| Provision | **8 GB** | **16 GB** |
| Egress | 18 Mbps · 7.9 GB/hr | 44 Mbps · 20 GB/hr |
| Websockets held open | 800 | 2,000 |

Both fit on **one machine**. 500 matches needs roughly a 12-core box — that is
a €138/month Hetzner CCX33, not a cluster.

So the reason to do architectural work is **not** capacity. It is that today,
one process holds every match, a deploy kills every match, and an overloaded
box does not slow down gracefully — it kills matches outright (see
[What actually breaks first](#what-actually-breaks-first)). That is what the
scope below buys you.

---

## What I measured

`tools/loadbench.mjs` starts N real `matchworker.mjs` threads — real rules,
real 60Hz loop, real bots — drives the human seats with a stick input 30×/sec,
waits out the 7s load-in and the draft, then measures for a fixed window.

Run on a 2-vCPU / 8 GB Linux container, Node 22.22, 2 human seats + 2 bots per
match (the realistic "playing with friends" shape):

| matches | cores used | cores/match | RSS/match | snap gap p50 / p99 | sim speed | verdict |
|---:|---:|---:|---:|---:|---:|---|
| 6 | 0.065 | 0.0108 | 25 MB | 49 / 65 ms | 0.998× | ok |
| 64 | 0.485 | 0.0076 | 19 MB | 49 / 65 ms | 0.998× | ok |
| 200 | 1.659 | 0.0083 | 15 MB | 47 / **131 ms**, max **12.7 s** | **1.514×** | strained |

Snapshot cadence should be a flat 50 ms (`SNAPSHOT_HZ = 20`). At 64 matches it
is. At 200 matches — **83% of the box** — it isn't: workers stall for seconds
and then the accumulator in `matchworker.mjs` sprints to catch up, which is
what `simRealtimeRatio 1.514` means. Players see a freeze and then a fast-
forward.

**Take 60% CPU as the ceiling, so ~60 matches per core in production.** That's
the number the table at the top uses, and it already has a 30% safety margin
against the 0.008 figure.

Other measurements worth having:

- **A snapshot is 140 bytes of JSON** (`{"t":"snap","k":…,"ms":…,"p":[36 numbers]}`).
  20/sec, broadcast to each occupied seat.
- **Encoding is free.** `JSON.stringify` + a WebSocket text frame runs at
  ~494,000/sec — about 2 µs each. At 500 matches the hub emits 40,000
  messages/sec, which is **0.08 of a core** of encoding. Socket writes will
  cost more than the encoding does, but not much more.
- **Bots cost more than humans.** 4 bots measured 0.025 cores/match versus
  0.022 for 4 moving humans. A full lobby of friends is your cheapest match.

---

## What actually breaks first

Three things fail before you run out of CPU. All three are worth more attention
than raising `MAX_MATCHES`.

**1. The watchdog turns overload into an outage.** `matchhost.mjs` kills any
worker silent for `SILENCE_MS = 20000`. Under the load I measured at 83% CPU,
individual workers stalled for **12.7 seconds**. Push a little further and
stalls cross 20s — at which point the server starts *killing live matches* to
relieve pressure it caused. Overload should shed *new* matches, never running
ones. Fix: refuse new matches above a CPU/lag threshold, and raise or make
adaptive the silence timer.

**2. Blast radius is 100%.** One process, one `numReplicas`, rooms in memory. A
crash, an OOM, or a `git push` ends every match in progress simultaneously. At
24 concurrent players that's an annoyance; at 2,000 it's your entire user base
at once.

**3. There is no drain.** Matches last ~3.5 minutes. That is *short* — a deploy
that stops accepting new matches and waits for existing ones to finish is done
in under four minutes with zero interrupted games. You just have no mechanism
for it today.

Also missing, and it matters more at 2,000 players than at 24:

- **Room creation is unrate-limited and unauthenticated.** `hub.mjs` rate-limits
  *joining* by code (20/min/IP) but `REQ.ROOM_CREATE` has no limit at all and
  there is no global cap on the rooms Map. One script can occupy every match
  slot you own.
- **No metrics.** `/health` gives you counts. You cannot see tick lag,
  per-match CPU, or snapshot cadence — the three things that tell you the game
  is degrading before players do.
- **One region.** `primary_region = "iad"`. A 60Hz game played from Europe or
  Asia against a US-East box feels bad regardless of how much CPU you buy.

---

## Cost

Rates checked 12 Aug 2026. Assumes peak load 4 hours/day for egress; compute is
billed on allocation, so it's priced 24/7.

### 500 matches (10–12 vCPU, 16 GB, ~2.4 TB/month egress)

| | Compute | Egress | Total |
|---|---|---|---|
| **Railway** (current host) | ~$360/mo | ~$120/mo | **~$480/mo** |
| **Hetzner CCX33** (8 dedicated vCPU, 32 GB, 30 TB incl.) | €138/mo | included | **~€138/mo** |
| **Hetzner CPX42** (8 shared vCPU, 16 GB, 20 TB incl.) | €69/mo | included | **~€69/mo** |

Railway bills **$0.05/GB egress**, $20.01/vCPU-month, $10.00/GB-RAM-month. Note
what that means: if you ever run near-continuous peak rather than 4 hours a day,
egress alone is ~14 TB = **$715/month**, more than the compute. Hetzner includes
20–30 TB.

### 200 matches (4 vCPU, 8 GB, ~0.95 TB/month egress)

| | Total |
|---|---|
| **Railway** | ~$210/mo |
| **Hetzner CPX32** (4 vCPU, 8 GB, 20 TB incl.) | **~€35/mo** |

**Binary snapshots would cut egress ~3×.** Those 36 numbers are positions and
small integers; a packed `Float32`/`Uint8` frame is ~40 bytes against 140. Worth
doing before you'd ever need a bigger egress tier, not before then.

---

## The domain

### Why it's the first thing to do, not the last

`src/net/config.js` hardcodes:

```js
export const DEFAULT_SERVER = 'wss://island-settlers-production.up.railway.app/ws';
```

That string is **compiled into the APK already on people's phones**. The
Capacitor build bundles `www/` — the game and its config — into the app, so
every installed copy will keep dialling Railway forever. If you move hosts to
save the $350/month above, every installed Android app breaks until each user
takes an update, and Play updates are neither instant nor universal.

Put the server behind `wss://play.yourdomain.com/ws` **now**, ship that once,
and every subsequent infrastructure change — Railway to Hetzner, one box to
five, adding a European region — is a DNS change nobody notices. Doing this
before the scaling work is worth more than any of the scaling work.

### How pointing GitHub Pages at a domain works

Straightforward, and your repo is already set up for it — `manifest.webmanifest`
uses relative `start_url`/`scope`, and `index.html` registers the service worker
with a relative scope. Nothing in the game assumes the `github.io` path.

1. **Buy the domain.** ~$10–15/year for a `.com` (Cloudflare Registrar sells at
   cost; Porkbun and Namecheap are comparable).
2. **Point DNS at GitHub.** For the apex (`yourdomain.com`), four A records:
   `185.199.108.153`, `185.199.109.153`, `185.199.110.153`, `185.199.111.153`
   (plus the AAAA equivalents at `2606:50c0:800{0,1,2,3}::153` if you want IPv6).
   For `www`, a single CNAME to `otterholte.github.io`.
3. **Tell GitHub.** Repo → Settings → Pages → Custom domain. It writes a `CNAME`
   file to the repo root. Wait for the check to go green, then tick **Enforce
   HTTPS** — GitHub provisions the certificate automatically, though the option
   can take up to 24 hours to appear.
4. **Point a subdomain at the server.** `play.yourdomain.com` → CNAME to your
   Railway/Fly/Hetzner host. Update `DEFAULT_SERVER` to
   `wss://play.yourdomain.com/ws`, bump `PROTOCOL_VERSION` is *not* needed here,
   ship a new APK, and you're decoupled.

**Half a day, including waiting for DNS.** The knock-on changes:

- `src/net/config.js` — `DEFAULT_SERVER`
- Play Console listing — the privacy policy URL currently points at
  `otterholte.github.io/island-settlers/privacy.html`. Update it, and **keep the
  old GitHub Pages URL alive** (it will keep working; GitHub redirects the old
  path to the custom domain).
- Rebuild the Capacitor app: `npm run build:aab -- ../IslandSettlers`, and bump
  `versionCode` in `android/app/build.gradle` first.

One option worth knowing about: **Cloudflare Pages** serves the same repo for
free with a better CDN and instant cache purges, and puts the site and the
`play.` subdomain under one dashboard. Not necessary — GitHub Pages is fine at
this scale — but it removes a moving part.

---

## Scope of work

### Phase 0 — Domain and decoupling · **half a day**

Everything in the section above. Do this first regardless of which capacity
target you pick.

### Phase 1 — One box, 200–500 matches · **2–3 days**

No architectural change. Gets you the full capacity target with the blast-radius
and deploy problems intact.

- Size the box from `tools/loadbench.mjs` run **on that box**.
- `MAX_MATCHES` from env, set to 60 × cores.
- **Admission control**: refuse new matches when p99 snapshot gap or CPU crosses
  a threshold, so the box sheds new games instead of killing running ones.
- Raise `SILENCE_MS`, or make it adaptive, so the watchdog stops firing on
  load-induced stalls.
- Per-IP room-creation limit and a global rooms cap in `hub.mjs`.
- `/health` grows: p99 tick lag, per-match CPU, socket count, RSS. Point
  something at it that alerts.

### Phase 2 — Sharding and the directory · **4–6 days**

This is what fixes blast radius and deploys. The design keeps the "one island
per module registry" constraint completely intact — **no game code changes.**

- A tiny **directory service**: `code → match-server URL`, in Redis with a TTL.
  Match servers register and heartbeat their spare capacity.
- Creating a room asks the directory for the least-loaded server; joining a code
  asks the directory where that room lives. The client then opens its websocket
  **directly against that server**.
- Client change is one HTTP call before the socket opens — contained to
  `src/net/`. Protocol version bump.
- Run 4–8 server processes of ~60–125 matches each, whether on one box or
  several. A crash now costs one shard, not the whole population.

### Phase 3 — Operations · **2–3 days**

- **Drain mode**: stop accepting new matches, exit when the last one finishes.
  With ~3.5-minute matches this is a sub-four-minute rolling deploy with zero
  interrupted games.
- `tools/loadbench.mjs` in CI, so a rules change that doubles per-match CPU is
  caught in a PR rather than on a Friday night.
- `nettest.mjs --remote=` against each shard after deploy.

### Phase 4 — Optional, when the numbers say so

- Binary snapshots (~3× egress reduction).
- A second region. This is the one thing that improves how the game *feels*
  rather than how much it costs, and it is nearly free once Phase 2 exists —
  the directory can hand a player the nearest server with capacity.

---

## Two honest options

| | **Small scope** | **Full scope** |
|---|---|---|
| Target | 200–300 concurrent matches | 500+, resilient |
| Work | Phase 0 + Phase 1 | Phases 0–3 |
| Effort | **~3 days** | **~2.5 weeks** |
| Hosting | ~€35–70/mo (Hetzner) or ~$210/mo (Railway) | ~€138/mo (Hetzner) or ~$480/mo (Railway) |
| Deploys | still interrupt every match | zero-downtime |
| A crash costs | everyone | one shard |

The small scope genuinely hits your 500-match number on paper — the CPU is
there. What it doesn't give you is the ability to ship a bug fix on a Saturday
evening without ending two thousand people's games.
