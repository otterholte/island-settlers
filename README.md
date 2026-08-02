# Island Settlers

A Catan-inspired real-time 3D strategy game for landscape mobile web. You run a
settler around a fixed 19-hex island, chop wood, dig clay, shear sheep, reap
wheat and mine ore, trade at a central market and coastal ports, build roads,
settlements and cities, play development cards, and race three AI settlers to
12 victory points. A match runs about three and a half minutes.

Built with three.js r169. **No build step, no npm install, no external assets.**
All geometry is generated in code, all textures are painted to an offscreen
canvas, and all audio is synthesized with the Web Audio API.

---

## Play it

**https://otterholte.github.io/island-settlers/**

Open it on a phone in landscape, or on a desktop browser. Nothing to install.

---

## Run it locally
The game is plain ES modules, so it has to be served over HTTP â€” module imports
do not work from `file://`. A dependency-free server is included:

```bash
cd IslandSettlers
node serve.mjs
```

Then open **<http://localhost:5173>**. The server prints your phone URL too.

If port 5173 is busy, pass another: `node serve.mjs 5174`.

> **On Windows, don't use `python3 -m http.server`.** Unless you installed Python
> yourself, `python3` resolves to the Microsoft Store stub at
> `AppData\Local\Microsoft\WindowsApps\python3.exe`, which exits silently without
> starting a server â€” you get no error and nothing on the port. Use `node serve.mjs`.

### Play on your phone

With the phone and the computer on the same wi-fi, find your computer's LAN
address and open `http://<that-address>:5173` on the phone, then turn it
landscape. The game will prompt you to rotate if you are in portrait.

- **macOS:** `ipconfig getifaddr en0`
- **Windows:** `ipconfig` â†’ the IPv4 address of your wi-fi adapter
- **Linux:** `hostname -I | awk '{print $1}'`

### Controls

| | Touch | Keyboard |
|---|---|---|
| Move | Drag anywhere on the left of the screen â€” a floating joystick appears under your thumb | `W A S D` / arrows |
| Gather | Walk up to a tree, clay pit, sheep, wheat stand or ore seam and stop â€” gathering starts automatically | `Space` |
| Board map | Tap **MAP** | `Tab` |
| Build | Tap a build card, then tap a highlighted spot on the map and confirm | â€” |
| Trade | Walk to the market or one of your unlocked docks, then tap the prompt | â€” |

---

## How the match works

**Opening draft.** Snake order (you, Alex, Maya, Finn, Finn, Maya, Alex, you).
Each player places two settlements and two roads. Your second settlement pays
out its adjacent resources immediately, as in the tabletop game.

**Gathering is real-time, not dice-driven.** The number on a region still
matters: it sets how *fast* that region gives up its resources. A 6 or 8 yields
one resource every 0.96s; a 2 or 12 takes 1.84s. Owning a settlement on a corner
of a region doubles what you take from it; a city triples it. That is what makes
placement matter when there are no dice.

**Costs.** Road 2 wood + 2 brick Â· Settlement 2 wood + 2 brick + 2 wheat + 2 wool
Â· City 4 wheat + 6 ore Â· Development card 2 wool + 2 wheat + 2 ore.

**Scoring to 12.** Settlement 1 Â· City 2 Â· Longest Road 4 Â· Largest Army 2 Â·
Victory Point card 1.

**Development cards.** *Knight* â€” rivals drop half of everything they carry and
you move the Raider onto a region, which blocks everyone but you. *Road
Building* â€” two free roads. *Victory Point* â€” one point, immediately.

**The bots have real identities.** Alex expands and chases Longest Road, Maya
builds and upgrades to cities, Finn buys cards and hunts Largest Army. They walk
to every resource they gather and every dock they trade at â€” no teleporting, and
every resource they own comes from a rules call. That is asserted automatically
across 60 simulated matches.

---

## Tools

```bash
node tools/verify.mjs                            # board graph + rules structural checks
node tools/simulate.mjs --matches=60 --gathersys # headless bot-vs-bot pacing + balance
node tools/testmatch.mjs                         # drives the real game in headless Chrome
node tools/shoot.mjs --stage=play --w=960 --h=444 # capture real screenshots
```

`testmatch.mjs` and `shoot.mjs` need a Chrome binary; set `--chrome=/path/to/chrome`
if it is not at the default. Start the dev server first â€” they drive the live page
over the DevTools protocol rather than mocking anything.

Current state: **17 of 19 verification checks pass**, 74 draw calls and 123.7k
triangles mid-match, zero uncaught exceptions.

---

## Project layout

```
index.html            import map -> vendor/three.module.js, boot markup
vendor/               three.module.js (vendored, r169)
src/
  core/               constants.js, rules.js      <- frozen contracts
  board/              layout.js, nodes.js         <- frozen contracts
  world/              terrain, island, water, sky, props, borders,
                      structures, market, build kits
  entities/           settler (skinned rig), carry, controller
  systems/            camera, input, gathering, economy, bots, matchflow
  ui/                 hud, overview, panels, icons, stylesheets
  audio/              synth, sfx bank, music + ambience beds
  fx/                 particles, floating labels, rings
tools/                verify, simulate, shoot, testmatch
progress/             build status page, screenshots, reference art
```

`src/core/` and `src/board/` are the contract layer: pure data and pure rules,
with no three.js or DOM references. The 3D game and the headless simulator run
exactly the same rules code, which is why the pacing numbers mean anything.

Open `progress/index.html` for the full build report â€” screenshots, the critic
findings that drove each art pass, the verification table, and the pacing
distribution.

---

## Known gaps

- **Match length has wide tails.** Median is 3m24s and 70% of matches land in the
  3â€“5 minute window, but 22% finish under three minutes and 8% run past five.
- **Bot trading is nearly vestigial** (~0.19 trades per bot per match) â€” walking
  to a resource almost always beats a 4:1 swap. A human can trade end to end
  without trouble; this is a balance question rather than a defect.
- **Strategy balance skews to the card bot**, 40% against an expected 33%.
- **Frame rate is unmeasured on real hardware.** The capture rig runs SwiftShader
  at about 3fps, which proves correctness, not performance. Draw calls and
  triangles are inside budget, but device fps is unconfirmed.
- **The audio has never actually been heard** â€” headless Chrome produces no
  sound. It is structurally verified (every effect schedules real nodes, no NaN
  envelopes) but unauditioned.
- **Safe-area insets are unverified on a notched phone**, because `env()` returns
  0 headlessly. An 18px gutter floor is in place as insurance.

## Licence / assets

Every asset is generated at runtime by this repository's own code. There are no
third-party models, textures, fonts or audio files, and nothing is fetched from
a CDN. The only dependency is three.js, vendored at `vendor/three.module.js`.
The game is an original work inspired by the settlement-and-trade genre; it uses
no trademarked names, artwork or board designs.

