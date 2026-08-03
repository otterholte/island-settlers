/**
 * Island Settlers — bootstrap and frame loop.
 *
 * Modules are loaded defensively so the build still boots while parallel work
 * is landing. A missing module degrades to a no-op instead of a white screen.
 */

import * as THREE from 'three';
import { createMatch, drainEvents, tickWorld } from './core/rules.js';

const NOOP = () => {};
const stub = (extra = {}) => ({ update: NOOP, ...extra });

async function load(path, fallback) {
  try {
    return await import(path);
  } catch (e) {
    console.warn(`[boot] ${path} unavailable —`, e.message);
    return fallback;
  }
}

async function boot() {
  const canvas = document.getElementById('gl');
  const uiRoot = document.getElementById('ui');

  const renderer = new THREE.WebGLRenderer({
    canvas, antialias: true, powerPreference: 'high-performance', alpha: false
  });
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
  renderer.setSize(innerWidth, innerHeight, false);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x8fd4ef);
  scene.fog = new THREE.Fog(0x9adcf0, 150, 340);

  /* ------------------------------------------------------- the same island
     A networked match hands its board over as a SEED, and the deal has to
     happen here — before the module list below is even loaded, let alone the
     terrain, the props, the docks and the three hundred pickups built from it.
     `reshuffle` re-dresses the tiles in place and every one of those modules
     reads them on the way up, so this is the only moment in the page's life at
     which the island can change. That is why joining a match reloads the page:
     see `src/net/netmatch.js`. */
  let joining = null;
  try {
    const net = await load('./net/netmatch.js', null);
    joining = net && net.pendingMatch ? net.pendingMatch() : null;
  } catch (e) {
    console.warn('[boot] no networked match to join —', e && e.message);
    joining = null;
  }

  /* THREE SEPARATE FAILURES, NOT ONE.
   *
   * These used to share a try, and the two cheap imports at the bottom could
   * therefore throw away a board that had already been dealt correctly: one
   * catch, `joining = null`, and a client sitting on exactly the right island
   * with the net layer never started, playing three local bots on it. The
   * board landing and the options landing are different-sized problems and get
   * different answers. */
  if (joining) {
    try {
      const { reshuffle } = await import('./board/layout.js');
      reshuffle(joining.seed >>> 0);
    } catch (e) {
      // Fatal to the handoff: without the seed this page is a different island
      // from everybody else's, which is worse than not joining at all.
      console.error('[boot] could not deal the served island —', e && e.message);
      joining = null;
    }
  }
  if (joining) {
    try {
      const opt = await import('./core/options.js');
      if (opt && opt.setKnights) opt.setKnights(joining.knights !== false);
      const diff = await import('./systems/difficulty.js');
      if (diff && diff.setDifficulty && joining.difficulty) diff.setDifficulty(joining.difficulty);
    } catch (e) {
      // Cosmetic by comparison — the server is authoritative about both. Play.
      console.warn('[boot] match options did not apply —', e && e.message);
    }
  }

  const state = createMatch({ seed: joining ? (joining.seed >>> 0) : ((Math.random() * 1e9) | 0) });

  // ---------------------------------------------------------------- modules
  const [
    skyM, waterM, islandM, propsM, structM, marketM,
    settlerM, camM, inputM, ctrlM,
    gatherM, botM, ecoM, flowM,
    hudM, overM, panelM,
    audioM, fxM
  ] = await Promise.all([
    load('./world/sky.js',        { buildSky: () => stub({ sun: null }) }),
    load('./world/water.js',      { buildWater: () => stub() }),
    load('./world/island.js',     { buildIsland: () => stub({ heightAt: () => 0 }) }),
    load('./world/props.js',      { buildProps: () => stub({ playHarvest: NOOP, setDepleted: NOOP }) }),
    load('./world/structures.js', { buildStructures: () => stub({ syncFromState: NOOP, spawnRoad: NOOP, spawnSettlement: NOOP, upgradeCity: NOOP, setRobber: NOOP, ghostRoad: NOOP, ghostSettlement: NOOP, clearGhost: NOOP }) }),
    load('./world/market.js',     { buildMarket: () => stub(), buildPorts: () => stub({ setUnlocked: NOOP }) }),
    load('./entities/settler.js', { createSettler: () => ({ group: new THREE.Group(), setPose: NOOP, playChop: NOOP, setCarry: NOOP, celebrate: NOOP }) }),
    load('./systems/camera.js',   null),
    load('./systems/input.js',    { createInput: () => ({ stick: { x: 0, y: 0 }, tapped: false, actionPressed: false, update: NOOP }) }),
    load('./entities/playerController.js', { createPlayerController: () => stub() }),
    load('./systems/gathering.js', { createGathering: () => stub() }),
    load('./systems/bots.js',      { createBots: () => stub() }),
    load('./systems/economy.js',   null),
    load('./systems/matchflow.js', { createMatchFlow: () => stub({ begin: NOOP }) }),
    load('./ui/hud.js',       { createHUD: () => stub({ toast: NOOP, announce: NOOP, pulseResource: NOOP, flashCost: NOOP, requestBuild: NOOP, onPlayBegan: NOOP }) }),
    load('./ui/overview.js',  { createOverview: () => stub({ open: NOOP, close: NOOP, isOpen: false }) }),
    load('./ui/panels.js',    { createPanels: () => stub({ openTrade: NOOP, openCards: NOOP, showResults: NOOP, close: NOOP }) }),
    load('./audio/audio.js',  { createAudio: () => ({ sfx: NOOP, music: NOOP, ambience: NOOP, unlock: NOOP }) }),
    load('./fx/effects.js',   { createEffects: () => stub({ burst: NOOP, floatText: NOOP, ring: NOOP, shockwave: NOOP }) })
  ]);

  // ---------------------------------------------------------------- systems
  const audio = audioM.createAudio();
  const effects = fxM.createEffects(scene);

  const sky = skyM.buildSky(scene, renderer);
  const water = waterM.buildWater(scene);
  const island = islandM.buildIsland(scene);
  const props = propsM.buildProps(scene);
  const structures = structM.buildStructures(scene, state);
  const market = marketM.buildMarket(scene);
  const portsView = marketM.buildPorts(scene, state);

  // Ground sampler — everything in the world sits on this.
  const heightAt = island.heightAt || (() => 0);

  const world = {
    scene, renderer, island, water, props, structures,
    market, portsView, effects, audio, sky, heightAt
  };

  // Settlers ------------------------------------------------------------
  const avatars = state.players.map(p => {
    const s = settlerM.createSettler(p.color.hex, p.id === 0);
    scene.add(s.group);
    s.group.position.set(p.x, heightAt(p.x, p.z), p.z);
    return s;
  });
  world.avatars = avatars;

  const gameCamera = camM
    ? camM.createGameCamera(renderer, scene)
    : (() => {
        const c = new THREE.PerspectiveCamera(48, innerWidth / innerHeight, 0.5, 800);
        c.position.set(0, 70, 80); c.lookAt(0, 0, 0);
        return {
          camera: c, follow: NOOP, setOverview: NOOP, celebrate: NOOP,
          shake: NOOP, update: NOOP, isOverview: false
        };
      })();
  const camera = gameCamera.camera;
  world.camera = gameCamera;

  const input = inputM.createInput(document.getElementById('app'));
  const controller = ctrlM.createPlayerController(state, avatars[0], gameCamera, input, world);
  const gathering = gatherM.createGathering(state, world);
  const bots = botM.createBots(state, world);

  // ---------------------------------------------------------------- game api
  const game = {
    state, world, audio, effects, camera: gameCamera, input, avatars,
    economy: ecoM,
    requestBuild(kind) { return hud.requestBuild ? hud.requestBuild(kind) : null; },
    // Returns overview.open's own verdict: FALSE when there was nothing legal
    // to offer and the panel was deliberately left alone. Swallowing it meant
    // every caller that checks (`economy.openPlacement`, `placeFreeRoads`, the
    // Road Building cue) believed the map had come up when it had not — which
    // is one of the two ways a Road Building card used to be spent on nothing.
    openOverview(mode, opts) { return overview.open(mode, opts); },
    closeOverview() { overview.close(); },
    openTrade(portId) { panels.openTrade(portId ?? null); },
    openCards() { panels.openCards(); },
    restart() {
      // A full reload, deliberately. The board is dealt fresh at module load,
      // so restarting in place would replay the same island — and a new island
      // every match is the whole point. Costs about a second of rebuild.
      location.reload();
    },
    /**
     * Abandon the match and go back to the opening screen.
     *
     *   "Let the home button on the left of the screen work all the time and
     *    exit the game back to the home screen even when other players or bots
     *    are choosing their spots in the draft."
     *
     * Same reload as restart(), and for the same reason — the intro is what a
     * cold boot lands on, so a reload IS the home screen, and it is the one
     * exit that cannot be left half-done by whatever phase was mid-flight. The
     * draft is precisely the phase where an in-place teardown is hairiest
     * (bots hold goals, matchflow holds a script, the map is locked open), and
     * it is the phase the player named.
     */
    leaveMatch() {
      try { if (overview && overview.close) overview.close(); } catch (e) { /* going anyway */ }
      location.reload();
    },
    toast(msg, kind) { hud.toast(msg, kind); }
  };

  const hud = hudM.createHUD(uiRoot, state, game);
  const overview = overM.createOverview(uiRoot, state, game);
  const panels = panelM.createPanels(uiRoot, state, game);
  game.hud = hud; game.overview = overview; game.panels = panels;

  // The simulation systems are part of the public `game` surface: matchflow
  // needs `bots` so an in-place restart can wipe stale bot goals, and the
  // verification harness drives the same functions the frame loop does.
  game.bots = bots;
  game.gathering = gathering;
  game.controller = controller;

  const flow = flowM.createMatchFlow(state, game);
  game.flow = flow;
  if (ecoM && ecoM.attach) ecoM.attach(game);

  /* ------------------------------------------------------------ multiplayer
     One connection per page, shared by the friends screen and the match. It
     dials only when somebody asks for it — a solo player never opens a socket
     and never needs to know a server exists. */
  let net = null;
  try {
    const netM = await load('./net/netmatch.js', null);
    const clientM = await load('./net/client.js', null);
    if (netM && clientM) {
      const client = clientM.netClient();
      net = netM.createNetMatch(state, game, client);
      game.net = net;
      game.netClient = client;
      // Loaded straight into a match: take it over now rather than waiting for
      // the server to say so again, so the board and the seats are right while
      // the load-in pause runs.
      if (joining) { net.start(joining); client.connect(); }
    }
  } catch (e) {
    console.warn('[boot] multiplayer unavailable —', e && e.message);
    net = null;
  }

  // ---------------------------------------------------------------- resize
  const resize = () => {
    const w = innerWidth, h = innerHeight;
    renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    const gate = document.getElementById('rotate-gate');
    if (gate) gate.classList.toggle('show', h > w * 1.08);
  };
  addEventListener('resize', resize);
  addEventListener('orientationchange', () => setTimeout(resize, 120));
  resize();

  // ---------------------------------------------------------------- events
  const gatherSound = r =>
    ({ wood: 'chop', brick: 'dig', ore: 'mine', wheat: 'reap', wool: 'shear' }[r] || 'chop');

  /* ------------------------------------------------- the held Knight card
   *
   *   "If a Knight is played you won't know until you exit the trading post or
   *    port, that way you can't be stolen from while actively trading. But you
   *    don't know the Knight hit until you leave the port or trading post."
   *
   * Offline this is handled by stopping the world; online the world cannot be
   * stopped, so the SECRET is kept instead. A Knight that lands while a sheet
   * is open goes in here — silently, no horn, no shake, no banner — and is
   * released the moment the sheet closes, whole, with its own card and its own
   * announcement. What the player is looking at while they trade is a pack
   * that has not moved (hud.js latches the counters for the same reason), so
   * the trade they are halfway through is the trade they set up.
   *
   * A second Knight inside the window replaces the first only in the sense
   * that both are shown, in order, on the way out.
   */
  const heldKnights = [];
  let sheetWasOpen = false;

  function sheetOpen() {
    return !!(panels && panels.isOpen && state.phase === 'play');
  }

  function releaseHeldKnights() {
    if (!heldKnights.length) return;
    const batch = heldKnights.splice(0);
    // A beat after the sheet is gone, so the card is not fighting the closing
    // animation for the middle of the screen.
    setTimeout(() => {
      for (const ev of batch) showKnight(ev, true);
    }, 260);
  }

  function showKnight(ev, late) {
    structures.setRobber(ev.tile);
    audio.sfx('horn');
    effects.shockwave(ev.tile);
    state.players.forEach(p => avatars[p.id].setCarry(p.res));
    const mine = (ev.losses || []).find(l => l.player === 0);
    const tookFromMe = ev.player !== 0 && mine && mine.total > 0;
    hud.raid(ev);
    const who = state.players[ev.player];
    if (tookFromMe) {
      audio.sfx('deny');
      gameCamera.shake && gameCamera.shake(0.5);
      hud.announce(
        late ? `${who.name} played a Knight while you traded!` : `${who.name} played a Knight!`,
        '#ff8a6a');
    } else {
      hud.announce(`${who.name} sent the Knight!`, who.color.css);
    }
  }

  function handleEvents() {
    // Closing a sheet is what lets the news out. Checked here rather than in
    // panels.js so there is one place that knows about the hold.
    const open = sheetOpen();
    if (sheetWasOpen && !open) releaseHeldKnights();
    sheetWasOpen = open;

    for (const ev of drainEvents(state)) {
      switch (ev.type) {
        case 'gained': {
          const p = state.players[ev.player];
          effects.floatText(ev.x, ev.z, `+${ev.amount}`, ev.resource);
          effects.burst(ev.x, ev.z, ev.resource);
          props.playHarvest(ev.node);
          if (ev.depleted) props.setDepleted(ev.node, true);
          if (ev.player === 0) { audio.sfx('gain'); hud.pulseResource(ev.resource); }
          avatars[ev.player].setCarry(p.res);
          break;
        }
        case 'gatherStart':
          audio.sfx(gatherSound(ev.resource), { gain: ev.player === 0 ? 1 : 0.35 });
          avatars[ev.player].playChop(ev.resource);
          break;
        case 'build':
          if (ev.kind === 'road') structures.spawnRoad(ev.at, ev.player);
          if (ev.kind === 'settlement') structures.spawnSettlement(ev.at, ev.player);
          if (ev.kind === 'city') structures.upgradeCity(ev.at, ev.player);
          audio.sfx(ev.kind === 'city' ? 'upgrade' : 'build');
          break;
        case 'trade':     audio.sfx('trade'); break;
        case 'cardDrawn': audio.sfx('card'); break;
        case 'roadBuilding':
          audio.sfx('card');
          if (ev.player === 0) hud.toast('Road Building — place two roads free');
          break;
        case 'knight': {
          // Online, and mid-trade: hold it. See the block above handleEvents.
          if (net && net.active && sheetOpen()) { heldKnights.push(ev); break; }
          showKnight(ev, false);
          break;
        }
        case 'award':
          audio.sfx('award');
          hud.announce(
            `${state.players[ev.player].name} claims ` +
            `${ev.kind === 'longestRoad' ? 'Longest Road' : 'Largest Army'}!`,
            state.players[ev.player].color.css
          );
          break;
        case 'portUnlocked':
          if (ev.player === 0) hud.toast('Port unlocked — head over to trade');
          portsView.setUnlocked && portsView.setUnlocked(ev.port, ev.player);
          break;
        case 'blocked':
          hud.toast('The Knight blocks this region', 'warn');
          audio.sfx('deny');
          break;
        case 'victory':
          audio.music('victory');
          panels.showResults(ev.player);
          gameCamera.celebrate(state.players[ev.player]);
          avatars[ev.player].celebrate();
          break;
        case 'setupComplete':
          hud.onPlayBegan();
          audio.music('play');
          break;
      }
    }
  }

  // ---------------------------------------------------------------- loop
  const bootEl = document.getElementById('boot');
  if (bootEl) bootEl.classList.add('done');

  let last = performance.now();
  let acc = 0;
  const FIXED = 1 / 60;

  function frame(now) {
    requestAnimationFrame(frame);
    const dt = Math.min((now - last) / 1000, 0.1);
    last = now;
    acc += dt;

    input.update();

    let steps = 0;
    // ANYTHING THAT OWNS THE SCREEN PAUSES THE MATCH.
    //
    // Opening the map is a thinking action — choosing where the Knight goes,
    // where a road runs, which corner to claim. Letting the clock and three
    // rivals run while the player reads the board punished them for looking,
    // and made the Knight in particular feel like it never stopped to ask.
    // So while the overview is up, the simulation holds: no match clock, no
    // bots, no gathering, no settler. Flow still ticks, because it is what
    // drives the panel that is open.
    //
    // THE TRADE SHEET NOW COUNTS TOO.
    //
    //   "Have the game pause for the bots in the background if you are actively
    //    at a port or the trading post, so that I can't be stolen from while
    //    actively trading."
    //
    // The board map has held the match since the Knight flow needed it, and the
    // trade sheet — which is a modal that covers the island, takes the keyboard
    // off the settler and cannot be reacted through — never did. So a rival
    // could play a Knight and take half of everything the player owned while
    // that player was mid-way through counting out a 4:1 exchange, with no
    // warning they could act on and nothing they could have done about it. A
    // sheet the player cannot see past should not be a window rivals can hit
    // them through.
    //
    // Every in-play sheet is covered, not only the trade one: the CARDS sheet
    // is the same kind of modal for the same reason. The results sheet is
    // excluded by the phase test, because a finished match is already frozen by
    // `matchflow.freezeMatch` and nothing here should second-guess that.
    //
    // Note this is the sheet being OPEN, not the settler standing near a post.
    // The trade chip appears whenever you are on a post's own hex, and freezing
    // three rivals every time somebody runs across the desert — or parks there
    // — would be a very different feature.
    //
    // ONLINE, NONE OF THAT IS TRUE — AND IT CANNOT BE.
    //
    //   "Because it's multiplayer and normally the game pauses at certain
    //    points, if it's now multiplayer, maybe make it so that during what
    //    would've been pause points the timer and other players still go, but
    //    if a Knight is played you won't know until you exit the trading post
    //    or port, that way you can't be stolen from while actively trading."
    //
    // Three other people cannot be frozen because one of them opened a sheet,
    // and a clock that stops on one machine and not the others is not a clock.
    // So online the world keeps running and the PROTECTION MOVES: the trade
    // sheet renders from a snapshot of your pack taken when it opened, and the
    // Knight card that would have told you what you lost is held until you
    // close it. You cannot be robbed mid-trade because you cannot find out you
    // were robbed mid-trade, and the numbers you are trading against do not
    // move under your hands. See `netHold` below and hud.js's `latchResources`.
    const online = !!(net && net.active);
    const sheetPaused = !online && !!(panels && panels.isOpen && state.phase === 'play');
    const mapPaused = !online && (!!(overview && overview.isOpen) || sheetPaused);

    while (acc >= FIXED && steps++ < 4) {
      acc -= FIXED;
      flow.update(FIXED);
      if (mapPaused) continue;
      if (online) {
        // The server ticks the world, gathers for everybody and drives the
        // bots. What is left here is the local half: your own settler is
        // predicted at 60Hz so it answers the stick immediately, and everyone
        // else is eased between snapshots.
        controller.update(FIXED);
        net.update(FIXED);
        continue;
      }
      tickWorld(state, FIXED);
      controller.update(FIXED);
      gathering.update(FIXED);
      bots.update(FIXED);
    }

    for (const p of state.players) {
      const a = avatars[p.id];
      const k = Math.min(1, dt * 22);
      a.group.position.x += (p.x - a.group.position.x) * k;
      a.group.position.z += (p.z - a.group.position.z) * k;
      a.group.position.y = heightAt(a.group.position.x, a.group.position.z);
      a.setPose(p, now / 1000);
    }

    handleEvents();

    // Road Building credits the player two free roads, but nothing was ever
    // opening the map to spend them — the card was played and the player was
    // left owed roads with no way to place them. Driving it from the event
    // proved unreliable, so this reconciles from state instead: any frame the
    // player is owed a road and nothing else is in the way, offer the map.
    // Self-healing, so cancelling and finishing later works too.
    if (ecoM && ecoM.placeFreeRoads && state.phase === 'play' &&
        (state.players[0].freeRoads | 0) > 0 &&
        !overview.isOpen && !(panels.kind) &&
        !(flow.stage && flow.stage !== 'play')) {
      ecoM.placeFreeRoads(game);
    }

    props.update(dt);
    structures.update(dt);
    market.update(dt);
    portsView.update(dt);
    water.update(now / 1000);
    island.update(dt, camera);
    effects.update(dt);
    gameCamera.update(dt, state, overview.isOpen);
    hud.update(dt);
    overview.update(dt);
    panels.update(dt);
    sky.update(now / 1000);

    renderer.render(scene, camera);
  }
  requestAnimationFrame(frame);

  // First touch unlocks WebAudio on mobile.
  const unlock = () => {
    audio.unlock(); audio.ambience(true);
    removeEventListener('pointerdown', unlock);
  };
  addEventListener('pointerdown', unlock);

  window.__ISLAND__ = { state, game, world, renderer, scene, camera, THREE };
}

boot().catch(err => {
  console.error(err);
  const b = document.getElementById('boot');
  if (b) b.innerHTML =
    `<div style="color:#fff;font:600 16px system-ui;padding:24px;text-align:center">
       Failed to start.<br><span style="opacity:.7;font-weight:400">${err.message}</span></div>`;
});
