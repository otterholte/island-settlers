/**
 * Zero-dependency static server for Island Settlers.
 *
 *   node serve.mjs [port]
 *
 * The game is plain ES modules, so it has to come over HTTP with correct MIME
 * types — opening index.html from the filesystem will not work. Nothing to
 * install; this uses only the node standard library.
 */

import { createServer } from 'node:http';
import { createReadStream, statSync, existsSync } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { networkInterfaces } from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)));
const PORT = Number(process.argv[2]) || 5173;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'text/javascript; charset=utf-8',
  '.mjs':  'text/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2'
};

const server = createServer((req, res) => {
  let urlPath;
  try {
    urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  } catch {
    res.writeHead(400).end('Bad request');
    return;
  }

  if (urlPath === '/' || urlPath === '') urlPath = '/index.html';

  // Keep the served tree inside ROOT.
  const target = join(ROOT, normalize(urlPath).replace(/^(\.\.[/\\])+/, ''));
  if (!target.startsWith(ROOT + sep) && target !== ROOT) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  if (!existsSync(target) || !statSync(target).isFile()) {
    res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found: ' + urlPath);
    return;
  }

  res.writeHead(200, {
    'content-type': TYPES[extname(target).toLowerCase()] || 'application/octet-stream',
    'cache-control': 'no-cache'
  });
  createReadStream(target).pipe(res);
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`\n  Port ${PORT} is already in use. Try:  node serve.mjs 5174\n`);
  } else {
    console.error(e.message);
  }
  process.exit(1);
});

server.listen(PORT, '0.0.0.0', () => {
  const lan = Object.values(networkInterfaces()).flat()
    .filter(n => n && n.family === 'IPv4' && !n.internal)
    .map(n => n.address);

  console.log('\n  Island Settlers is running.\n');
  console.log(`    On this computer:  http://localhost:${PORT}`);
  for (const ip of lan) console.log(`    On your phone:     http://${ip}:${PORT}`);
  console.log('\n  Turn the phone landscape. Ctrl+C to stop.\n');
});
