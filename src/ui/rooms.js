/**
 * Island Settlers — your name, a room code, and the lobby.
 *
 *   createRooms(root, { client, onClose }) ->
 *     { node, show, hide, draw, destroy }
 *
 * The third view of the opening screen. It replaced a sign-in form, a friends
 * list and an invite tray:
 *
 *   "The play with friends isn't working right now. I'd rather just switch to
 *    a create a room and use a room code, since it's not just 1 on 1 and
 *    sometimes there's 3 or even four friends playing together. Remove adding
 *    friends, remove accepting players, just say whoever put in that room code
 *    while the lobby was open is added to the game. But users can still add
 *    their name and it stays saved locally on the device."
 *
 * WHY THE OLD SCREEN COULD NOT WORK
 * ---------------------------------
 * It was not a polish problem. Every friend row's button created a room if you
 * did not have one, the lobby never rendered incoming invites, and the invite
 * push deliberately did not switch panels while you had a room of your own. So
 * two friends who both pressed Play on each other each became the host of their
 * own lobby, never saw the other's invite, and each sat looking at three open
 * seats and a live START button. Pressing it started a real match — with three
 * bots, on its own random island.
 *
 * That is the report, exactly: "they were playing at the same time, but the
 * roads and settlements were in different locations, and when one user built a
 * road the other player didn't see it at all." They were in two matches.
 *
 * A code cannot do that. Everyone typing the same five characters is, without
 * any further machinery, one room.
 *
 * THREE PANELS, ONE AT A TIME
 * ---------------------------
 *   choose    your name, and the only two things anybody came here to do
 *   join      a code box and nothing else
 *   lobby     the code in large letters, four seats, the settings, and a START
 *             everybody presses
 *
 * It used to be two, and the first of them was one screen doing both jobs: a
 * name field, a paragraph about making a room, a code box, a JOIN button and a
 * CREATE A ROOM button, all at once.
 *
 *   "Make it be the first thing you see, a popup with two buttons, Join a room
 *    or Create a room. Then if they click join a room it can be a simpler next
 *    popup screen, that doesn't have the start a game text paragraph. But if
 *    you press create a room, you go straight to that screen."
 *
 * Which is the right shape, and it is worth saying why: the paragraph existed
 * to explain the room-code idea to somebody who had not chosen anything yet,
 * and it was in the way of both people who had. Somebody joining does not need
 * to be told how hosting works — they need the box. Somebody hosting does not
 * need to read about it either — the code is on the very next screen. Asking
 * the question first means neither of them reads a word meant for the other.
 *
 * The name field stays on `choose` rather than moving to `join`, because it is
 * the one thing BOTH answers need and the only screen both paths pass through.
 *
 * There used to be a third, behind a SERVER button: a text field for the
 * websocket address.
 *
 *   "Remove the SERVER button entirely, the server should always be set,
 *    there's no reason anyone would use a server other than the online one we
 *    already have."
 *
 * Correct. `net/config.js` already knows the deployed address and already
 * falls back to this page's own origin, which is what makes a locally-served
 * copy work with no configuration — so the box could only ever be used to
 * point the game at a server that does not exist. It was a developer's control
 * wearing a player's clothes. The `?server=` query parameter is still there for
 * testing a branch against a test deployment.
 *
 * NOTHING HERE OWNS ANY STATE
 * ---------------------------
 * The server's `room` push is the truth and this file redraws from whatever
 * arrived. There is no local list to get out of step and reconnecting fixes
 * anything by definition, because the server re-sends the room on `hello`.
 *
 * Owner: net agent.
 */

import { el, button, setText, toggle, clear } from './dom.js';
import { icon } from './icons.js';
import {
  PUSH, REQ, SEATS, CODE_LEN,
  nameProblem, cleanName, cleanCode, codeProblem, errText
} from '../net/protocol.js';
import { DIFFICULTY_ORDER, LEVELS } from '../systems/difficulty.js';
import { PLAYER_COLORS } from '../core/constants.js';

