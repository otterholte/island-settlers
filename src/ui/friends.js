/**
 * Island Settlers — sign in, friends, invites, lobby.
 *
 *   createFriends(root, { client, onClose }) ->
 *     { node, show, hide, refresh, destroy }
 *
 * The third view of the opening screen, and the only part of the game that
 * knows what an account is.
 *
 * FOUR PANELS, ONE AT A TIME
 * --------------------------
 *   connect   where the server is, if we cannot work it out or cannot reach it
 *   signin    name and password, register or sign in — the same form for both
 *   friends   who you know, who is online, who has asked to know you
 *   lobby     four seats, the two settings, and a START everybody presses
 *
 * They are one at a time on purpose. This screen sits over a live 3D island
 * with a drifting camera, and the whole reason the match settings moved into a
 * box last round was that loose controls over moving scenery are hard to read.
 * Everything here is inside the same kind of plate for the same reason.
 *
 * NOTHING HERE OWNS ANY STATE
 * ---------------------------
 * The server's `friends` and `room` pushes are the truth and this file redraws
 * from whatever arrived. There is no local list to get out of step, no
 * optimistic insert to roll back, and reconnecting fixes anything by
 * definition because the server re-sends both on sign-in.
 *
 * Owner: net agent.
 */

import { el, button, setText, toggle, clear } from './dom.js';
import { icon } from './icons.js';
import { PUSH, REQ, nameProblem, passProblem, errText, SEATS } from '../net/protocol.js';
import { serverCandidates, savedServer, setServer, normalizeServer } from '../net/config.js';
import { DIFFICULTY_ORDER, LEVELS } from '../systems/difficulty.js';
import { PLAYER_COLORS } from '../core/constants.js';

const COLOR = {};
for (const c of PLAYER_COLORS) COLOR[c.key] = c;

