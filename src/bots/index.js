// index.js - the bot registry: one entry point for the UI and the simulator.
//
//   chooseAction(state, level, rng, opts = {}) -> action
//
//   state   the real game state; never changed. The bot decides for state.toAct.
//   level   one of BOT_LEVELS: 'easy' | 'medium' | 'hard'.
//   rng     the bot's OWN random stream: a function returning [0, 1), or an
//           engine RNG `{ s }` (makeRng / forkRng). Never the game's state.rng.
//   opts    { jitter = 0 } - a small random tiebreak added to every score
//           (use it in simulations so identical bots do not mirror each
//           other); { weights } - heuristic weight overrides (tuning only).
//           Hard only (mctsBot.js, T15): { iterations } playouts per TURN in
//           place of a clock; { timeBudgetMs, now } thinking time per TURN
//           with an injected clock () => ms; { mcts } setting overrides.
//
// The action returned is always one of getValidActions(state). EVERY level is
// synchronous (isAsyncLevel is false for all three). Hard with no clock and no
// `iterations` uses its default allowance MCTS_SETTINGS.hardPlayouts, so the
// simulator and tests call it exactly like Medium, deterministically. In the
// browser the UI runs Hard in a Web Worker (bot-worker.js) with a clock and
// a time budget, so the page never blocks; that wrapper is the Promise.
//
// Bots read only what a human in that seat could see: the heuristic bot runs
// its lookahead on blindCopy(state, seat, rng) and never reads other seats'
// Achievement hands (heuristicBot.js, "HIDDEN INFORMATION").

import { chooseHeuristicAction } from './heuristicBot.js';
import { chooseHardAction } from './mctsBot.js';
import { chooseRandomAction } from './randomBot.js';
import { rngNext } from '../engine/index.js';

/** The levels on offer, weakest first. The setup screen and simulator read this. */
export const BOT_LEVELS = Object.freeze(['easy', 'medium', 'hard']);

/** Labels and one-line descriptions for the setup screen (British English). */
export const BOT_LEVEL_INFO = Object.freeze({
  easy: Object.freeze({ label: 'Easy', description: 'Knows the rules and chases the celebrity in front of it, but plays loosely and makes mistakes.' }),
  medium: Object.freeze({ label: 'Medium', description: 'Plans for every celebrity on the schedule, times its pass and keeps its best Achievement for the final triple.' }),
  hard: Object.freeze({ label: 'Hard', description: 'Plays each turn forward many times to see how its best ideas work out before it moves. About a second a turn.' }),
});

/** The heuristic level behind easy and medium (hard is the search, mctsBot.js). */
const LEVEL_TO_HEURISTIC = Object.freeze({ easy: 'easy', medium: 'medium' });

/** Whether a level's chooseAction returns a Promise. False for every level: Hard is synchronous too (the browser wraps it in a Web Worker). */
export function isAsyncLevel(level) {
  checkLevel(level);
  return false;
}

function checkLevel(level) {
  if (!BOT_LEVELS.includes(level)) {
    throw new Error(`Unknown bot level "${level}". The levels are: ${BOT_LEVELS.join(', ')}.`);
  }
}

function toRand(rng) {
  if (typeof rng === 'function') return rng;
  if (rng && typeof rng.s === 'number') return () => rngNext(rng);
  throw new Error('chooseAction: rng must be a function returning [0, 1) or an engine RNG { s }.');
}

/**
 * One legal action for state.toAct at the given level.
 * @param {object} state the game state (not changed)
 * @param {'easy'|'medium'|'hard'} level
 * @param {Function|{s:number}} rng the bot's own random stream
 * @param {{ jitter?: number, weights?: object }} [opts]
 * @returns {object} one of getValidActions(state)
 */
export function chooseAction(state, level, rng, opts = {}) {
  checkLevel(level);
  if (level === 'hard') {
    if (!(typeof rng === 'function' || (rng && typeof rng.s === 'number'))) toRand(rng); // same error as the other levels
    return chooseHardAction(state, { ...opts, rng });
  }
  const rand = toRand(rng);
  return chooseHeuristicAction(state, { ...opts, level: LEVEL_TO_HEURISTIC[level], rng: rand });
}

/**
 * A bot object in the engine contract's shape (`{ id, chooseAction(state, { rng }) }`, section 13),
 * for drivers written against randomBot. 'random' is accepted too.
 */
export function getBot(level, opts = {}) {
  if (level === 'random') {
    return Object.freeze({
      id: 'random',
      label: 'Random',
      chooseAction(state, { rng }) {
        const r = toRand(rng);
        return chooseRandomAction(state, { s: Math.floor(r() * 4294967296) | 0 });
      },
    });
  }
  checkLevel(level);
  return Object.freeze({
    id: level,
    label: BOT_LEVEL_INFO[level].label,
    chooseAction(state, { rng, ...rest } = {}) {
      return chooseAction(state, level, rng, { ...opts, ...rest });
    },
  });
}

export { scoreValidActions, rolloutPolicy, HEURISTIC_WEIGHTS, LEVEL_SETTINGS } from './heuristicBot.js';
export { MCTS_SETTINGS, search as searchHard } from './mctsBot.js';
