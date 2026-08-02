/**
 * Headless-Chrome plumbing, shared by the trace rigs.
 *
 *   const cdp = await openChrome({ w, h, port, shot, out });
 *   await cdp.ev('1+1');            // -> 2
 *   await cdp.shot('name');         // progress/shots/name.png, when `shot`
 *   cdp.done(0);                    // close the socket, kill Chrome, exit
 *
 * Lifted out of tools/flowtrace.mjs verbatim when that file crossed the 900-line
 * budget. Nothing here knows anything about Island Settlers: it launches
 * chrome-headless-shell on SwiftShader, opens the DevTools socket, waits for the
 * game to publish `window.__ISLAND__`, and hands back four functions.
 *
 * `ev()` returns `{ __err }` rather than throwing, so a trace that pokes at
 * something missing prints a readable line instead of unwinding the rig.
 */

import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

export const sleep = ms => new Promise(r => setTimeout(r, ms));

/** `--key=value` off the command line. */
export const arg = (k, d) => {
  const hit = process.argv.find(a => a.startsWith(`--${k}=`));
  return hit ? hit.split('=').slice(1).join('=') : d;
};

export async function openChrome(opts = {}) {
  const W = opts.w || 960;
  const H = opts.h || 444;
  const PORT = opts.port || 5173;
  const SHOT = !!opts.shot;
  const OUT = resolve(ROOT, opts.out || 'progress/shots');
  const CHROME = opts.chrome || '/tmp/chrome-headless-shell-linux64/chrome-headless-shell';
  const LIBS = opts.libs || '/tmp/xlibs/root/usr/lib/x86_64-linux-gnu';
  const BOOT = opts.boot === undefined
    ? '!!(window.__ISLAND__&&window.__ISLAND__.state)' : opts.boot;

  mkdirSync(OUT, { recursive: true });
  if (!existsSync(CHROME)) { console.error(`no chrome at ${CHROME}`); process.exit(2); }

  const DP = 9600 + Math.floor(Math.random() * 700);
  const chrome = spawn(CHROME, [
    '--headless', '--no-sandbox', '--disable-dev-shm-usage',
    '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    '--disable-new-content-rendering-timeout', '--hide-scrollbars', '--mute-audio',
    `--window-size=${W},${H}`, `--remote-debugging-port=${DP}`, 'about:blank'
  ], {
    env: { ...process.env, LD_LIBRARY_PATH: `${LIBS}:${process.env.LD_LIBRARY_PATH || ''}` },
    stdio: ['ignore', 'ignore', 'pipe']
  });
  let chromeErr = '';
  chrome.stderr.on('data', d => { chromeErr += d.toString(); });

  let wsUrl;
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${DP}/json/list`);
      const p = (await r.json()).find(t => t.type === 'page');
      if (p) { wsUrl = p.webSocketDebuggerUrl; break; }
    } catch { /* not up */ }
    await sleep(150);
  }
  if (!wsUrl) { console.error('devtools never came up\n' + chromeErr.slice(-500)); process.exit(2); }

  const ws = new WebSocket(wsUrl);
  await new Promise(r => ws.addEventListener('open', r, { once: true }));

  let msgId = 0;
  const pending = new Map();
  const exceptions = [];
  ws.addEventListener('message', e => {
    const m = JSON.parse(e.data);
    if (m.id !== undefined) {
      const p = pending.get(m.id);
      if (p) { pending.delete(m.id); p(m.result || { __err: m.error }); }
      return;
    }
    if (m.method === 'Runtime.exceptionThrown') {
      exceptions.push(m.params.exceptionDetails.exception?.description
        || m.params.exceptionDetails.text);
    }
  });

  const send = (method, params = {}, ms = 25000) => new Promise(res => {
    const id = ++msgId;
    pending.set(id, res);
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); res({ __err: 'timeout' }); } }, ms);
  });

  const ev = async (expr, awaitPromise = false) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise });
    if (r?.exceptionDetails) {
      return { __err: r.exceptionDetails.exception?.description || r.exceptionDetails.text };
    }
    return r?.result?.value;
  };

  const T0 = Date.now();
  const elapsed = () => ((Date.now() - T0) / 1000).toFixed(1) + 's';

  const shot = async name => {
    if (!SHOT) return;
    console.log(`  [${elapsed()}] capturing ${name}...`);
    const r = await send('Page.captureScreenshot', { format: 'png' }, 60000);
    if (!r?.data) { console.log(`  shot ${name} FAILED`); return; }
    writeFileSync(resolve(OUT, `${name}.png`), Buffer.from(r.data, 'base64'));
    console.log(`  [${elapsed()}] shot ${name}.png`);
  };

  const done = (code = 0) => { ws.close(); chrome.kill('SIGKILL'); process.exit(code); };

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/index.html` });

  if (BOOT) {
    let booted = false;
    for (let i = 0; i < 120; i++) {
      if (await ev(BOOT) === true) { booted = true; break; }
      await sleep(120);
    }
    if (!booted) { console.error('GAME DID NOT BOOT'); done(1); }
  }

  return { send, ev, shot, done, exceptions, elapsed, W, H, PORT, SHOT, OUT };
}

export default openChrome;