export function createFriends(root, opts = {}) {
  const client = opts.client;
  const onClose = typeof opts.onClose === 'function' ? opts.onClose : () => {};

  let panel = 'signin';
  let friends = { friends: [], incoming: [], outgoing: [] };
  let room = null;
  let invites = [];          // [{ roomId, from, at }]
  let busy = false;

  /* ==================================================================== dom */

  const title = el('b', { class: 'fr-title', text: 'Play with Friends' });
  const sub = el('span', { class: 'fr-sub', text: '' });
  const closeBtn = button('cbtn small ghost fr-x', {
    'aria-label': 'Back to the home screen', on: { click: () => onClose() }
  }, el('span', { class: 'cb-ico', html: icon('close', 18) }));

  const dot = el('i', { class: 'fr-dot' });
  const statusTxt = el('span', { class: 'fr-status-t', text: 'Offline' });
  const statusRow = el('div', { class: 'fr-status' }, dot, statusTxt);

  const body = el('div', { class: 'fr-body' });
  const foot = el('div', { class: 'fr-foot' });
  const note = el('div', { class: 'fr-note hid' });

  /* `data-ui` IS NOT DECORATION. IT IS WHY THIS SCREEN CAN BE TOUCHED.
   *
   * ui-base.css carries `#ui *{pointer-events:none}` and turns it back on with
   * `#ui [data-ui],#ui [data-ui] *{pointer-events:auto}`. The first selector is
   * more specific than any plain class, so a `pointer-events:auto` in
   * friends.css loses to it and every control in here is inert — the panel
   * draws perfectly, the buttons highlight on hover, and not one click lands.
   *
   * It shipped that way, because the capture rig pressed buttons with
   * `element.click()`, which does not hit-test. Layout was proven; touching it
   * never was. The first person to actually try to sign in could not put a
   * cursor in the name field. */
  const node = el('div', { class: 'fr-wrap hid', 'data-ui': '' },
    el('div', { class: 'fr-panel' },
      el('div', { class: 'fr-head' }, title, sub, closeBtn),
      body, note, foot));

  root.appendChild(node);

  /* The connection lamp lives in the FOOT, not the head.
     It was measured overlapping the close button at 960x444: the head already
     carries a title and a subtitle and an absolutely-positioned X, and a
     fourth thing that says "Connected · 34ms" has nowhere left to go. Down
     here it has the whole left edge and sits next to the SERVER button, which
     is the control you would reach for if it ever said the other thing. */
  function resetPanels() {
    clear(body);
    clear(foot);
    foot.appendChild(statusRow);
  }

  function say(text, kind) {
    if (!text) { toggle(note, 'hid', true); return; }
    note.className = `fr-note ${kind || 'info'}`;
    setText(note, text);
  }

  function setBusy(on) {
    busy = !!on;
    toggle(node, 'busy', busy);
  }

  /* ============================================================== the server
     Shown when there is nowhere to connect to, or when connecting failed.
     A text box beats editing a constant in a source file that is served from
     a CDN, and it is stored per browser so it is asked once. */

  function drawConnect() {
    resetPanels();
    setText(title, 'Where is your server?');
    setText(sub, '');
    const input = el('input', {
      class: 'fr-input', type: 'text', spellcheck: 'false',
      autocapitalize: 'off', autocomplete: 'off',
      placeholder: 'island-settlers.fly.dev',
      value: savedServer() || ''
    });
    body.appendChild(el('p', { class: 'fr-copy', text:
      'Multiplayer needs a small server of its own — the game files alone cannot '
      + 'hold accounts or pass moves between people. Paste its address here.' }));
    body.appendChild(input);
    body.appendChild(el('p', { class: 'fr-hint', text:
      'Deploying one is in server/README.md. For a server on this machine, use localhost:8787.' }));

    const save = button('green fr-go', { on: { click: () => {
      const url = normalizeServer(input.value);
      if (!url) { say('That does not look like an address.', 'bad'); return; }
      setServer(url);
      client.forget();
      if (client.rediscover) client.rediscover();
      say('');
      client.connect(true);
      go('signin');
    } } }, el('span', { class: 'sb-lab', text: 'Connect' }));
    foot.appendChild(save);
    setTimeout(() => { try { input.focus(); } catch (e) { /* fine */ } }, 60);
  }

  /* =============================================================== sign in
     ONE FORM FOR BOTH. Asking somebody to choose between "sign in" and
     "create account" before they have typed anything is asking them to
     remember whether they have been here before. Both buttons are live; the
     one that is wrong says so in a sentence. */

  function drawSignIn() {
    resetPanels();
    setText(title, 'Play with Friends');
    setText(sub, 'Sign in, or pick a name');

    const name = el('input', {
      class: 'fr-input', type: 'text', spellcheck: 'false',
      autocapitalize: 'off', autocomplete: 'username',
      maxlength: '16', placeholder: 'Your name', value: client.lastName || ''
    });
    const pass = el('input', {
      class: 'fr-input', type: 'password', autocomplete: 'current-password',
      maxlength: '128', placeholder: 'Password'
    });
    body.appendChild(el('label', { class: 'fr-lab', text: 'Name' }));
    body.appendChild(name);
    body.appendChild(el('label', { class: 'fr-lab', text: 'Password' }));
    body.appendChild(pass);
    body.appendChild(el('p', { class: 'fr-hint', text:
      '3 to 16 letters, numbers, dots, dashes or underscores. No email, no verification.' }));

    const attempt = async which => {
      const nErr = nameProblem(name.value);
      if (nErr) return say(errText(nErr), 'bad');
      const pErr = passProblem(pass.value);
      if (pErr) return say(errText(pErr), 'bad');
      setBusy(true);
      say('');
      try {
        if (which === 'new') await client.register(name.value.trim(), pass.value);
        else await client.login(name.value.trim(), pass.value);
        pass.value = '';
        go('friends');
      } catch (e) {
        if (e.code === 'name.taken') say('That name is taken — try signing in instead.', 'bad');
        else if (e.code === 'auth.bad') say('That name and password do not match. New here? Create the account.', 'bad');
        else if (e.code === 'net.closed' || e.code === 'net.timeout') say('Cannot reach the server.', 'bad');
        else say(e.message || 'That did not work.', 'bad');
      } finally {
        setBusy(false);
      }
    };

    pass.addEventListener('keydown', ev => { if (ev.key === 'Enter') attempt('in'); });
    name.addEventListener('keydown', ev => { if (ev.key === 'Enter') pass.focus(); });

    foot.appendChild(button('cream fr-small', { on: { click: () => go('connect') } },
      el('span', { class: 'sb-lab', text: 'Server' })));
    foot.appendChild(button('cream fr-alt', { on: { click: () => attempt('new') } },
      el('span', { class: 'sb-lab', text: 'Create Account' })));
    foot.appendChild(button('green fr-go', { on: { click: () => attempt('in') } },
      el('span', { class: 'sb-lab', text: 'Sign In' })));
  }

  /* ================================================================ friends */

  function drawFriends() {
    resetPanels();
    setText(title, 'Friends');
    setText(sub, client.user ? `Signed in as ${client.user.name}` : '');

    /* --- an invite you have been sent goes at the very top ------------- */
    for (const inv of invites) {
      body.appendChild(el('div', { class: 'fr-invite' },
        el('span', { class: 'fr-i-txt' },
          el('b', { text: inv.from.name }), ' invited you to a match'),
        button('green fr-tiny', { on: { click: () => joinRoom(inv.roomId) } },
          el('span', { class: 'sb-lab', text: 'Join' })),
        button('cream fr-tiny', { on: { click: () => {
          invites = invites.filter(x => x.roomId !== inv.roomId);
          draw();
        } } }, el('span', { class: 'sb-lab', text: 'No' }))));
    }

    /* --- add somebody -------------------------------------------------- */
    const add = el('input', {
      class: 'fr-input fr-add', type: 'text', spellcheck: 'false',
      autocapitalize: 'off', maxlength: '16', placeholder: 'Add a friend by name'
    });
    const addGo = button('cream fr-tiny', { on: { click: () => sendRequest(add.value) } },
      el('span', { class: 'sb-lab', text: 'Add' }));
    add.addEventListener('keydown', ev => { if (ev.key === 'Enter') sendRequest(add.value); });
    body.appendChild(el('div', { class: 'fr-addrow' }, add, addGo));

    async function sendRequest(raw) {
      const err = nameProblem(raw);
      if (err) return say(errText(err), 'bad');
      setBusy(true);
      try {
        const r = await client.req(REQ.FRIEND_ADD, { name: String(raw).trim() });
        add.value = '';
        say(r.status === 'accepted'
          ? `${r.user.name} had already asked — you are friends now.`
          : `Asked ${r.user.name}. They will see it next time they are on.`, 'good');
      } catch (e) {
        say(e.message || 'That did not work.', 'bad');
      } finally { setBusy(false); }
    }

    /* --- people who asked you ------------------------------------------ */
    if (friends.incoming.length) {
      body.appendChild(el('div', { class: 'fr-sec', text: 'Wants to be friends' }));
      for (const u of friends.incoming) {
        body.appendChild(el('div', { class: 'fr-row' },
          el('span', { class: 'fr-name', text: u.name }),
          button('green fr-tiny', { on: { click: () => answer(u.id, true) } },
            el('span', { class: 'sb-lab', text: 'Accept' })),
          button('cream fr-tiny', { on: { click: () => answer(u.id, false) } },
            el('span', { class: 'sb-lab', text: 'No' }))));
      }
    }

    async function answer(id, yes) {
      setBusy(true);
      try {
        await client.req(yes ? REQ.FRIEND_ACCEPT : REQ.FRIEND_DECLINE, { id });
      } catch (e) { say(e.message, 'bad'); } finally { setBusy(false); }
    }

    /* --- your friends --------------------------------------------------- */
    body.appendChild(el('div', { class: 'fr-sec', text: 'Friends' }));
    if (!friends.friends.length) {
      body.appendChild(el('p', { class: 'fr-copy', text:
        'Nobody yet. Add somebody by the name they signed up with — they have to '
        + 'accept before you can invite them.' }));
    }
    // Online first, then alphabetically: the list exists to answer "who can I
    // play with right now", and that is the order that answers it.
    const sorted = friends.friends.slice().sort((a, b) =>
      (b.online - a.online) || a.name.localeCompare(b.name));
    for (const u of sorted) {
      const state = u.inMatch ? 'In a match' : (u.online ? 'Online' : 'Offline');
      const row = el('div', { class: 'fr-row' + (u.online ? ' on' : '') },
        el('i', { class: 'fr-pip' + (u.online ? ' on' : '') }),
        el('span', { class: 'fr-name', text: u.name }),
        el('span', { class: 'fr-when', text: state }));
      if (u.online && !u.inMatch) {
        row.appendChild(button('green fr-tiny', { on: { click: () => inviteTo(u) } },
          el('span', { class: 'sb-lab', text: room ? 'Invite' : 'Play' })));
      }
      row.appendChild(button('cream fr-tiny fr-drop', {
        'aria-label': `Remove ${u.name}`,
        on: { click: () => remove(u) }
      }, el('span', { class: 'sb-lab', text: '×' })));
      body.appendChild(row);
    }

    async function remove(u) {
      setBusy(true);
      try { await client.req(REQ.FRIEND_REMOVE, { id: u.id }); }
      catch (e) { say(e.message, 'bad'); } finally { setBusy(false); }
    }

    /* --- feet ----------------------------------------------------------- */
    foot.appendChild(button('cream fr-alt', { on: { click: () => signOut() } },
      el('span', { class: 'sb-lab', text: 'Sign Out' })));
    foot.appendChild(button('green fr-go', { on: { click: () => makeRoom() } },
      el('span', { class: 'sb-lab', text: room ? 'Back to Lobby' : 'Open a Lobby' })));
  }

  async function signOut() {
    setBusy(true);
    try { await client.logout(); } catch (e) { /* going anyway */ }
    room = null;
    friends = { friends: [], incoming: [], outgoing: [] };
    setBusy(false);
    go('signin');
  }

  async function makeRoom() {
    if (room) { go('lobby'); return; }
    setBusy(true);
    try {
      const r = await client.req(REQ.ROOM_CREATE, {});
      room = r.room;
      go('lobby');
    } catch (e) { say(e.message, 'bad'); } finally { setBusy(false); }
  }

  async function joinRoom(roomId) {
    setBusy(true);
    try {
      const r = await client.req(REQ.ROOM_JOIN, { roomId });
      room = r.room;
      invites = invites.filter(x => x.roomId !== roomId);
      go('lobby');
    } catch (e) { say(e.message, 'bad'); } finally { setBusy(false); }
  }

  async function inviteTo(u) {
    setBusy(true);
    try {
      if (!room) {
        const r = await client.req(REQ.ROOM_CREATE, {});
        room = r.room;
      }
      await client.req(REQ.ROOM_INVITE, { userId: u.id });
      say(`Invited ${u.name}.`, 'good');
      go('lobby');
    } catch (e) { say(e.message, 'bad'); } finally { setBusy(false); }
  }

  /* ================================================================== lobby */

  function drawLobby() {
    resetPanels();
    if (!room) { go('friends'); return; }
    const meId = client.user ? client.user.id : null;
    const host = room.hostId === meId;
    const mine = room.seats.find(s => s.userId === meId);
    const iAmReady = !!(mine && mine.ready);
    const humans = room.seats.filter(s => s.kind === 'human').length;
    const readyN = room.seats.filter(s => s.kind === 'human' && s.ready).length;
    const waiting = room.seats
      .filter(s => s.kind === 'human' && !s.ready && s.userId !== meId)
      .map(s => s.name);
    setText(title, 'Lobby');
    setText(sub, `Code ${room.id}${host ? ' · you are the host' : ''}`);

    /* --- the four seats -------------------------------------------------- */
    const seats = el('div', { class: 'fr-seats' });
    for (let pid = 0; pid < SEATS; pid++) {
      const s = room.seats[pid] || { pid, kind: 'empty', color: 'blue' };
      const c = COLOR[s.color] || PLAYER_COLORS[pid];
      const cell = el('div', {
        class: 'fr-seat ' + s.kind + (s.userId === meId ? ' me' : ''),
        style: { '--c': c.css, '--cl': c.light }
      },
        el('i', { class: 'fr-band' }),
        el('b', { class: 'fr-sname', text: s.kind === 'human' ? s.name : 'Open' }),
        el('span', { class: 'fr-srole', text:
          s.kind === 'human'
            ? (s.ready ? 'Ready' : 'Not ready yet')
            + (s.userId === room.hostId ? ' · Host' : '')
            : 'A bot will take this seat' }));
      if (s.kind === 'human') toggle(cell, 'set', !!s.ready);
      if (host && s.kind === 'human' && s.userId !== meId) {
        cell.appendChild(button('cream fr-tiny fr-drop', {
          'aria-label': `Remove ${s.name}`,
          on: { click: () => kick(s.userId) }
        }, el('span', { class: 'sb-lab', text: '×' })));
      }
      seats.appendChild(cell);
    }
    body.appendChild(seats);

    /* Who still has to press, right under the seats. It lived down by the
       button and the body scrolls, so on a 444-tall screen the one line that
       explains why nothing is happening was below the fold. */
    if (humans > 1) {
      // Counts EVERYONE outstanding, including you: it read "0 of 2 ready ·
      // waiting for Pal" when the person who had not pressed was the reader.
      const outstanding = room.seats
        .filter(s => s.kind === 'human' && !s.ready)
        .map(s => (s.userId === meId ? 'you' : s.name));
      body.appendChild(el('div', { class: 'fr-tally' + (readyN === humans ? ' all' : '') },
        el('b', { text: `${readyN} of ${humans} ready` }),
        el('span', { text: outstanding.length
          ? `Waiting for ${outstanding.join(' and ')}`
          : 'Starting…' })));
    }

    /* --- the settings, host only ----------------------------------------- */
    const row = el('div', { class: 'fr-set' });
    row.appendChild(el('span', { class: 'fr-slab', text: 'Rivals' }));
    const diffRow = el('div', { class: 'fr-diff' });
    for (const key of DIFFICULTY_ORDER) {
      const b = button('cream fr-d' + (room.settings.difficulty === key ? ' on' : ''), {
        disabled: host ? undefined : 'disabled',
        on: { click: () => host && setSetting({ difficulty: key }) }
      }, el('span', { class: 'sb-lab', text: LEVELS[key].label }));
      diffRow.appendChild(b);
    }
    row.appendChild(diffRow);
    body.appendChild(row);

    const krow = el('div', { class: 'fr-set' });
    krow.appendChild(el('span', { class: 'fr-slab', text: 'Knights' }));
    const sw = button('mf-switch fr-switch' + (room.settings.knights ? ' on' : ''), {
      role: 'switch', 'aria-checked': room.settings.knights ? 'true' : 'false',
      disabled: host ? undefined : 'disabled',
      on: { click: () => host && setSetting({ knights: !room.settings.knights }) }
    });
    krow.appendChild(sw);
    krow.appendChild(el('b', { class: 'fr-swtxt', text: room.settings.knights ? 'On' : 'Off' }));
    body.appendChild(krow);
    body.appendChild(el('p', { class: 'fr-hint', text: host
      ? 'Empty seats become bots at this difficulty when you start.'
      : 'The host picks the difficulty and whether Knights are in the deck.' }));

    /* --- invite more ------------------------------------------------------ */
    const free = room.seats.filter(s => s.kind === 'empty').length;
    if (free > 0) {
      const can = friends.friends.filter(u => u.online && !u.inMatch
        && !room.seats.some(s => s.userId === u.id));
      if (can.length) {
        body.appendChild(el('div', { class: 'fr-sec', text: 'Invite' }));
        for (const u of can.slice(0, 6)) {
          body.appendChild(el('div', { class: 'fr-row on' },
            el('i', { class: 'fr-pip on' }),
            el('span', { class: 'fr-name', text: u.name }),
            button('green fr-tiny', { on: { click: () => invite(u.id) } },
              el('span', { class: 'sb-lab', text: 'Invite' }))));
        }
      } else {
        body.appendChild(el('p', { class: 'fr-copy', text:
          'No friends online to invite right now. You can still start — the empty '
          + 'seats play as bots.' }));
      }
    }

    /* --- everybody has to say yes -------------------------------------------
     *
     *   "Make sure that both players have to start the game for it to actually
     *    start. If one person presses start, then it shows as waiting for the
     *    other player."
     *
     * So START is not the host's button any more, it is everybody's, and the
     * server begins on the last press rather than the first. Pressing it again
     * takes it back — changing your mind before a twenty-minute match should
     * cost one tap, not a walk out of the lobby.
     *
     * On your own with three bots this reads exactly the same and starts
     * immediately, because there is nobody left to wait for. */
    /* --- feet -------------------------------------------------------------- */
    foot.appendChild(button('cream fr-alt', { on: { click: () => leaveRoom() } },
      el('span', { class: 'sb-lab', text: 'Leave' })));
    foot.appendChild(button('cream fr-alt', { on: { click: () => go('friends') } },
      el('span', { class: 'sb-lab', text: 'Friends' })));

    const label = iAmReady
      ? (waiting.length
        ? `Waiting for ${waiting.length === 1 ? waiting[0] : `${waiting.length} others`}`
        : 'Starting…')
      : 'Start the Match';
    foot.appendChild(button('green fr-go' + (iAmReady ? ' fr-waiting' : ''), {
      'aria-pressed': iAmReady ? 'true' : 'false',
      on: { click: () => setReady(!iAmReady) }
    }, el('span', { class: 'sb-lab', text: label })));

    if (iAmReady && waiting.length) {
      foot.appendChild(el('span', { class: 'fr-cancel', text: 'Tap again to cancel' }));
    }
  }

  async function setReady(ready) {
    try {
      const r = await client.req(REQ.ROOM_READY, { ready });
      if (r.started) { say('Dealing the island…', 'good'); setBusy(true); return; }
      say(ready && r.waitingFor && r.waitingFor.length
        ? `Waiting for ${r.waitingFor.join(' and ')} to start.`
        : '', ready ? 'good' : 'info');
    } catch (e) {
      say(e.message, 'bad');
    }
  }

  async function setSetting(patch) {
    try {
      const r = await client.req(REQ.ROOM_SETTINGS, patch);
      room = r.room;
      draw();
    } catch (e) { say(e.message, 'bad'); }
  }

  async function invite(userId) {
    try { await client.req(REQ.ROOM_INVITE, { userId }); say('Invite sent.', 'good'); }
    catch (e) { say(e.message, 'bad'); }
  }

  async function kick(userId) {
    try { await client.req(REQ.ROOM_KICK, { userId }); }
    catch (e) { say(e.message, 'bad'); }
  }

  async function leaveRoom() {
    setBusy(true);
    try { await client.req(REQ.ROOM_LEAVE, {}); } catch (e) { /* going anyway */ }
    room = null;
    setBusy(false);
    go('friends');
  }



  /* ================================================================ routing */

  function go(next) {
    panel = next;
    say('');
    draw();
  }

  function draw() {
    if (!client) return;
    if (panel === 'connect') return drawConnect();
    if (!client.signedIn) { panel = 'signin'; return drawSignIn(); }
    if (panel === 'lobby' && room) return drawLobby();
    if (panel === 'lobby' && !room) panel = 'friends';
    return drawFriends();
  }

  function paintStatus() {
    const s = client.status;
    const label = {
      offline: 'Offline', dialling: 'Connecting…', open: 'Connecting…',
      ready: client.ping >= 0 ? `Connected · ${client.ping}ms` : 'Connected',
      failed: 'Cannot reach the server'
    }[s] || s;
    setText(statusTxt, label);
    dot.className = 'fr-dot ' + (s === 'ready' ? 'ok' : s === 'failed' ? 'bad' : 'wait');
    if (s === 'failed' && panel !== 'connect') {
      const tried = (client.tried || []).join(', ');
      say('Cannot reach the server — still trying.'
        + (tried ? ` (tried ${tried})` : '')
        + ' If it never comes up, SERVER lets you point it somewhere else.', 'bad');
    }
  }

  /* =============================================================== the wire */

  const offs = [];
  if (client) {
    offs.push(client.on('status', () => { paintStatus(); draw(); }));
    offs.push(client.on('ping', paintStatus));
    offs.push(client.on('session', () => draw()));
    offs.push(client.on(PUSH.FRIENDS, msg => {
      friends = {
        friends: msg.friends || [], incoming: msg.incoming || [], outgoing: msg.outgoing || []
      };
      if (panel === 'friends' || panel === 'lobby') draw();
    }));
    offs.push(client.on(PUSH.PRESENCE, msg => {
      const f = friends.friends.find(u => u.id === msg.userId);
      if (!f) return;
      f.online = msg.online;
      f.inMatch = msg.inMatch;
      if (panel === 'friends' || panel === 'lobby') draw();
    }));
    offs.push(client.on(PUSH.INVITE, msg => {
      invites = invites.filter(x => x.roomId !== msg.roomId);
      invites.unshift({ roomId: msg.roomId, from: msg.from, at: Date.now() });
      // An invite is worth interrupting for: it is somebody waiting on you.
      if (panel === 'lobby' && room) draw();
      else go('friends');
    }));
    offs.push(client.on(PUSH.INVITE_GONE, msg => {
      invites = invites.filter(x => x.roomId !== msg.roomId);
      draw();
    }));
    offs.push(client.on(PUSH.ROOM, msg => {
      room = msg.room || null;
      if (room && panel !== 'lobby') panel = 'lobby';
      if (!room && panel === 'lobby') panel = 'friends';
      draw();
    }));
    offs.push(client.on(PUSH.KICKED, msg => {
      if (msg.reason === 'signed-in-elsewhere') {
        say('You signed in somewhere else — this tab has been signed out.', 'bad');
      } else {
        say('You were removed from that lobby.', 'warn');
      }
      room = null;
      draw();
    }));
  }

  /* ================================================================= public */

  function show() {
    toggle(node, 'hid', false);
    // The address box is a last resort, not a greeting. There is somewhere to
    // try in every case except a page opened off a file:// with no server
    // compiled in — and the client walks the whole list before giving up, so
    // an origin with no websocket on it costs a moment, not a question.
    if (!serverCandidates().length) panel = 'connect';
    else if (!client.signedIn) panel = 'signin';
    else if (room) panel = 'lobby';
    else panel = 'friends';
    paintStatus();
    draw();
    if (client.status === 'offline' || client.status === 'failed') client.connect(true);
    client.measurePing();
  }

  function hide() {
    toggle(node, 'hid', true);
  }

  return {
    node, show, hide, draw,
    get panel() { return panel; },
    get room() { return room; },
    destroy() {
      for (const off of offs) { try { off(); } catch (e) { /* fine */ } }
      offs.length = 0;
      if (node.parentNode) node.parentNode.removeChild(node);
    }
  };
}

export default createFriends;
