# Island Settlers — module contract

**Read this before writing any code.** Every agent builds against these
interfaces so parallel work integrates without merge pain.

## Ground rules

- Plain ES modules, no bundler. `import * as THREE from 'three'` resolves via
  the import map in `index.html` to `./vendor/three.module.js`.
- **Never** add an npm dependency or fetch a remote asset. No CDN, no
  downloaded textures/models, no webfonts. Every asset is procedural:
  geometry built in code, textures painted to an offscreen `<canvas>`.
- The four home-screen icons under `icons/` are the only binary files in the
  build, and they are not an exception to the rule above: `tools/mkicons.mjs`
  draws them in code and encodes the PNGs with `node:zlib`. Change the art
  there and re-run it; never hand-edit or import a PNG.
- Target: **landscape mobile web**, 60fps on a mid-range phone. Budget
  ~130k triangles visible, ≤ 90 draw calls total. Use `InstancedMesh` for
  anything repeated (trees, sheep, rocks, wheat, road segments, villagers).
- `BufferGeometryUtils` is NOT vendored — merge geometry manually.
  Use r169 APIs (`THREE.SRGBColorSpace`, `geometry.setAttribute`).
- No file may exceed ~900 lines. Split instead.
- Do not edit files owned by another agent (see ownership table).
- `src/core/constants.js`, `src/board/layout.js`, `src/board/nodes.js`,
  `src/core/rules.js` are **frozen contracts** — read, don't rewrite. If you
  need a change, add a new exported symbol rather than altering an old one.
- **Gathering is contact-based.** A hex is a dense field of ITEMS; running a
  settler over one collects it that instant. There is no gather timer, no
  progress ring and no `action === 'gather'`. A player may only collect on a hex
  where they own an adjacent settlement or city — everywhere else yields
  nothing, so there are no ×2/×3 yield badges any more. The number on a hex now
  means only two things: how many items it holds and how fast the whole hex
  grows back. Read the header of `src/board/nodes.js` for the full API
  (`items`, `tileItems`, `tileRecovery`, `canGatherTile`, `playerOwnsTile`).
- **The number on a hex is a rank from 1 to 10, not a dice roll.** Nothing is
  rolled in this game, so the tokens are `1..10` low to high — 10 is the best
  hex on the island — and there are no pips drawn anywhere. `pips` survives in
  the code as the internal 1..5 productivity RUNG (`pipsFor(n) = ceil(n/2)`,
  `core/constants.js`) that `TILE_ITEMS` and `TILE_REGEN` are keyed on; two
  printed numbers share each rung. `isHotNumber(n)` is the red numeral (9 and
  10), and the fairness rule those two carry is that they may never share a
  corner. See the long note at the top of `core/constants.js`.
- **Keyboard.** Three modules own it and nothing else may bind a window key
  without reading them first: `ui/kbnav.js` (arrow cursor over registered menu
  SCOPES, priority-ordered), `ui/hotkeys.js` (in-match letters and the Escape
  ladder) and each sheet's own handler (`ui/trade.js#key`, `ui/overview.js`).
  Every listener is on `window`, so a handler that consumes a key must call
  `stopImmediatePropagation` — plain `stopPropagation` does nothing between
  listeners on the same node.
- **Movement is the four ARROW KEYS and nothing else.** `W A S D` is not a
  movement set anywhere in the build — not in `systems/input.js`, not in the
  post-match `systems/freecam.js` — because every letter belongs to
  `ui/hotkeys.js` (`R` `S` `C` `D` build, `B` `T` `M` open things). Re-adding a
  letter to `MOVE_KEYS` silently breaks a shortcut, since hotkeys runs in the
  capture phase and gets the key first.
- **The ground is not at y=0.** Tile tops run ~1.76–3.71. Everything placed in
  the world must sit on `heightAt(x, z)` exported by `src/world/terrain.js`.

## Shared state

`createMatch()` from `src/core/rules.js` returns the single `state` object.
All gameplay mutation goes through exported functions in `rules.js`.
Presentation code reads `state` and consumes `drainEvents(state)` each frame.

### Events emitted by rules.js

