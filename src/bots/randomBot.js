// randomBot.js - picks uniformly among the legal actions.
//
// The baseline every other bot is measured against, and the workhorse of the
// contract and smoke tests. It knows nothing about the game: everything it
// does comes from getValidActions, which is the point. If this bot is ever
// refused, the engine's own list and its own mutators disagree.
//
// Pure: it reads the state, never changes it, and draws only from its own RNG
// (never state.rng), so a bot's choices never change the game's shuffles.

import { getValidActions, rngPick } from '../engine/index.js';

/**
 * Chooses one legal action for `state.toAct`.
 * @param {object} state the game state (not changed)
 * @param {{ s: number }} rng the bot's own stream, never `state.rng`
 * @returns {object} one of getValidActions(state)
 */
export function chooseRandomAction(state, rng) {
  const actions = getValidActions(state);
  if (actions.length === 0) throw new Error('randomBot: there is no legal action (the game is over).');
  return rngPick(rng, actions);
}

/** The bot object the bot driver and simulator use: `{ id, chooseAction(state, { rng }) }`. */
export const randomBot = Object.freeze({
  id: 'random',
  label: 'Random',
  chooseAction(state, { rng }) {
    return chooseRandomAction(state, rng);
  },
});
