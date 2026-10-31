// game.js - createGame and replayGame: the two ways to obtain a game state.

import { createInitialState } from './state.js';
import { advanceToFirstDecision, applyAction, SILENT } from './actions.js';

/**
 * Starts a game and runs it forward to its first decision.
 *
 * A game is a pure function of (config, seed, list of actions): the same
 * three always give the same states.
 *
 * @param {object} config
 * @param {Array<{ name?: string, colour?: string }>} [config.players] 2 to 5 entries; seat = index (Note 6)
 * @param {number} [config.playerCount] 2 to 5; used when `players` is not given
 * @param {object} [config.variants] `{ name: value }` overrides of variants.js (R26)
 * @param {object} [config.constants] overrides of rules.js by group, e.g. `{ COSTS: { COST_MOVE_2: 2 } }` (R27)
 * @param {{ s: number }} [config.rngStart] an RNG to start from (as recorded by getGameConfig); takes the place of the seed
 * @param {object} [options]
 * @param {number|string} [options.seed] the game's seed (or `config.seed`)
 * @param {{ s: number }} [options.rng] an RNG made by makeRng, copied, used in place of the seed
 * @param {boolean} [options.events] true: return `{ state, events }` with the events of setup to the first decision
 * @returns {object} the game state, plain JSON, waiting at its first decision (or `{ state, events }`)
 */
export function createGame(config, options = {}) {
  const state = createInitialState(config, options);
  const events = advanceToFirstDecision(state, options.events === true);
  return options.events === true ? { state, events } : state;
}

/** Whether the game has ended. When true, getValidActions returns [] and `state.toAct` is null. */
export function isGameOver(state) {
  return state.phase === 'ended';
}

/** The seat that must decide now (may differ from the active player, see activePlayer), or null when the game is over. */
export function toAct(state) {
  return state.toAct;
}

/**
 * Rebuilds a state from its recipe: createGame, then every action in order.
 * Throws at the first action the engine refuses, naming its position.
 *
 * @param {object} config the config the game was created with (getGameConfig gives one)
 * @param {object[]} actions the actions the players chose (forced actions the engine applied itself are NOT in this list)
 * @param {object} [options] as for createGame
 */
export function replayGame(config, actions, options = {}) {
  const state = createGame(config, { ...options, events: false });
  for (let i = 0; i < actions.length; i++) {
    try {
      applyAction(state, actions[i], SILENT);
    } catch (err) {
      const wrapped = new Error(`Replay stopped at action ${i + 1} of ${actions.length}: ${err.message}`);
      wrapped.code = err.code ?? null;
      wrapped.reason = err.reason ?? null;
      wrapped.index = i;
      throw wrapped;
    }
  }
  return state;
}