| type | payload | meaning |
|---|---|---|
| `gained` | player, resource, amount, x, z, **item**, **tile**, node, depleted | one item picked up on contact |
| `exhausted` | tile, player, seconds | last item taken; the hex is bare and counting down |
| `restored` | tile | every item on the hex is back |
| `build` | player, kind (`road`/`settlement`/`city`), at (edge or intersection id) | piece placed |
| `trade` | player, give, get, ratio | exchange completed |
| `cardDrawn` | player, **card**, instant | dev card purchased (`card` was `type`, which overwrote the event's own type — see rules.drawCard) |
| `knight` | player, tile, losses[] | Raider moved, rivals robbed |
| `roadBuilding` | player, free | two free roads granted |
| `award` | kind (`longestRoad`/`largestArmy`), player, value | award changed hands |
| `portUnlocked` | player, port | dock became usable |
| `blocked` | player, tile, reason (`unowned`/`raider`) | tried to collect where they may not |
| `victory` | player | match over |
| `setupComplete` | — | draft finished, play begins |

## Module ownership

| module | exports | owner |
|---|---|---|
| `src/world/terrain.js` | `heightAt(x,z)`, palettes, noise | World |
| `src/world/island.js` | `buildIsland(scene) -> { group, tileMeshes, heightAt, highlightTile, update(dt,camera) }` | World |
| `src/world/water.js` | `buildWater(scene) -> { mesh, update(t) }` | World |
| `src/world/sky.js` | `buildSky(scene, renderer) -> { sun, update(t) }` | World |
| `src/world/props.js` | `buildProps(scene) -> { update(dt), playHarvest(id), setDepleted(id,b) }` | World |
| `src/world/structures.js` | `buildStructures(scene, state) -> { syncFromState, spawnRoad, spawnSettlement, upgradeCity, setRobber, ghostRoad, ghostSettlement, clearGhost, update }` | Structures |
| `src/world/market.js` | `buildMarket(scene)`, `buildPorts(scene, state)` | Structures |
| `src/entities/settler.js` | `createSettler(colorHex, isHuman) -> { group, setPose, playChop, setCarry, celebrate }` | Character |
| `src/entities/playerController.js` | `createPlayerController(state, settler, camera, input, world, { pid, roam }) -> { update(dt) }` | Character |
| `src/systems/input.js` | `createInput(dom) -> { stick, tapped, actionPressed, update }` | Character |
| `src/systems/camera.js` | `createGameCamera(renderer, scene) -> { camera, follow, setOverview, celebrate, shake, update, isOverview }` | Character |
| `src/systems/gathering.js` | `createGathering(state, world) -> { update(dt) }` | Gameplay |
| `src/systems/economy.js` | `attach(game)`, trade + purchase helpers | Gameplay |
| `src/systems/bots.js` | `createBots(state, world) -> { update(dt) }` | Bots |
| `src/systems/matchflow.js` | opening draft + win sequencing | Flow |
| `src/ui/hud.js` | `createHUD(root, state, game) -> { update, toast, announce, pulseResource, flashCost, requestBuild, onPlayBegan }` | UI |
| `src/ui/overview.js` | `createOverview(root, state, game) -> { open(mode,opts), close, update, isOpen }` | UI |
| `src/ui/panels.js` | `createPanels(root, state, game) -> { openTrade, openCards, showResults, close, update }` | UI |
| `src/ui/icons.js` | inline-SVG icon set | UI |
| `src/ui/kbnav.js` | `createKeyNav()`, `keyNav()` -> `{ registerScope, focusTop }` | UI |
| `src/ui/hotkeys.js` | `createHotkeys(state, game) -> { destroy }` | UI |
| `src/ui/hud-help.js` | `createHelp(root, state, game) -> { open, close, isOpen }` | UI |
| `src/ui/ui.css` | all interface styling | UI |
| `src/audio/audio.js` | `createAudio() -> { sfx, music, ambience, unlock }` | Audio |
| `src/fx/effects.js` | `createEffects(scene) -> { burst, floatText, ring, shockwave, update }` | FX |
| `src/main.js` | bootstrap + frame loop | Lead |

## `game` object passed to UI

```js
{
  state, world, audio, effects, camera, input, avatars,
  requestBuild(kind),          // 'road' | 'settlement' | 'city' | 'card'
  openOverview(mode, opts),    // 'view' | 'place-road' | 'place-settlement'
                               // | 'place-city' | 'place-robber'
  closeOverview(), openTrade(portId|null), openCards(),
  restart(), toast(msg, kind)
}
```

## Art direction (binding)

Match the reference images. Non-negotiable specifics:

- **Camera**: third-person, ~38–45° downward pitch, fov 45–52, positioned so
  roughly 3 hexes of island are visible around the settler. Overview pulls to a
  near-isometric framing of the whole island.
- **Palette**: saturated tropical. Deep cobalt ocean `#0e5fa8` → turquoise
  shallows `#3fc4d8`. Grass `#6db33f`→`#4a8c2a`. Sand `#e8d3a0`.
  Terracotta roofs `#c0562f`. Player blue `#3b7fd4`. Gold `#ffc93c`.
- **Lighting**: warm key sun from upper-left at ~50° elevation, colour
  `#fff2d0`; cool sky-blue hemisphere fill; soft shadows (PCFSoft, 2048 map,
  tight ortho frustum). Slight rim/backlight on characters.
- **Edges**: hex tiles have a chunky rim / cliff face down to the water with a
  lighter sand beach band — never a flat cut-out silhouette.
- **Density**: a forest tile carries 20+ trees plus stumps and undergrowth, not
  7. The gather nodes from `nodes.js` are the *harvestable* subset; scatter
  plenty of extra non-interactive dressing around them.
- **UI**: chunky rounded buttons with a light top bevel, 2px dark outline,
  drop shadow, and a coloured under-lip. Cream `#f6e7c6` panels with brown
  `#5a3a1e` outlines for build cards; deep navy glass `rgba(12,32,58,.86)` for
  status bars. Bold condensed all-caps labels with letter spacing.
- **Never ship**: untextured flat hexes, capsule characters, emoji as icons,
  default browser buttons, an empty sea, or visible placeholder text.
