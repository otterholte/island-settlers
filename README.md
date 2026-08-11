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
The game is plain ES modules, so it has to be served over HTTP — module imports
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
> starting a server — you get no error and nothing on the port. Use `node serve.mjs`.

### Play on your phone

With the phone and the computer on the same wi-fi, find your computer's LAN
address and open `http://<that-address>:5173` on the phone, then turn it
landscape. The game will prompt you to rotate if you are in portrait.

- **macOS:** `ipconfig getifaddr en0`
- **Windows:** `ipconfig` → the IPv4 address of your wi-fi adapter
- **Linux:** `hostname -I | awk '{print $1}'`

### Playing with friends

Press **PLAY WITH FRIENDS**, type your name once — it is saved on your device
and never asked for again — and either **CREATE A ROOM** or type somebody
else's five-character code and press **JOIN**.

There are no accounts, no passwords, no friends list and nothing to accept.
Whoever types the code while the room is open is in, up to four of you; empty
seats become bots at the room's difficulty. Everybody presses **START** and the
match begins on the last press.

Multiplayer needs the small server in `server/` — see `server/README.md`. The
address is compiled in and the game also falls back to the page's own origin,
so a locally-served copy needs no configuration; `?server=wss://host/ws`
overrides it for one tab.

### Install it to the home screen

The game is a PWA: `manifest.webmanifest` plus a network-first service worker
in `sw.js`. Installed, it runs with no address bar and starts in landscape.

- **Android / Chrome:** the opening screen shows an **ADD TO HOME SCREEN**
  chip as soon as the browser considers the site installable. Tapping it is
  the browser's own install prompt.
- **iOS / Safari:** Share ▸ Add to Home Screen. Safari has no programmatic
  install, so the chip there is a label pointing at that menu.

Both need **https** (or `localhost`) — the worker is not registered over a
plain-http LAN address on purpose, so the dev server never holds a cache.
The worker always tries the network first: there is no build step and no
content hashing in any filename, so a cache-first worker would pin whichever
version of the game a player first opened, forever. Offline it serves the last
version played instead of a browser error.

Icons are generated, not drawn by hand — `node tools/mkicons.mjs`.

### Controls

| | Touch | Keyboard |
|---|---|---|
| Move | Drag anywhere on the screen — an invisible stick appears under your thumb | arrow keys |
| Gather | Run over a tree, clay pile, sheep, wheat stand or ore seam — it is yours on contact | — |
| Board map | Tap **MAP** | `Tab` |
| Pause | Tap **PAUSE** | `Space` or `P` |
| Build cards | Tap **BUILD** | `B` |
| Build | Tap a build card, then tap a highlighted spot on the map and tap it again | `R` road · `S` settlement · `C` city · `D` card |
| Trade | Walk to the market or one of your unlocked docks, then tap the prompt | `T` Trading Post · `M` your dock |
| Choose | Tap a target, tap it again to place | arrows move · `Enter` places · `Tab` cycles the piece |
| Menus | Tap | arrows move · `Enter` presses · `Esc` backs out |
| Settings | Tap the gear | `Esc` with nothing else open |

### Playing with no mouse

**The four arrow keys are the only movement keys.** `W A S D` used to be a
second set and it is gone on purpose: it was the only thing standing between
the build shortcuts and the letters they should have, so the game trades a
duplicate way to walk for `R`, `S`, `C` and `D` meaning road, settlement, city
and development card.

Everything on a desktop is reachable from the keyboard. The opening screen
lands with **PLAY** already selected, the arrow keys walk a gold cursor round
every screen, menu, toggle and sheet, and `Enter` presses whatever the cursor is
on. Inside the board map the arrows move between glowing targets and `Tab`
switches between the pieces you can currently afford.

`Esc` always means "back out of the innermost thing": it clears a staged trade
before it closes the trade sheet, cancels a placement map, closes the settings —
and opens the settings when there is nothing in front of you.

In the trade sheet, `Enter` on a resource card pays the whole lot in one press;
if that balances the deal the cursor jumps to the green **TRADE** button, so a
second `Enter` completes it.

**HOW TO PLAY** under the gear opens the rules as a set of slides in the middle
of the screen, and the match genuinely stops while it is up — no board map, and
the sheet says PAUSED. On a screen bigger than an iPad it carries an extra
slide listing every shortcut, as does the illustrated rules book on the opening
screen.

When the match ends and you put the scoreboard away, the island is yours to
walk: the same joystick, the same arrow keys, the same follow camera, with the match
frozen underneath — nothing gathers, builds or scores. **BOARD VIEW** on the
review bar swaps that for the whole island pulled back, where dragging, pinching
and the wheel move the camera instead. **CLOSE VIEW** hands the settler back.

