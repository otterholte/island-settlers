/* Focused check on the mirror's award handling — the bug that made a friends
   match score up to five points light. Drives src/net/mirror.js directly. */
import { createMatch, scoreOf } from '../src/core/rules.js';
import { createMirror } from '../src/net/mirror.js';
import { LONGEST_ROAD_VP, LARGEST_ARMY_VP, VICTORY_POINTS } from '../src/core/constants.js';

let fails = 0;
const ok = (name, cond, note = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${note ? '  ' + note : ''}`);
  if (!cond) fails++;
};

const state = createMatch({ seed: 12345 });
state.phase = 'play';
const mirror = createMirror(state, { yourPid: 0, roster: [], order: [0, 1, 2, 3] });
const me = state.players[0];
const rival = state.players[1];

const base = scoreOf(state, me);

mirror.applyEvent({ type: 'award', kind: 'longestRoad', player: 0, value: 6 });
ok('longest road sets the flag', me.hasLongestRoad === true);
ok('longest road is worth its points on the client',
  scoreOf(state, me) === base + LONGEST_ROAD_VP,
  `${base} -> ${scoreOf(state, me)} (+${LONGEST_ROAD_VP} expected)`);
ok('the winning length lands on the holder', me.longestRoadLen === 6);
ok('the holder id still tracks', state.longestRoadHolder === 0);

mirror.applyEvent({ type: 'award', kind: 'largestArmy', player: 0, value: 3 });
ok('largest army is worth its points too',
  scoreOf(state, me) === base + LONGEST_ROAD_VP + LARGEST_ARMY_VP,
  `${scoreOf(state, me)} of ${VICTORY_POINTS}`);

mirror.applyEvent({ type: 'award', kind: 'longestRoad', player: 1, value: 8 });
ok('an award taken off you is taken off your score',
  me.hasLongestRoad === false && rival.hasLongestRoad === true &&
  scoreOf(state, me) === base + LARGEST_ARMY_VP);
ok('and lands on the player who took it',
  scoreOf(state, rival) === scoreOf(state, rival));

mirror.applyEvent({ type: 'awardLost', kind: 'longestRoad' });
ok('awardLost clears every flag, not just the holder',
  state.players.every(p => !p.hasLongestRoad) && state.longestRoadHolder === -1);

mirror.applyEvent({ type: 'awardLost', kind: 'largestArmy' });
ok('the same for the army',
  state.players.every(p => !p.hasLargestArmy) && state.largestArmyHolder === -1 &&
  scoreOf(state, me) === base);

console.log(fails ? `\n${fails} FAILED` : '\nall good');
process.exit(fails ? 1 : 0);
