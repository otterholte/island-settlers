/**
 * Island Settlers — bootstrap and frame loop.
 *
 * Modules are loaded defensively so the build still boots while parallel work
 * is landing. A missing module degrades to a no-op instead of a white screen.
 */

import * as THREE from 'three';
import { createMatch, drainEvents, tickWorld } from './core/rules.js';
import { CARD_LABEL } from './core/constants.js';
import * as seatColorM from './core/seatcolor.js';

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

  /*
   * ------------------------------------------------------------------------
   * HOW MANY PIXELS THIS IS ALLOWED TO COST
   * ------------------------------------------------------------------------
   *
   *   "When I have multiple tabs open on my computer and I try to start playing
   *    the game on my laptop, it started making my laptop glitch and keep
   *    flashing black sporadically multiple times a second. I need it to work
   *    well, and be optimised to function without a lot of compute."
   *
   * Flashing black many times a second is not a frame rate problem — a slow
   * frame is a slow frame, it is not a black one. That is the WebGL context
   * being lost and restored: the browser is short of GPU memory (a laptop, a
   * dozen tabs, each with its own context) or the machine has switched graphics
   * adapter underneath us. Every restore re-uploads the world, hence the
   * flicker rather than one drop.
   *
   * Three things, in order of how much they matter:
   *
   *   1. STOP ASKING FOR THE DISCRETE GPU. `powerPreference: 'high-performance'`
   *      tells a hybrid-graphics laptop to spin up the dGPU for a game whose
   *      whole frame is 74 draw calls and 124k triangles. When Windows decides
   *      to switch back — battery saver, thermal, another tab wanting the same
   *      adapter — the context goes with it. On integrated graphics this scene
   *      is not remotely demanding; asking for 'default' is asking the browser
   *      to make that choice, which it makes better than we can.
   *
   *   2. A PIXEL BUDGET, not a device-pixel-ratio cap. `min(dpr, 2)` on a
   *      1512x945 retina laptop is 5.7 MILLION fragments per frame, every one of
   *      them shaded and shadowed, which is three times what the same game
   *      renders on the phone it was designed for. The budget below caps the
   *      TOTAL, so a big window gets a lower ratio and a small one still gets a
   *      sharp 2x. Sharpness is bounded by the screen; cost is bounded by this.
   *
   *   3. MSAA only when the ratio is not already doing that job. Above 1.5x the
   *      supersampling is the antialiasing, and the multisample buffer is pure
   *      memory — the exact thing in short supply when contexts start dying.
   *
   * And the frame loop caps at 60Hz (see `MIN_FRAME_MS`) so a 120Hz laptop panel
   * does not double the bill for a game that simulates at 60.
   */
  const PIXEL_BUDGET = 2.30e6;
  function budgetRatio(w, h) {
    const dpr = Math.min(devicePixelRatio || 1, 2);
    const px = Math.max(1, (w || 1) * (h || 1));
    return Math.max(1, Math.min(dpr, Math.sqrt(PIXEL_BUDGET / px)));
  }

  /*
   * WHICH RUNG THIS MACHINE STARTS ON, DECIDED BEFORE THE FIRST FRAME.
   *
   *   "The only problem is that I have to go into a game, get through the draft,
   *    get to the board, and press the settings bar before I see it. Is there a
   *    simple way to automatically test if the computer is low on compute
   *    reliably, and automatically turn on the graphics saver as soon as the app
   *    is opened?"
   *
   * There is nothing to measure yet, so this is a guess off what the browser
   * will say — memory, cores, the GL adapter's own name — plus what this machine
   * did last time, which is the strongest signal of the lot. `systems/quality.js`
   * owns the reasoning and, once frames exist, the measuring.
   *
   * The guess has to happen HERE, before the renderer is constructed, because
   * two of the savings cannot be changed afterwards: the multisample buffer
   * (`antialias`) and the adapter preference are fixed at context creation.
   */
  const qualityM = await load('./systems/quality.js', null);
  /* A THROWAWAY CANVAS, not the real one. Asking the game's canvas for a
     context here would hand three.js that same context a moment later — with
     the attributes THIS call asked for, silently ignoring the antialias and
     alpha settings below, because a canvas only ever has one context. */
  let probeGL = null;
  try {
    const scratch = document.createElement('canvas');
    scratch.width = 1; scratch.height = 1;
    probeGL = scratch.getContext('webgl2') || scratch.getContext('webgl');
  } catch (e) { probeGL = null; }
  const guessed = (qualityM && qualityM.guessLevel)
    ? qualityM.guessLevel({ renderer: qualityM.rendererName(probeGL) })
    : { level: 2, why: ['quality module unavailable'] };
  let startLevel = guessed.level;
  try {
    const opt = await import('./core/options.js');
    // The old boolean setting still wins if somebody chose it by hand.
    if (opt.lowPower() && startLevel > 1) startLevel = 1;
  } catch (e) { /* the option is a nicety */ }
  console.info('[quality] starting at', startLevel, '·', guessed.why.join('; '));

  function ratioFor(w, h) {
    return startLevel === 2 ? budgetRatio(w, h) : 1;
  }
  const ratio0 = ratioFor(canvas.clientWidth || innerWidth, canvas.clientHeight || innerHeight);

  const renderer = new THREE.WebGLRenderer({
    canvas,
    // No multisample buffer on the bottom rung: it is several megabytes of the
    // exact thing that runs out, and at ratio 1 it is the only antialiasing —
    // which is a trade worth making on a machine that is dropping contexts.
    antialias: startLevel === 2 && ratio0 < 1.5,
    powerPreference: startLevel === 2 ? 'default' : 'low-power',
    alpha: false
  });
  renderer.setPixelRatio(ratio0);
  // Provisional; `resize()` below re-measures off the canvas itself, which is
  // the only number that cannot disagree with the CSS box.
  renderer.setSize(canvas.clientWidth || innerWidth, canvas.clientHeight || innerHeight, false);
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

  /*
   * EVERY RENDERER ASKS THE PLAYER WHAT COLOUR THEY ARE, NOT THE PALETTE.
   *
   *   "On player one's screen the roads they built were blue, and for the
   *    other player, looking at the same roads, they were purple — and one of
   *    the bots was building blue things."
   *
   * The pieces that read `state.players[i].color` were right on both screens
   * and the pieces that indexed `PLAYER_COLORS` by seat were wrong on all but
   * one, because `mirror.js` renumbers seats so the local player is index 0.
   * One line: the lookup in `core/seatcolor.js` is pointed at this array — the
   * same array the mirror assigns colours on — and structures, dock flags, the
   * victory flood and the region tint all follow it from here without being
   * told again.
   */
  seatColorM.useSeats(state.players);

  /* YOUR SEAT TAKES YOUR NAME, IF THIS DEVICE HAS EVER BEEN GIVEN ONE.
     The room screen saves it and never asks again, so a player who has played
     with friends already told us — and there is no reason the scoreboard of a
     single-player match should be the one place that does not know. Nobody has
     to: `playerName()` is '' on a fresh device and the seat keeps its 'You',
     which every line that addresses the player is written against. */
  try {
    const named = (await import('./core/options.js')).playerName();
    if (named && state.players[0]) state.players[0].name = named;
  } catch (e) { /* the label is a nicety; the match is not */ }

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

  /*
   * THE LADDER. `systems/quality.js` decides which rung; this hands it the
   * three levers — the shadow pass, the pixel ratio and the interface's
   * backdrop blur — and a place to say so.
   */
  const quality = (qualityM && qualityM.createQuality)
    ? qualityM.createQuality({
      renderer, scene, root: uiRoot, level: startLevel,
      sunOf: () => (sky && sky.sun) || null,
      ratioFor: budgetRatio,
      onChange: (lvl, why) => {
        console.info('[quality] ->', lvl, why ? `(${why})` : '');
        try {
          if (game && game.hud && lvl === 0 && why && why !== 'chosen') {
            game.hud.toast('Graphics eased back to keep it smooth', 'warn');
          }
        } catch (e) { /* cosmetic */ }
      }
    })
    : null;
  if (quality) quality.apply(startLevel, 'boot');
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
    s.__hex = p.color.hex;
    scene.add(s.group);
    s.group.position.set(p.x, heightAt(p.x, p.z), p.z);
    return s;
  });
  world.avatars = avatars;

  /*
   * THE SETTLERS WEAR WHAT THE SCOREBOARD SAYS THEY WEAR.
   *
   *   "The colours of the different players changed from one friend's screen to
   *    the next. The different players should be the same colours from one
   *    device to the other."
   *
   * These are built at boot from `state.players[i].color`, which at boot is the
   * DEFAULT palette by index — blue, red, orange, purple. In a networked match
   * `mirror.js` then renumbers the seats so the local player is index 0 and
   * re-assigns colours by SERVER seat, which is what makes everybody agree...
   * except that the 3D settlers had already been built, in the old colours. So
   * the HUD, the results table and the board map showed one set of colours and
   * the four people running around showed another, differently on each device.
   *
   * The palette is baked into geometry and a painted texture at build time, so
   * the honest fix is to build them again — once, during the load-in pause, and
   * only the ones whose colour actually changed. The array is mutated in place
   * (`world.avatars` is the same array), so every later read picks up the new
   * settler. The one direct reference anything else holds is the player
   * controller's — it reads the impact counter for the camera shake — and it
   * is handed the new object below.
   */
  function recolorAvatars() {
    let changed = 0;
    state.players.forEach((p, i) => {
      const old = avatars[i];
      if (!old || old.__hex === p.color.hex) return;
      try {
        scene.remove(old.group);
        if (typeof old.dispose === 'function') old.dispose();
      } catch (e) { /* it is going away regardless */ }
      const s = settlerM.createSettler(p.color.hex, p.id === 0);
      s.__hex = p.color.hex;
      s.group.position.copy(old.group.position);
      scene.add(s.group);
      avatars[i] = s;
      if (i === 0 && controller && typeof controller.setSettler === 'function') {
        controller.setSettler(s);     // the camera shake reads this one directly
      }
      changed++;
    });
    if (changed) packSig.fill('');    // the carry stacks are new; repaint them

    /*
     * AND EVERYTHING ELSE THAT WEARS A SEAT'S COLOUR.
     *
     * `core/seatcolor.js` reads the live player, so anything drawn from here on
     * is already right. These two are the exceptions, because they were painted
     * BEFORE the server said who was what: the pieces already on the board
     * (none, on the way into a match — but a re-seat can arrive at any time and
     * a rebuild from state is cheap and total), and the island's own tint for
     * "this hex is mine", which lives in a shader uniform rather than being
     * read per frame.
     */
    try { if (structures && structures.syncFromState) structures.syncFromState(); }
    catch (e) { /* colour is cosmetic; the board is not */ }
    const reg = props && props.regions;
    if (reg && typeof reg.retint === 'function') {
      try { reg.retint(); } catch (e) { /* the tint is a nicety */ }
    }
    return changed;
  }

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
  /* Post-match roaming, held in a box rather than on `game` so the controller
     can read it without closing over a binding that does not exist yet.
     matchflow raises it when the review bar goes up — see hud-end.js. */
  const roam = { on: false };
  const controller = ctrlM.createPlayerController(state, avatars[0], gameCamera, input, world,
    { roam: () => roam.on });
  const gathering = gatherM.createGathering(state, world);
  const bots = botM.createBots(state, world);

  // ---------------------------------------------------------------- game api
  const game = {
    state, world, audio, effects, camera: gameCamera, input, avatars,
    economy: ecoM,
    /** Rebuild any settler whose seat colour has changed under it — netmatch.js
     *  calls this once, the moment the server's seat colours land. */
    recolorAvatars,
    /**
     * The gear's Full / Saver switch. A choice by hand PINS the rung: from then
     * on the probes keep measuring and reporting and stop deciding, because a
     * setting that argues with the player is not a setting.
     */
    setLowPower(on) {
      if (!quality) return !!on;
      quality.pin(on ? 1 : 2);
      return quality.level < 2;
    },
    get lowPower() { return !!quality && quality.level < 2; },
    /** Capture-rig hook: the whole ladder, its schedule and its last reading. */
    get quality() { return quality ? quality.info : null; },
    qualityProbe() { if (quality) quality.startProbe(); return !!quality; },
    /** matchflow.setRoam -> the settler may walk a finished island. */
    setRoam(on) { roam.on = !!on; return roam.on; },
    get roaming() { return roam.on; },
    /* Capture-rig hook. The frame loop drives this; a rig that wants to prove
       "a real drag moved the settler" needs to step it on its own clock,
       because a headless page renders at about 1.5fps and the loop with it. */
    controller,
    /** Capture-rig hook: why the last frame did or did not draw. */
    frameInfo() {
      return {
        glLost,
        hidden: !!(typeof document !== 'undefined' && document.hidden),
        sinceDraw: Math.round(performance.now() - lastDraw),
        draws, drawFails, losses,
        level: quality ? quality.level : null,
        lowPower: !!quality && quality.level < 2,
        shadows: !!renderer.shadowMap.enabled,
        checkShaderErrors: !!(renderer.debug && renderer.debug.checkShaderErrors),
        minFrameMs: MIN_FRAME_MS,
        ratio: +renderer.getPixelRatio().toFixed(3)
      };
    },
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
    /*
     * LEAVING MEANS LEAVING.
     *
     *   "When the users go back to the home page, right now for one user it was
     *    glitching and kept trying to reopen the game, and for the other it did
     *    show the same room and the same players again, which it shouldn't —
     *    since if you leave you leave. You have to start again."
     *
     * Both of those are one omission: this reloaded the page and told the SERVER
     * nothing. So the room still had you in it (hence the same room, same
     * players) and the moment the fresh page connected it was sent MATCH_BEGIN
     * for the match you had just walked out of — which the client parks and
     * reloads for. Boot, connect, begin, park, reload, for ever.
     *
     * So the leave goes up the wire first, and the reload waits for it — but
     * only briefly. A player pressing HOME is leaving whether or not the socket
     * agrees, so the request races a short timer and the page goes either way;
     * `netmatch.markLeft` has already written the match id down, and a page that
     * comes back to a MATCH_BEGIN for a match on that list refuses it.
     */
    async leaveMatch() {
      try { if (overview && overview.close) overview.close(); } catch (e) { /* going anyway */ }
      try {
        if (net && net.active && typeof net.leave === 'function') {
          await Promise.race([
            net.leave(),
            new Promise(r => setTimeout(r, 600))
          ]);
        }
      } catch (e) { /* the reload is not conditional on the server hearing */ }
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

  /* ------------------------------------------------------------- keyboard
   *
   *   "Can you also help me update the controls for making it easier to play
   *    without needing to use a mouse or trackpad on desktop."
   *
   * Two pieces, built here because this is the only place that has all of the
   * hud, the map, the sheets and the economy at once:
   *
   *   hotkeys   the in-match letters — build, trade, pause, the Escape ladder
   *   keyNav    the menu cursor, which was created with the opening screen long
   *             before `createInput` existed and needs handing the input layer
   *             so it can take the arrows off the settler while a sheet is up
   *
   * Both are no-ops without a window, so the headless simulator is untouched.
   */
  let hotkeys = null;
  try {
    const keysM = await load('./ui/hotkeys.js', null);
    if (keysM && keysM.createHotkeys) hotkeys = keysM.createHotkeys(state, game);
    const navM = await load('./ui/kbnav.js', null);
    if (navM && navM.keyNav) navM.keyNav().setInput(input);
  } catch (err) {
    if (typeof console !== 'undefined') console.warn('[boot] keyboard —', err.message);
  }
  game.hotkeys = hotkeys;

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

  /* ---------------------------------------------------------------- resize
   *
   *   "Sometimes, definitely after I play the game once and restart to play
   *    again, the whole game is too zoomed in where I can't see all of the
   *    elements on the screen I should be seeing."
   *
   * MEASURE THE CANVAS, NOT THE WINDOW. `setSize(w, h, false)` deliberately
   * does not touch `canvas.style`, so the drawing buffer and the CSS box are
   * two independent numbers — and they were being set from two different
   * sources. The buffer came from `innerWidth/innerHeight`; the box is 100% of
   * `#app`, which is `100dvh` with a `100vh` FALLBACK. On any engine that
   * takes the fallback (older iOS Safari, and most in-app webviews — the
   * Instagram and Discord browsers are how a shared game link usually gets
   * opened) `100vh` is the URL-bar-hidden height, so the element is 60-90px
   * taller than the visible page. The browser then stretches a short buffer to
   * fill a tall box: everything is drawn too big, the camera's aspect is wrong
   * by the same ratio, and the bottom row of the HUD is under the fold. Which
   * is the report, in all three of its parts.
   *
   * `clientWidth/clientHeight` of the canvas is the box being painted into, by
   * definition, so the two cannot disagree again.
   *
   * `--vh` is published for the CSS to use as its own fallback; ui-base.css
   * prefers it over `100vh` for exactly the same reason.
   */
  const vv = globalThis.visualViewport || null;
  const resize = () => {
    // The visual viewport is the only honest answer while a URL bar is
    // sliding or a keyboard is up; innerHeight is the fallback.
    const vh = Math.round((vv && vv.height) || innerHeight || 0);
    if (vh > 0) document.documentElement.style.setProperty('--vh', (vh / 100) + 'px');
    const w = canvas.clientWidth || innerWidth;
    const h = canvas.clientHeight || vh || innerHeight;
    renderer.setPixelRatio(ratioFor(w, h));
    renderer.setSize(w, h, false);
    camera.aspect = w / (h || 1);
    camera.updateProjectionMatrix();
    const gate = document.getElementById('rotate-gate');
    if (gate) gate.classList.toggle('show', h > w * 1.08);
  };
  addEventListener('resize', resize);
  // 300ms rather than 120: iOS reports the old size for longer than that after
  // a rotation, and a resize that lands early is a resize that did nothing.
  addEventListener('orientationchange', () => { setTimeout(resize, 120); setTimeout(resize, 320); });
  /* Chrome Android fires `visualViewport.resize` and NOT `window.resize` when
     the URL bar slides, so without this the renderer keeps a stale size for
     the rest of the session. */
  if (vv) {
    vv.addEventListener('resize', resize);
    vv.addEventListener('scroll', resize);
  }
  resize();

  /* A PAGE SCALE THAT SURVIVED A RELOAD.
   *
   * `game.restart()` and `leaveMatch()` are `location.reload()`, and a reload
   * restores the browser's page scale and scroll offset. So a pinch picked up
   * during one match comes back with the next one — including on the loading
   * screen, which is exactly what "the loading screen is also a bit too zoomed
   * in, it has a white bar at the top" describes: that bar is the browser's own
   * chrome reappearing because the page is no longer at scale 1.
   *
   * `maximum-scale=1,user-scalable=no` has been ignored by iOS Safari since
   * iOS 10 and by Chrome whenever Force-enable-zoom is on, so the meta tag
   * cannot be trusted to prevent it. Scrolling back to the origin is the part
   * that can be fixed from here; index.html blocks the gesture itself. */
  if (vv) {
    const unzoom = () => {
      if (vv.scale > 1.01 || vv.offsetTop > 1 || vv.offsetLeft > 1) {
        try { scrollTo(0, 0); } catch (e) { /* fine */ }
      }
    };
    vv.addEventListener('resize', unzoom);
    vv.addEventListener('scroll', unzoom);
    addEventListener('focusout', () => { try { scrollTo(0, 0); } catch (e) { /* fine */ } });
    unzoom();
  }

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
    /*
     * A RAID YOU WERE NOT IN IS NOT A RAID ON YOU.
     *
     * The horn and the shockwave both used to buzz, unconditionally, for every
     * Knight anybody played anywhere on the island — two buzzes for a card that
     * might have been dropped on a hex the player has never stood on. It is
     * still loud and it still throws a ring across the hex, because those are
     * how a table finds out something happened. The hand is told when the card
     * cost this player something, or when this player played it.
     */
    const mine = (ev.losses || []).find(l => l.player === 0);
    const tookFromMe = ev.player !== 0 && mine && mine.total > 0;
    const isMine = ev.player === 0 || !!tookFromMe;
    structures.setRobber(ev.tile);
    audio.sfx('horn', { mine: isMine });
    effects.shockwave(ev.tile, { mine: isMine });
    state.players.forEach(p => avatars[p.id].setCarry(p.res));
    hud.raid(ev);
    const who = state.players[ev.player];
    if (tookFromMe) {
      audio.sfx('deny', { mine: true });
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
          effects.burst(ev.x, ev.z, ev.resource, { mine: ev.player === 0 });
          props.playHarvest(ev.node);
          if (ev.depleted) props.setDepleted(ev.node, true);
          if (ev.player === 0) { audio.sfx('gain', { mine: true }); hud.pulseResource(ev.resource); }
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
          /* Sound for every build on the island; a buzz for your own only.
             Three rivals plus a draft's worth of placements is a lot of hand. */
          audio.sfx(ev.kind === 'city' ? 'upgrade' : 'build', { mine: ev.player === 0 });
          break;
        case 'trade':     audio.sfx('trade'); break;
        case 'cardDrawn':
          audio.sfx('card');
          /* SAY WHICH CARD, WHERE IT CAN BE SEEN.
           *
           *   "When the map is open, if I buy a card the animation for the card
           *    I receive should show up in front of the map. Right now I can't
           *    tell what card I bought."
           *
           * Two halves. There was no reveal at all — a card purchase played a
           * sound and nothing else, so with the placement map up the only
           * evidence was a number in a chip behind it. And the notice layer is
           * built with the HUD, which paints UNDER the map and the sheets, so
           * even once there was something to show it would have shown behind
           * them; `.announce` is lifted in ui-hud.css for exactly this. */
          if (ev.player === 0) {
            hud.announce(CARD_LABEL[ev.card] || 'Development Card',
              state.players[0].color.light,
              ev.card === 'knight' ? 'knight'
                : (ev.card === 'roadBuilding' ? 'road' : 'trophy'));
          }
          // A Victory Point card scores as it is drawn, so this is how the flow
          // knows the last point came off a card and holds the celebration for
          // a beat to say so. See WIN_CARD_BEAT in matchflow.js.
          if (flow && flow.noteCard) flow.noteCard(ev.player, ev.card);
          break;
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
          audio.sfx('award', { mine: ev.player === 0 });
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
          /*
           * TWO DIFFERENT REFUSALS, AND ONLY ONE OF THEM IS AN EVENT.
           *
           *   "Remove the haptic feedback throughout the game that happens
           *    every few seconds when I'm on a hex that isn't mine."
           *
           * `noteBlocked` in rules.js fires for both reasons it can refuse you,
           * and this handled them as one: the same warning toast and the same
           * `mine: true`, which is what audio.js gates a buzz on. So walking
           * across somebody else's land — the most ordinary thing there is on
           * a shared island, and the thing you do for most of a match — put a
           * buzz in the hand every two and a half seconds, and told you a
           * Knight was doing it when no Knight was anywhere near.
           *
           * A KNIGHT is an event: somebody aimed a card at a hex you work and
           * you have just felt it. That keeps the buzz and the warning.
           *
           * UNOWNED is not an event, it is the map. You are standing somewhere
           * you never had a claim to, nothing has changed, and there is nothing
           * to act on except walking off. It keeps the small refusal SOUND,
           * because a pickup that silently does not happen is worse, and it
           * loses the buzz and the warning colour. The words are now true as
           * well, which they were not before.
           */
          if (ev.reason === 'knight') {
            hud.toast('The Knight blocks this region', 'warn');
            audio.sfx('deny', { mine: true });
          } else {
            hud.toast('You have not settled this hex');
            audio.sfx('deny');
          }
          break;
        case 'victory':
          audio.music('victory');
          panels.showResults(ev.player);
          gameCamera.celebrate(state.players[ev.player]);
          avatars[ev.player].celebrate();
          break;
        case 'setupComplete':
          hud.onPlayBegan();
          // The scene is only now everything a match contains, which is the
          // one moment worth measuring. See PLAY_PROBE_SEC in quality.js.
          if (quality && typeof quality.matchBegan === 'function') quality.matchBegan();
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

  /* 60Hz is the simulation rate and the art was authored for it; a 120Hz panel
     rendering the same 60 states twice is double the GPU bill for nothing. The
     slack is deliberate — 15ms rather than 16.7 — so a display running at
     exactly 60 never has a frame land a hair early and get thrown away. */
  /* The base cap. `systems/quality.js` can lower it further — the bottom rung
     draws at 30, which halves the GPU bill outright and, in a game about
     walking around an island, changes nothing else. */
  const MIN_FRAME_MS = 15;
  /** ~22fps, for when a full-screen modal means nobody can see the scene.
   *  High enough that the map's hover pulse and the sea visible past the
   *  frame margins still read as moving; low enough to matter to a battery. */
  const MODAL_FRAME_MS = 45;
  let lastDraw = 0;
  /** Wall time banked by rAF callbacks that were gated out before drawing, so
   *  the decorative updates below still advance at true speed. */
  let visAcc = 0;

  /* Context loss, handled rather than watched. three.js already prevents the
     default (which is what makes a restore possible at all) and re-initialises
     itself on the way back; what it cannot know is that this page should stop
     stepping a match nobody can see, and should not try to draw into a context
     that is gone. Both of those are here. */
  let glLost = false;
  let draws = 0, drawFails = 0, losses = 0;
  /** Last pack seen per player, so the carry stack can follow it exactly. */
  const packSig = state.players.map(() => '');
  canvas.addEventListener('webglcontextlost', () => {
    glLost = true;
    losses++;
    console.warn('[gl] context lost — pausing until it comes back');
    /* THE FIRST LOSS IS THE MACHINE TELLING US. A browser only takes this away
       when it is short of memory, so asking for the same amount again is asking
       for the same answer: down to the bottom rung, remembered across reloads
       (quality.js writes it), and no climbing again this session. */
    if (quality) quality.loss();
  }, false);
  canvas.addEventListener('webglcontextrestored', () => {
    glLost = false;
    lastDraw = 0;
    last = performance.now();          // do not step a second of frozen time
    /*
     * AND THIS IS THE LINE THAT STOPS THE FLICKER BEING FOREVER.
     *
     * three's shader-error check runs `gl.getProgramInfoLog(program).trim()`,
     * and a driver is entirely within its rights to return null there. On a
     * freshly restored context SwiftShader does exactly that, so the FIRST
     * frame back throws inside the shadow-map pass, the frame is abandoned
     * mid-render, and the context is lost again a moment later. Lost, restored,
     * thrown, lost — which is what a screen "flashing black multiple times a
     * second" actually is, rather than a slow frame.
     *
     * The check stays on for the whole normal life of the page, which is what
     * `testmatch` check 1 reads to know no shader is broken (this build DOES
     * hand-write shader code: island.js and regions.js carry ShaderMaterials
     * and props.js and mktkit.js inject into stock materials through
     * onBeforeCompile). It is turned off here, and only here, because from this
     * point the alternative is not "an error we might miss" — it is a page that
     * cannot draw at all.
     */
    if (renderer.debug) renderer.debug.checkShaderErrors = false;
    drawFails = 0;
    resize();
    console.warn('[gl] context restored');
  }, false);

  function frame(now) {
    requestAnimationFrame(frame);

    /* Nothing to draw into, or nobody looking. `document.hidden` covers the
       occluded-but-animating case a background tab can still be in; rAF alone
       does not always stop. Time is re-based on the way back so the match does
       not fast-forward through however long the tab was away. */
    if (glLost || (typeof document !== 'undefined' && document.hidden)) {
      last = now;
      return;
    }

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
    /* AND THE RULES SHEET IS THE THIRD ONE.
     *
     *   "It should be a larger popup in the middle of the screen, where the
     *    game technically pauses in the background (but without the map showing
     *    up) ... and also obvious that the game is paused in the background."
     *
     * PAUSE has always been the board map with `keepOpen` — the map IS the
     * freeze, because `overview.isOpen` is what this line reads. The rules
     * sheet wants the same stop without the island behind it, so it gets its
     * own term rather than borrowing the map's. Offline only, like the other
     * two: three other people cannot be frozen because one of them opened the
     * rules, and `ui/hud-help.js` says so on its own badge when it is online. */
    const helpPaused = !online && !!(hud && hud.helpOpen && state.phase === 'play');
    const mapPaused = !online
      && (!!(overview && overview.isOpen) || sheetPaused || helpPaused);

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

    /*
     * THE STACK ABOVE YOUR HEAD, THE INSTANT THE PACK CHANGES.
     *
     *   "When I purchase or trade something, the count of the items right above
     *    my head takes a few seconds to refresh, which gives me an incorrect
     *    idea of how many resources I actually have and is really confusing. I
     *    need that to update the instant a trade or purchase happens. Or a
     *    Knight."
     *
     * It was driven by EVENTS — 'gained' and the Knight — so a trade, a
     * purchase, a card and every road ever built left it showing the pack from
     * before, until the next thing picked up off the ground happened to refresh
     * it. And online there are no local events at all: resources arrive inside
     * a snapshot, so the stack was stale by design over the wire.
     *
     * A signature of the pack, compared every frame. Four small string
     * comparisons for something that is never wrong again, and `setCarry` is
     * only called when the numbers actually moved.
     */
    for (const p of state.players) {
      const sig = `${p.res.wood}|${p.res.brick}|${p.res.wool}|${p.res.wheat}|${p.res.ore}`;
      if (packSig[p.id] !== sig) {
        packSig[p.id] = sig;
        avatars[p.id].setCarry(p.res);
      }
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
    // `hud.helpOpen` is in the "nothing else is in the way" list for the same
    // reason the sheets are: it is a full-screen modal that stops the match, and
    // this reconciler runs OUTSIDE the fixed-step loop `helpPaused` short-
    // circuits — so without it the placement map came up behind the rules sheet,
    // every frame, for as long as somebody read them.
    /*
     * AN OPEN MAP IS RE-AIMED HERE TOO, BUT NOT ONE ALREADY AIMED.
     *
     *   "If I already have the map open and I buy a card, I shouldn't have to
     *    exit the map for the map to open back up to build my free two roads."
     *
     * `!overview.isOpen` was the other half of that: the card's own cue would
     * hand the debt over and this reconciler would then sit on its hands until
     * the board was closed. It now offers the map whenever the open one is
     * showing something ELSE — the four build chips live inside the map, so the
     * map the player is standing in is usually the one they bought the card
     * from.
     *
     * The mode test is not a nicety, it is what stops a loop: this runs every
     * frame, and `overview.open` clears the current selection each time it
     * re-dresses, so re-offering a placement map that is ALREADY the free-road
     * placement would wipe the player's first tap sixty times a second and no
     * road could ever be confirmed. Once the re-aim has happened the mode is
     * `place-road` and this stands down, which is exactly the intent.
     */
    if (ecoM && ecoM.placeFreeRoads && state.phase === 'play' &&
        (state.players[0].freeRoads | 0) > 0 &&
        !(overview.isOpen && overview.mode === 'place-road') &&
        !(panels.kind) && !hud.helpOpen &&
        !(flow.stage && flow.stage !== 'play')) {
      ecoM.placeFreeRoads(game);
    }

    /* ============================================ THE FRAME GATE, MOVED UP
     *
     * This used to sit BELOW the block of visual updates, and the comment
     * proudly explained that it "only skips the DRAW". That was the bug. On a
     * 120Hz Android panel — which is most Android sold since about 2021 — rAF
     * fires 120 times a second, so every line below ran 120 times a second to
     * feed a renderer that drew 60. Twice the cloud matrices, twice the boat
     * matrices, twice the sheep, twice the villagers, twice the dock crews,
     * twice the full-screen board-map repaint, for frames nobody ever saw.
     *
     * The fixed-step simulation above is untouched: it runs off its own
     * accumulator and must keep doing so. What moves is the decorative half.
     * `visAcc` banks the wall time the skipped callbacks represent so the
     * animations below still advance at the right speed — they get one larger
     * dt instead of two small ones, which is the same distance travelled.
     *
     * AND A HARD CAP WHILE A MODAL IS UP. The board map, PAUSE, the trade and
     * card sheets and the rules are all full-screen: they cover the 3D almost
     * entirely, and the map additionally repaints its own canvas at up to
     * twice the pixel ratio of the scene behind it. Rendering both at 60Hz so
     * that a player who paused and put the phone down can not see either one
     * is the single most expensive thing this game does with a battery.
     *
     * THE INTERFACE IS NOT DECORATION AND STAYS ABOVE THE GATE.
     *
     * The first version of this moved `hud`, `overview` and `panels` below it
     * too, and testmatch went from 19/19 to 16/19 — the board map, road
     * legality and yield checks all failed. The reason is worth writing down:
     * putting them under the gate ties how fast the interface responds to how
     * fast the machine can draw, so on a device that is struggling the menus
     * get sluggish exactly when the player is most likely to be prodding them.
     * Under SwiftShader at 3fps that is the difference between a working game
     * and a broken one, and a cheap phone is the same problem in slower
     * motion. They are cheap anyway — each already throttles its own DOM work
     * internally to 10Hz, 5Hz and 4Hz. */
    hud.update(dt);
    overview.update(dt);
    panels.update(dt);

    visAcc += dt;
    const modalUp = !!((overview && overview.isOpen) || (panels && panels.isOpen)
      || (hud && hud.helpOpen));
    const capMs = modalUp
      ? MODAL_FRAME_MS
      : (quality ? quality.frameMs : MIN_FRAME_MS);
    if (now - lastDraw < capMs) return;
    // Clamped for the same reason the simulation clamps: coming back from a
    // long stall must not teleport every animation at once.
    const vdt = Math.min(visAcc, 0.1);
    visAcc = 0;

    if (quality) quality.update(vdt);
    props.update(vdt);
    structures.update(vdt);
    market.update(vdt);
    portsView.update(vdt);
    water.update(now / 1000);
    island.update(vdt, camera);
    effects.update(vdt);
    gameCamera.update(vdt, state, overview.isOpen);
    sky.update(now / 1000);

    if (quality) quality.frame(now);      // one subtraction; nothing is drawn
    lastDraw = now;
    draws++;
    /*
     * A DRAW THAT THROWS MUST NOT TAKE THE LOOP WITH IT.
     *
     * A GL context that has just come back can still refuse a frame — a driver
     * returning null where three expects a string, a resource that has not
     * finished re-uploading. Left alone that throws out of the rAF callback on
     * every frame forever, which is a black screen with a console full of the
     * same line. Caught, it costs one frame and the next one usually works.
     *
     * Three in a row means the context is not really back, so we stand down and
     * wait for the browser to tell us it is — `webglcontextrestored` clears
     * this. There is no state to lose: the match is still in memory, and the
     * moment a frame succeeds the island is exactly where it was.
     */
    try {
      renderer.render(scene, camera);
      drawFails = 0;
    } catch (e) {
      drawFails++;
      if (drawFails <= 2) console.error('[gl] draw failed —', e && e.message);
      if (drawFails >= 3) {
        glLost = true;
        console.error('[gl] three failed draws — waiting for a fresh context');
      }
    }
  }
  requestAnimationFrame(frame);

  /* First touch unlocks WebAudio on mobile.
   *
   * The ocean is no longer started unconditionally here: it is one of three
   * switches the player owns now (see `core/options.js`), and this line ran
   * after the HUD had already applied their choice — so a player who had
   * turned the ocean off got it back the first time they touched the screen.
   * The import is dynamic because everything else on this path is, and a
   * failure to read an option must not cost the game its audio unlock. */
  const unlock = () => {
    audio.unlock();
    import('./core/options.js')
      .then(opt => audio.ambience(opt.oceanOn ? opt.oceanOn() : true))
      .catch(() => audio.ambience(true));
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