The three action keys are side-switchable under the gear: **Buttons
Left/Right**. The joystick needs no setting — it takes a drag from anywhere
that is not already a control, so it cannot be on the wrong side. Together
that is what a one-handed player needs: drag where your hand already is, and
put MAP, PAUSE and BUILD in the corner you can reach.

---

## How the match works

**Opening draft.** Snake order (you, Alex, Maya, Finn, Finn, Maya, Alex, you).
Each player places two settlements and two roads. Your second settlement pays
out its adjacent resources immediately, as in the tabletop game.

**Gathering is real-time, and nothing is ever rolled.** Every hex wears a wooden
disc numbered **1 to 10**, and the number is a plain rank rather than a dice
probability: **10 is the richest hex on the island and 1 is the poorest**. It
sets two things and only two — how many things the hex holds when it is full,
and how long it stays bare after you sweep it clean:

| number | things on it | back in |
|---|---|---|
| 9 · 10 | 28 | 6s |
| 7 · 8 | 23 | 10s |
| 5 · 6 | 17 | 16s |
| 3 · 4 | 8 | 28s |
| 1 · 2 | 5 | 34s |

You may only collect on a hex where you own a settlement or a city on one of its
corners; everywhere else yields nothing at all. The board deals two of every
number except 1 and 2, which appear once each, and the two best hexes — the 9s
and 10s, printed in red — never share a corner. That is what makes placement
matter when there are no dice.

**Costs.** Road 4 wood + 4 brick · Settlement 4 wood + 4 brick + 4 wheat + 4 wool
· City 8 wheat + 12 ore · Development card 4 wool + 4 wheat + 4 ore.
(Read from `src/core/constants.js` — change them there and every card, chip and
rules page follows.)

**Scoring to 12.** Settlement 1 · City 2 · Longest Road 4 · Largest Army 2 ·
Victory Point card 1.

**Development cards.** *Knight* — rivals drop half of everything they carry and
you move the Raider onto a region, which blocks everyone but you. *Road
Building* — two free roads. *Victory Point* — one point, immediately.

**The bots have real identities.** Alex expands and chases Longest Road, Maya
builds and upgrades to cities, Finn buys cards and hunts Largest Army. They walk
to every resource they gather and every dock they trade at — no teleporting, and
every resource they own comes from a rules call. That is asserted automatically
across 60 simulated matches.

---

## Tools

```bash
node tools/verify.mjs                            # board graph + rules structural checks
node tools/boardsync.mjs                         # one seed, separate processes, same island
node tools/simulate.mjs --matches=60 --gathersys # headless bot-vs-bot pacing + balance
node tools/nettest.mjs                           # a real server, two sockets, a whole match
node tools/testmatch.mjs                         # drives the real game in headless Chrome
node tools/kbtrace.mjs --stage=keys               # every desktop shortcut, over real key events
node tools/kbtrace.mjs --stage=trade              # the trade sheet, driven entirely by keyboard
node tools/shoot.mjs --stage=play --w=960 --h=444 # capture real screenshots
node tools/mkicons.mjs                           # redraw the home-screen icons
```

`testmatch.mjs` and `shoot.mjs` need a Chrome binary; set `--chrome=/path/to/chrome`
if it is not at the default. Start the dev server first — they drive the live page
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
                      kbnav.js   arrow-key cursor for every menu and sheet
                      hotkeys.js the in-match letters and the Escape ladder
                      hud-help.js HOW TO PLAY, as a paused slide sheet
  audio/              synth, sfx bank, music + ambience beds
  fx/                 particles, floating labels, rings
tools/                verify, simulate, shoot, testmatch
progress/             build status page, screenshots, reference art
```

`src/core/` and `src/board/` are the contract layer: pure data and pure rules,
with no three.js or DOM references. The 3D game and the headless simulator run
exactly the same rules code, which is why the pacing numbers mean anything.

Open `progress/index.html` for the full build report — screenshots, the critic
findings that drove each art pass, the verification table, and the pacing
distribution.

---

## Known gaps

- **Match length has wide tails.** Median is 3m24s and 70% of matches land in the
  3–5 minute window, but 22% finish under three minutes and 8% run past five.
- **Bot trading is nearly vestigial** (~0.19 trades per bot per match) — walking
  to a resource almost always beats a 4:1 swap. A human can trade end to end
  without trouble; this is a balance question rather than a defect.
- **Strategy balance skews to the card bot**, 40% against an expected 33%.
- **Frame rate is unmeasured on real hardware.** The capture rig runs SwiftShader
  at about 3fps, which proves correctness, not performance. Draw calls and
  triangles are inside budget, but device fps is unconfirmed.
- **The audio has never actually been heard** — headless Chrome produces no
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

