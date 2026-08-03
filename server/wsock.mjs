/**
 * Island Settlers — a websocket server in one file, with no dependencies.
 *
 *   attachWebSocket(httpServer, { path, onConnection }) -> { close(), sockets }
 *
 * RFC 6455, server side, text frames, ping/pong and close. That is all this
 * game needs and all this file implements.
 *
 * WHY NOT `ws`
 * ------------
 * The whole build is deliberately dependency-free — the client vendors three.js
 * as a single file, there is no bundler, no package.json to install from and no
 * node_modules anywhere. A server that needs `npm i` to start would be the only
 * part of the project you could not run by cloning it. The protocol is a
 * handshake, a four-byte XOR and a length prefix; that is a smaller surface
 * than the dependency would be.
 *
 * WHAT IS DELIBERATELY MISSING
 * ----------------------------
 *   permessage-deflate  — we never negotiate it, so we never have to speak it.
 *                         Our frames are small JSON; compression would cost
 *                         more CPU per match than it saves bytes.
 *   binary frames       — everything is JSON text. Opcode 2 is rejected.
 *   client mode         — this only ever accepts, never dials.
 *
 * WHAT IS NOT MISSING, BECAUSE LEAVING IT OUT BREAKS THINGS
 * ---------------------------------------------------------
 *   fragmentation    a peer may split one message over many frames, and a
 *                    browser will do exactly that above a few dozen KB.
 *   TCP reassembly   a frame is not a packet. `data` fires on whatever the
 *                    kernel had, which is regularly half a header. Everything
 *                    goes through one growable buffer and a parser that only
 *                    consumes what is complete.
 *   masking          every client->server frame is masked and MUST be
 *                    rejected if it is not. Server->client frames must not be.
 *   backpressure     a socket that stops draining must not become an
 *                    unbounded queue in our heap. Past HIGH_WATER we drop the
 *                    connection rather than the server.
 *
 * Owner: net agent.
 */

import { createHash, randomBytes } from 'node:crypto';

/** The magic string from RFC 6455 §1.3. It is not a secret and not a salt;
 *  it exists so a naive HTTP proxy cannot be tricked into completing a
 *  handshake it does not understand. */
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

const OP = {
  CONT: 0x0, TEXT: 0x1, BINARY: 0x2,
  CLOSE: 0x8, PING: 0x9, PONG: 0xa
};

/** A single message may not exceed this. Ours are a few KB; a megabyte is
 *  four hundred times the biggest thing we ever send and still small enough
 *  that a hostile peer cannot use it to exhaust memory. */
const MAX_MESSAGE = 1 << 20;
/** Unwritten bytes we tolerate before deciding the peer is not reading. */
const HIGH_WATER = 1 << 22;

export const CLOSE = {
  NORMAL: 1000, GOING_AWAY: 1001, PROTOCOL: 1002, UNSUPPORTED: 1003,
  TOO_BIG: 1009, INTERNAL: 1011
};

/* ==================================================================== frames */

/**
 * Build a server frame. Server frames are never masked (RFC 6455 §5.1), which
 * is the one asymmetry in the whole protocol.
 */
function frame(opcode, payload) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload || '', 'utf8');
  const len = body.length;
  let header;
  if (len < 126) {
    header = Buffer.allocUnsafe(2);
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.allocUnsafe(4);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.allocUnsafe(10);
    header[1] = 127;
    // Two 32-bit halves: Node has no writeUInt64BE and our lengths never
    // approach 2^53 anyway, so the high word is written from the float.
    header.writeUInt32BE(Math.floor(len / 4294967296), 2);
    header.writeUInt32BE(len >>> 0, 6);
  }
  header[0] = 0x80 | opcode;    // FIN set: we never fragment our own output
  return Buffer.concat([header, body]);
}

/**
 * Try to read one frame off the front of `buf`.
 *
 * Returns null when the buffer does not yet hold a whole frame — that is the
 * normal case, not an error, and the caller simply waits for more bytes.
 * Returns { fin, opcode, payload, size } on success, where `size` is how much
 * of `buf` was consumed. Throws only on a protocol violation.
 */