const COLOR = {};
for (const c of PLAYER_COLORS) COLOR[c.key] = c;

export function createRooms(root, opts = {}) {
  const client = opts.client;
  const onClose = typeof opts.onClose === 'function' ? opts.onClose : () => {};

  let panel = 'choose';
  let renderedPanel = null;
  /** The button an arrow-key cursor should land on for the panel on screen.
   *  Read by the scope in systems/flowUI.js; see `first` there. */
  let primaryBtn = null;
  let room = null;
  let busy = false;
  /** Kept across redraws so a half-typed code survives a `room` push. */
  let codeDraft = '';

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
   * rooms.css loses to it and every control in here is inert — the panel
   * draws perfectly, the buttons highlight on hover, and not one click lands.
   *
   * It shipped that way once, because the capture rig pressed buttons with
   * `element.click()`, which does not hit-test. Layout was proven; touching it
   * never was. */
  const node = el('div', { class: 'fr-wrap hid', 'data-ui': '' },
    el('div', { class: 'fr-panel' },
      el('div', { class: 'fr-head' }, title, sub, closeBtn),
      body, note, foot));

  root.appendChild(node);

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

  const meId = () => (client.user ? client.user.id : null);

  /* ============================================================= your name
   *
   * Saved on THIS DEVICE and nowhere else, which is the whole of the request.
   * It is filled in from localStorage on the first paint, so a returning
   * player never types it twice, and it is written back on every keystroke
   * rather than on a Save button — there is nothing to submit and no way to
   * get it wrong.
   */
  function nameField() {
    const name = el('input', {
      class: 'fr-input fr-nameinput', type: 'text', spellcheck: 'false',
      autocapitalize: 'words', autocomplete: 'nickname',
      maxlength: '14', placeholder: 'Display name',
      /* Blank when they have never said, so the placeholder is what they see
         rather than a name they did not choose. `DEFAULT_NAME` in client.js
         still stands behind it, so somebody who never touches this field is
         "Settler" on the seat and never has to fill in a form to play. */
      value: client.named ? client.name : ''
    });
    let nameT = 0;
    const pushName = () => {
      const nice = cleanName(name.value);
      if (nameProblem(nice)) return;
      client.setName(nice).catch(() => { /* saved locally regardless */ });
    };
    name.addEventListener('input', () => {
      clearTimeout(nameT);
      nameT = setTimeout(pushName, 350);
    });
    name.addEventListener('blur', pushName);
    return name;
  }

  /* ================================================================ choose
   *
   * The question, and nothing else that could be mistaken for it.
   */

  function drawChoose() {
    resetPanels();
    setText(title, 'Play with Friends');
    setText(sub, 'Join a friend’s room, or make your own');

    body.appendChild(el('label', { class: 'fr-lab', text: 'Display name' }));
    body.appendChild(nameField());
    /* The wording is a Play listing commitment, not a style choice — it says
       where the name goes as well as where it is kept. See PLAY-STORE.md. */
    body.appendChild(el('p', { class: 'fr-hint', text:
      'Saved on this device and visible to players in your room.' }));

    /* Both in the body rather than the foot, because they are the CHOICE and
       not the way onward from one. The foot on this panel therefore carries
       only the connection status, which is worth reading before either. */
    const joinBtn = button('green fr-choice', { on: { click: () => go('join') } },
      el('span', { class: 'sb-lab', text: 'Join a Room' }));
    const makeBtn = button('green fr-choice', { on: { click: () => makeRoom() } },
      el('span', { class: 'sb-lab', text: room ? 'Back to Your Room' : 'Create a Room' }));
    body.appendChild(el('div', { class: 'fr-choices' }, joinBtn, makeBtn));
    primaryBtn = joinBtn;
  }

  /* ================================================================== join
   *
   * A code box, and the way back. Somebody who pressed JOIN has already
   * decided; the paragraph that used to sit here explained hosting to them.
   */

  function drawJoin() {
    resetPanels();
    setText(title, 'Join a Room');
    setText(sub, 'Type your friend’s code');

    const code = el('input', {
      class: 'fr-input fr-code', type: 'text', spellcheck: 'false',
      autocapitalize: 'characters', autocomplete: 'off',
      inputmode: 'latin', maxlength: String(CODE_LEN + 3),
      placeholder: 'ABCDE', value: codeDraft, 'aria-label': 'Room code'
    });
    // Normalised as they type, so the field always shows exactly what will be
    // sent: upper case, five characters, nothing else.
    code.addEventListener('input', () => {
      const at = code.selectionStart;
      const before = code.value;
      code.value = cleanCode(code.value);
      codeDraft = code.value;
      if (code.value !== before) {
        try { code.setSelectionRange(at, at); } catch (e) { /* fine */ }
      }
      toggle(joinBtn, 'off', !!codeProblem(code.value));
    });
    code.addEventListener('keydown', ev => { if (ev.key === 'Enter') joinRoom(code.value); });
    body.appendChild(el('label', { class: 'fr-lab', text: `${CODE_LEN}-character code` }));
    body.appendChild(code);
    body.appendChild(el('p', { class: 'fr-hint', text:
      'Ask whoever made the room to read theirs out.' }));

    const joinBtn = button('green fr-go' + (codeProblem(codeDraft) ? ' off' : ''), {
      on: { click: () => joinRoom(code.value) }
    }, el('span', { class: 'sb-lab', text: 'Join' }));

    /* --- feet ------------------------------------------------------------ */
    foot.appendChild(button('cream fr-alt', { on: { click: () => go('choose') } },
      el('span', { class: 'sb-lab', text: 'Back' })));
    foot.appendChild(joinBtn);
    primaryBtn = joinBtn;
  }

  /* Straight through: CREATE A ROOM asks the server for one and lands on the
     lobby, which IS the create screen. There was never a step in between and
     it should not look like there is. */
  async function makeRoom() {
    if (room) { go('lobby'); return; }
    setBusy(true);
    try {
      const r = await client.req(REQ.ROOM_CREATE, {});
      room = r.room;
      go('lobby');
    } catch (e) { say(e.message, 'bad'); } finally { setBusy(false); }
  }

  async function joinRoom(raw) {
    const c = cleanCode(raw);
    const bad = codeProblem(c);
    if (bad) return say(errText(bad), 'bad');
    setBusy(true);
    try {
      const r = await client.req(REQ.ROOM_JOIN, { code: c });
      room = r.room;
      codeDraft = '';
      go('lobby');
    } catch (e) {
      say(e.message, 'bad');
    } finally { setBusy(false); }
  }

  /* ================================================================== lobby */

  function drawLobby() {
    resetPanels();
    if (!room) { go('home'); return; }
    const id = meId();
    const host = room.hostId === id;
    const mine = room.seats.find(s => s.userId === id);
    const iAmReady = !!(mine && mine.ready);
    const humans = room.seats.filter(s => s.kind === 'human').length;
    const readyN = room.seats.filter(s => s.kind === 'human' && s.ready).length;
    const waiting = room.seats
      .filter(s => s.kind === 'human' && !s.ready && s.userId !== id)
      .map(s => s.name);
    setText(title, 'Your Room');
    setText(sub, host ? 'You made this room' : 'Waiting to start');

    /* --- THE CODE, big ---------------------------------------------------
     * The largest thing on the screen, because it is the one thing somebody
     * has to read out loud across a room or type into a group chat. Tapping it
     * copies it, and says so — on a phone that is the difference between
     * sharing a code and transcribing one. */
    const codeBox = el('div', { class: 'fr-codebox', role: 'button', tabindex: '0',
      'aria-label': `Room code ${String(room.code || room.id).split('').join(' ')}. Tap to copy.` },
      el('span', { class: 'fr-codelab', text: 'Room code' }),
      el('b', { class: 'fr-codeval', text: String(room.code || room.id) }),
      el('span', { class: 'fr-codehint', text: 'Tap to copy' }));
    const copy = async () => {
      const text = String(room.code || room.id);
      let ok = false;
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          await navigator.clipboard.writeText(text);
          ok = true;
        }
      } catch (e) { ok = false; }
      say(ok ? `Copied ${text}.` : `Your code is ${text}.`, 'good');
    };
    codeBox.addEventListener('click', copy);
    codeBox.addEventListener('keydown', ev => {
      if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); copy(); }
    });
    body.appendChild(codeBox);

    /* --- the four seats -------------------------------------------------- */
    const seats = el('div', { class: 'fr-seats' });
    for (let pid = 0; pid < SEATS; pid++) {
      const s = room.seats[pid] || { pid, kind: 'empty', color: 'blue' };
      const c = COLOR[s.color] || PLAYER_COLORS[pid];
      const cell = el('div', {
        class: 'fr-seat ' + s.kind + (s.userId === id ? ' me' : ''),
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
      if (host && s.kind === 'human' && s.userId !== id) {
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
        .map(s => (s.userId === id ? 'you' : s.name));
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
      diffRow.appendChild(button('cream fr-d' + (room.settings.difficulty === key ? ' on' : ''), {
        disabled: host ? undefined : 'disabled',
        on: { click: () => host && setSetting({ difficulty: key }) }
      }, el('span', { class: 'sb-lab', text: LEVELS[key].label })));
    }
    row.appendChild(diffRow);
    body.appendChild(row);

    const krow = el('div', { class: 'fr-set' });
    krow.appendChild(el('span', { class: 'fr-slab', text: 'Knights' }));
    krow.appendChild(button('mf-switch fr-switch' + (room.settings.knights ? ' on' : ''), {
      role: 'switch', 'aria-checked': room.settings.knights ? 'true' : 'false',
      disabled: host ? undefined : 'disabled',
      on: { click: () => host && setSetting({ knights: !room.settings.knights }) }
    }));
    krow.appendChild(el('b', { class: 'fr-swtxt', text: room.settings.knights ? 'On' : 'Off' }));
    body.appendChild(krow);

    /* WHO PICKS THE OPENING — for the whole table.
     *
     *   "The person that created the room was allowed to pick their position on
     *    the draft/board. The friend who joined wasn't. When really whoever
     *    created the room should choose whether everyone does or doesn't
     *    draft."
     *
     * It was a per-device preference, so two people in one match could disagree
     * about whether there was a draft at all — and the one whose device said
     * "pick for me" watched their corners being taken without ever being asked.
     * It is a room setting now, beside the difficulty and the Knights, and the
     * host owns it exactly as they own those. */
    const arow = el('div', { class: 'fr-set' });
    const drafting = !room.settings.autoDraft;
    arow.appendChild(el('span', { class: 'fr-slab', text: 'Draft' }));
    arow.appendChild(button('mf-switch fr-switch' + (drafting ? ' on' : ''), {
      role: 'switch', 'aria-checked': drafting ? 'true' : 'false',
      'aria-label': 'Everybody picks their own opening',
      disabled: host ? undefined : 'disabled',
      on: { click: () => host && setSetting({ autoDraft: drafting }) }
    }));
    arow.appendChild(el('b', { class: 'fr-swtxt',
      text: drafting ? 'We pick' : 'Auto' }));
    body.appendChild(arow);

    body.appendChild(el('p', { class: 'fr-hint', text: host
      ? 'Empty seats become bots at this difficulty when you start.'
      : 'The player who made the room picks the difficulty, the Knights and the draft.' }));

    /* --- everybody has to say yes -------------------------------------------
     *
     *   "Make sure that both players have to start the game for it to actually
     *    start. If one person presses start, then it shows as waiting for the
     *    other player."
     *
     * So START is not the host's button, it is everybody's, and the server
     * begins on the last press rather than the first. Pressing it again takes
     * it back. On your own with three bots this reads exactly the same and
     * starts immediately, because there is nobody left to wait for. */
    foot.appendChild(button('cream fr-alt', { on: { click: () => leaveRoom() } },
      el('span', { class: 'sb-lab', text: 'Leave' })));

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

  async function kick(userId) {
    try { await client.req(REQ.ROOM_KICK, { userId }); }
    catch (e) { say(e.message, 'bad'); }
  }

  async function leaveRoom() {
    setBusy(true);
    try { await client.req(REQ.ROOM_LEAVE, {}); } catch (e) { /* going anyway */ }
    room = null;
    setBusy(false);
    go('home');
  }

  /* ================================================================ routing */

  function go(next) {
    panel = next;
    say('');
    draw();
  }

  function draw() {
    if (!client) return;
    let result;
    primaryBtn = null;
    if (panel === 'lobby' && !room) panel = 'choose';
    if (panel === 'lobby') result = drawLobby();
    else if (panel === 'join') result = drawJoin();
    else { panel = 'choose'; result = drawChoose(); }
    /* `fr-body` is deliberately reused so live room pushes do not throw away
       the reader's place. A real panel transition is different: if the room
       code field scrolled Home down for the mobile keyboard, carrying that
       scrollTop into Lobby opens the new room below its own code and player
       names. Reset only when the panel identity changes; ordinary lobby
       redraws continue to preserve their scroll position. */
    if (renderedPanel !== panel) {
      body.scrollTop = 0;
      renderedPanel = panel;
    }
    return result;
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
    if (s === 'failed') {
      say('Cannot reach the server — still trying. Check your connection; '
        + 'it comes back on its own.', 'bad');
    }
  }

  /* =============================================================== the wire */

  const offs = [];
  if (client) {
    offs.push(client.on('status', () => { paintStatus(); draw(); }));
    offs.push(client.on('ping', paintStatus));
    offs.push(client.on('session', () => {
      // Redraw the lobby (names on seats change) but never `choose`, which
      // would blow away the field the player is typing their name into, nor
      // `join`, which would take the caret out of a half-typed code.
      if (panel === 'lobby') draw();
    }));
    offs.push(client.on(PUSH.ROOM, msg => {
      room = msg.room || null;
      if (room && panel !== 'lobby') panel = 'lobby';
      if (!room && panel === 'lobby') panel = 'choose';
      draw();
    }));
    offs.push(client.on(PUSH.KICKED, msg => {
      if (msg.reason === 'opened-elsewhere') {
        say('You opened the game somewhere else — this tab has let go.', 'bad');
      } else {
        say('You were removed from that room.', 'warn');
      }
      room = null;
      draw();
    }));
  }

  /* ================================================================= public */

  function show() {
    toggle(node, 'hid', false);
    if (room) panel = 'lobby';
    else panel = 'choose';
    renderedPanel = null;
    paintStatus();
    draw();
    if (client.status === 'offline' || client.status === 'failed') client.connect(true);
    client.measurePing();
  }

  function hide() {
    toggle(node, 'hid', true);
  }

  /**
   * Escape, and the Android back gesture behind it.
   *
   * Returns true when this screen consumed it. `join` is a step INTO the flow
   * rather than a sheet over it, so backing out of it belongs here — a panel
   * that can only be left by the X in the corner is a dead end, and on a phone
   * the system back gesture would otherwise leave the game entirely from a
   * screen the player is two taps into.
   */
  function back() {
    if (panel === 'join') { go('choose'); return true; }
    return false;
  }

  return {
    node, show, hide, draw, back,
    get panel() { return panel; },
    get room() { return room; },
    /** Where an arrow-key cursor should land on the panel that is up. */
    get primary() { return primaryBtn; },
    destroy() {
      for (const off of offs) { try { off(); } catch (e) { /* fine */ } }
      offs.length = 0;
      if (node.parentNode) node.parentNode.removeChild(node);
    }
  };
}

export default createRooms;
