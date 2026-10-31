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
//
// The action returned is always one of getValidActions(state). Easy and
// Medium are synchronous. Hard is mapped to Medium until task T15 adds the
// search bot; T15 will make it asynchronous, and callers should already ask
// isAsyncLevel(level) before choosing how to call.
//
// Bots read only what a human in that seat could see: the heuristic bot runs
// its lookahead on blindCopy(state, seat, rng) and never reads other seats'
// Achievement hands (heuristicBot.js, "HIDDEN INFORMATION").

import { chooseHeuristicAction } from './heuristicBot.js';
import { chooseRandomAction } from './randomBot.js';
import { rngNext } from '../engine/index.js';

/** The levels on offer, weakest first. The setup screen and simulator read this. */
export const BOT_LEVELS = Object.freeze(['easy', 'medium', 'hard']);

/** Labels and one-line descriptions for the setup screen (British English). */
export const BOT_LEVEL_INFO = Object.freeze({
  easy: Object.freeze({ label: 'Easy', description: 'Knows the rules and chases the celebrity in front of it, but plays loosely and makes mistakes.' }),
  medium: Object.freeze({ label: 'Medium', description: 'Plans for every celebrity on the schedule, times its pass and keeps its best Achievement for the final triple.' }),
  hard: Object.freeze({ label: 'Hard', description: 'For now plays as Medium; a thinking bot is on the way.' }),
});

/** Hard maps to Medium until T15 replaces it. */
const LEVEL_TO_HEURISTIC = Object.freeze({ easy: 'easy', medium: 'medium', hard: 'medium' });

/** Whether a level's chooseAction returns a Promise. False for every level until T15. */
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
