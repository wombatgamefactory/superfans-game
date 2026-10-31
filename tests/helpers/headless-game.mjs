// headless-game.mjs - plays a whole game in Node with the random bot, keeping what the
// page keeps: the chosen actions (with seat and Hour) and every event.
// Used by the T16 tests (replay, analytics builders, bug report fuzz).

import { createGame, applyAction, getValidActions, isGameOver, makeRng, cloneState } from '../../src/engine/index.js';
import { chooseRandomAction } from '../../src/bots/randomBot.js';

export const COLOURS = ['blue', 'yellow', 'pink', 'green', 'red'];

export function seatsFor(n, kinds = null) {
  return Array.from({ length: n }, (_, i) => {
    const kind = kinds ? kinds[i] : i === 0 ? 'human' : 'bot';
    return { kind, level: kind === 'bot' ? 'easy' : null, name: kind === 'human' ? `Player ${i + 1}` : `Easy Bot ${i + 1}`, colour: COLOURS[i] };
  });
}

/**
 * @param {number} n players
 * @param {number|string} seed
 * @param {{ stopAfter?: number, snapshots?: number }} [o] stopAfter: stop after this many chosen actions;
 *   snapshots: keep a clone of the state every N actions
 */
export function playGame(n, seed, o = {}) {
  const seats = seatsFor(n);
  const config = { players: seats.map((s) => ({ name: s.name, colour: s.colour })), variants: {} };
  const made = createGame(config, { seed, events: true });
  const state = made.state;
  const events = [...made.events];
  const actions = [];
  const snapshots = [];
  const rng = makeRng(`bots:${seed}`);
  let guard = 0;
  while (!isGameOver(state) && guard++ < 20000) {
    if (o.stopAfter !== undefined && actions.length >= o.stopAfter) break;
    const action = chooseRandomAction(state, rng);
    if (!action) break;
    const before = { seat: state.toAct, hour: state.hour };
    const ev = applyAction(state, action) ?? [];
    events.push(...ev);
    actions.push({ action, seat: before.seat, hour: before.hour, how: 'bot' });
    if (o.snapshots && actions.length % o.snapshots === 0) snapshots.push(cloneState(state));
  }
  return { state, events, actions, seats, snapshots, over: isGameOver(state) };
}

export { getValidActions };
