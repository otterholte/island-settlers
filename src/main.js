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

  const state = createMatch({ seed: (Math.random() * 1e9) | 0 });

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
    openOverview(mode, opts) { overview.open(mode, opts); },
    closeOverview() { overview.close(); },
    openTrade(portId) { panels.openTrade(portId ?? null); },
    openCards() { panels.openCards(); },
    restart() { location.reload(); },
    toast(msg, kind) { hud.toast(msg, kind); }
  };

  const hud = hudM.createHUD(uiRoot, state, game);
  const overview = overM.createOverview(uiRoot, state, game);
  const panels = panelM.createPanels(uiRoot, state, game);
  game.hud = hud; game.overview = overview; game.panels = panels;

  const flow = flowM.createMatchFlow(state, game);
  game.flow = flow;
  if (ecoM && ecoM.attach) ecoM.attach(game);

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

  function handleEvents() {
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
        case 'knight':
          structures.setRobber(ev.tile);
          audio.sfx('horn');
          hud.announce(`${state.players[ev.player].name} sent the Raider!`,
                       state.players[ev.player].color.css);
          effects.shockwave(ev.tile);
          state.players.forEach(p => avatars[p.id].setCarry(p.res));
          break;
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
          hud.toast('The Raider blocks this region', 'warn');
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
    while (acc >= FIXED && steps++ < 4) {
      acc -= FIXED;
      tickWorld(state, FIXED);
      flow.update(FIXED);
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