function readFrame(buf) {
  if (buf.length < 2) return null;
  const b0 = buf[0], b1 = buf[1];
  const fin = (b0 & 0x80) !== 0;
  const rsv = b0 & 0x70;
  const opcode = b0 & 0x0f;
  const masked = (b1 & 0x80) !== 0;
  let len = b1 & 0x7f;
  let off = 2;

  // We never negotiate an extension, so any reserved bit set is a peer
  // speaking something we did not agree to.
  if (rsv !== 0) throw protoError('reserved bits set');
  // Every frame from a client must be masked. An unmasked one is either a
  // broken client or something pretending to be one.
  if (!masked) throw protoError('client frame not masked');

  if (len === 126) {
    if (buf.length < off + 2) return null;
    len = buf.readUInt16BE(off);
    off += 2;
  } else if (len === 127) {
    if (buf.length < off + 8) return null;
    const hi = buf.readUInt32BE(off);
    const lo = buf.readUInt32BE(off + 4);
    if (hi !== 0) throw tooBig();
    len = lo;
    off += 8;
  }
  if (len > MAX_MESSAGE) throw tooBig();

  // Control frames carry their meaning in the header and may never be split.
  if (opcode >= 0x8) {
    if (!fin) throw protoError('fragmented control frame');
    if (len > 125) throw protoError('oversized control frame');
  }

  if (buf.length < off + 4 + len) return null;
  const mask = buf.subarray(off, off + 4);
  off += 4;
  const payload = Buffer.allocUnsafe(len);
  buf.copy(payload, 0, off, off + len);
  for (let i = 0; i < len; i++) payload[i] ^= mask[i & 3];
  return { fin, opcode, payload, size: off + len };
}

function protoError(msg) {
  const e = new Error(msg);
  e.wsCode = CLOSE.PROTOCOL;
  return e;
}

function tooBig() {
  const e = new Error('message too large');
  e.wsCode = CLOSE.TOO_BIG;
  return e;
}

/* ================================================================== the peer */

/**
 * One connected client.
 *
 * The surface is deliberately tiny and event-shaped so the rest of the server
 * never has to know a frame exists: `send(obj)`, `close()`, `onMessage`,
 * `onClose`, plus a `data` bag the hub hangs session state on.
 */
class Peer {
  constructor(socket, req) {
    this.socket = socket;
    this.id = randomBytes(9).toString('base64url');
    this.remote = pickRemote(req, socket);
    this.alive = true;
    this.closed = false;
    this.data = {};             // whatever the hub wants to remember
    this.onMessage = null;
    this.onClose = null;
    /** Transport-owned close hook; see destroy(). The application uses
     *  `onClose` and never touches this. */
    this._gone = null;
    this.lastSeen = Date.now();

    this._buf = Buffer.alloc(0);
    this._frag = null;          // { opcode, chunks[], len }
  }

  /** Send an object as one JSON text frame. Never throws: a dead socket is a
   *  normal outcome and every call site would otherwise need a try. */
  send(obj) {
    if (this.closed || !this.socket.writable) return false;
    let text;
    try {
      text = typeof obj === 'string' ? obj : JSON.stringify(obj);
    } catch (e) {
      return false;
    }
    return this._raw(frame(OP.TEXT, text));
  }

  _raw(buf) {
    if (this.closed || !this.socket.writable) return false;
    // Backpressure. If the peer has stopped reading, the kernel buffer fills,
    // then Node's does, and the only thing left to grow is our heap. A player
    // whose connection has gone this wrong is already unplayable.
    if (this.socket.writableLength > HIGH_WATER) {
      this.destroy(CLOSE.GOING_AWAY, 'not draining');
      return false;
    }
    try {
      this.socket.write(buf);
      return true;
    } catch (e) {
      this.destroy(CLOSE.INTERNAL, 'write failed');
      return false;
    }
  }

  ping() {
    this._raw(frame(OP.PING, Buffer.alloc(0)));
  }

  /** Polite close: send a close frame, then hang up shortly after. */
  close(code = CLOSE.NORMAL, reason = '') {
    if (this.closed) return;
    const body = Buffer.allocUnsafe(2 + Buffer.byteLength(reason));
    body.writeUInt16BE(code, 0);
    body.write(reason, 2);
    this._raw(frame(OP.CLOSE, body));
    // Give the frame a beat to leave before the socket goes. If the peer
    // closes first, `end` fires and this timer is harmless.
    setTimeout(() => this.destroy(code, reason), 60).unref?.();
  }

  destroy(code = CLOSE.NORMAL, reason = '') {
    if (this.closed) return;
    this.closed = true;
    this.alive = false;
    try { this.socket.destroy(); } catch (e) { /* already gone */ }
    // Housekeeping first and always — `_gone` is the transport's own hook and
    // belongs to attachWebSocket, so the peer leaves the live set even if the
    // application's handler throws on its way out.
    if (this._gone) { try { this._gone(code, reason); } catch (e) { logErr('_gone', e); } }
    const fn = this.onClose;
    this.onClose = null;
    if (fn) { try { fn(code, reason); } catch (e) { logErr('onClose', e); } }
  }

  /** Feed bytes in; whole messages come out through onMessage. */
  _feed(chunk) {
    this.lastSeen = Date.now();
    this._buf = this._buf.length ? Buffer.concat([this._buf, chunk]) : chunk;
    for (;;) {
      let f;
      try {
        f = readFrame(this._buf);
      } catch (e) {
        this.close(e.wsCode || CLOSE.PROTOCOL, e.message);
        return;
      }
      if (!f) return;
      this._buf = this._buf.subarray(f.size);
      try {
        this._frameIn(f);
      } catch (e) {
        this.close(e.wsCode || CLOSE.PROTOCOL, e.message);
        return;
      }
      if (this.closed) return;
    }
  }

  _frameIn(f) {
    switch (f.opcode) {
      case OP.PING:
        this._raw(frame(OP.PONG, f.payload));
        return;
      case OP.PONG:
        this.alive = true;
        return;
      case OP.CLOSE: {
        const code = f.payload.length >= 2 ? f.payload.readUInt16BE(0) : CLOSE.NORMAL;
        this.destroy(code, 'peer closed');
        return;
      }
      case OP.BINARY:
        throw protoError('binary frames are not accepted');
      case OP.TEXT:
      case OP.CONT:
        break;
      default:
        throw protoError(`unknown opcode ${f.opcode}`);
    }

    if (f.opcode === OP.TEXT) {
      if (this._frag) throw protoError('new message inside a fragment');
      if (f.fin) return this._deliver(f.payload);
      this._frag = { chunks: [f.payload], len: f.payload.length };
      return;
    }

    // CONT
    if (!this._frag) throw protoError('continuation with nothing to continue');
    this._frag.len += f.payload.length;
    if (this._frag.len > MAX_MESSAGE) throw tooBig();
    this._frag.chunks.push(f.payload);
    if (!f.fin) return;
    const whole = Buffer.concat(this._frag.chunks, this._frag.len);
    this._frag = null;
    this._deliver(whole);
  }

  _deliver(payload) {
    if (!this.onMessage) return;
    let msg;
    try {
      msg = JSON.parse(payload.toString('utf8'));
    } catch (e) {
      // A single unparseable frame is not worth dropping a match over.
      return;
    }
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return;
    try {
      this.onMessage(msg);
    } catch (e) {
      logErr('onMessage', e);
    }
  }
}

function pickRemote(req, socket) {
  // Fly, and every other proxy, terminates TLS in front of us. The socket's
  // own address is then the proxy's, so the forwarded header is the only way
  // to rate-limit by who is actually calling. Only the FIRST hop is trusted —
  // the rest of that header is whatever the client felt like claiming.
  const fwd = req.headers['fly-client-ip']
    || (req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return fwd || socket.remoteAddress || '?';
}

function logErr(where, e) {
  console.error(`[ws] ${where}:`, e && e.stack ? e.stack : e);
}

/* ================================================================== attach */

/**
 * Take over the upgrade path of an existing http server.
 *
 * `onConnection(peer)` is called once per accepted client. Set `peer.onMessage`
 * and `peer.onClose` from inside it.
 */
export function attachWebSocket(server, opts = {}) {
  const path = opts.path || '/ws';
  const onConnection = typeof opts.onConnection === 'function' ? opts.onConnection : null;
  const sockets = new Set();
  let stopped = false;

  server.on('upgrade', (req, socket, head) => {
    if (stopped) return refuse(socket, 503, 'Shutting down');

    const url = (req.url || '/').split('?')[0];
    if (url !== path) return refuse(socket, 404, 'No websocket here');

    const key = req.headers['sec-websocket-key'];
    const upgrade = String(req.headers.upgrade || '').toLowerCase();
    const version = String(req.headers['sec-websocket-version'] || '');
    if (upgrade !== 'websocket' || !key) return refuse(socket, 400, 'Bad upgrade');
    if (version !== '13') {
      return refuse(socket, 426, 'Unsupported websocket version',
        ['Sec-WebSocket-Version: 13']);
    }

    const accept = createHash('sha1').update(key + GUID).digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n` +
      '\r\n'
    );

    // Nagle would hold a 40-byte input frame back waiting for company. Every
    // millisecond of that lands on somebody's settler.
    socket.setNoDelay(true);
    socket.setTimeout(0);

    const peer = new Peer(socket, req);
    peer._gone = () => sockets.delete(peer);
    sockets.add(peer);

    socket.on('data', c => peer._feed(c));
    socket.on('error', () => peer.destroy(CLOSE.INTERNAL, 'socket error'));
    socket.on('close', () => peer.destroy(CLOSE.NORMAL, 'socket closed'));
    socket.on('end', () => peer.destroy(CLOSE.NORMAL, 'socket ended'));

    // Hand the peer over BEFORE feeding it anything. A handshake can arrive in
    // the same TCP segment as the first frame, and feeding first would deliver
    // a message to an onMessage nobody has set yet.
    if (onConnection) {
      try { onConnection(peer); } catch (e) { logErr('onConnection', e); peer.destroy(); }
    }
    if (head && head.length && !peer.closed) peer._feed(head);
  });

  /* Keepalive. Anything behind a load balancer gets its idle connections cut
     somewhere around a minute, and a browser tab that has been suspended looks
     exactly like a dead one until you poke it. A ping every HEARTBEAT does
     both jobs: it keeps the path warm and it is the only reliable way to find
     out that a peer stopped existing without saying so. */
  const beat = setInterval(() => {
    const now = Date.now();
    for (const peer of sockets) {
      if (peer.closed) { sockets.delete(peer); continue; }
      if (now - peer.lastSeen > (opts.deadMs || 60000)) {
        peer.destroy(CLOSE.GOING_AWAY, 'timed out');
        continue;
      }
      peer.ping();
    }
  }, opts.heartbeatMs || 25000);
  beat.unref?.();

  return {
    sockets,
    close() {
      stopped = true;
      clearInterval(beat);
      for (const peer of sockets) peer.close(CLOSE.GOING_AWAY, 'server closing');
      sockets.clear();
    }
  };
}

function refuse(socket, code, message, extra = []) {
  const text = `${code} ${message}`;
  try {
    socket.write(
      `HTTP/1.1 ${text}\r\n` +
      'Connection: close\r\n' +
      'Content-Type: text/plain\r\n' +
      `Content-Length: ${Buffer.byteLength(text)}\r\n` +
      extra.map(h => h + '\r\n').join('') +
      '\r\n' + text
    );
  } catch (e) { /* the socket was already gone */ }
  try { socket.destroy(); } catch (e) { /* ditto */ }
}

export default attachWebSocket;
