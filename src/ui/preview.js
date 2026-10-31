// preview.js - "what would happen if" by trying it on a copy.
//
// The UI never works out the consequence of an action itself. It clones the
// state, asks the engine to apply the action to the clone, and reads what came
// back. The real state is never touched.

import { cloneState, applyAction, queue, hallName } from '../engine/index.js';

/**
 * Applies `action` to a copy of `state`.
 * @returns {{ state: object, events: object[] } | null} the copy afterwards and the events, or null if the engine refused
 */
export function simulate(state, action) {
  const copy = cloneState(state);
  try {
    const events = applyAction(copy, action) ?? [];
    return { state: copy, events };
  } catch {
    return null;
  }
}

/**
 * Where a Crew would stand in the queue of the hall it moves to, and what the
 * move would earn, read from a trial run: { position, ushers, coffee }.
 */
export function previewMove(state, action) {
  const sim = simulate(state, action);
  if (!sim) return null;
  const moved = sim.events.find((e) => e.type === 'crewMoved' && e.crew === action.crew);
  const crew = sim.state.crew.find((c) => c.id === action.crew);
  const position = crew && crew.hall ? queue(sim.state, crew.hall).findIndex((c) => c.id === crew.id) + 1 : null;
  const usherCoffee = sim.events.filter((e) => e.type === 'coffeeGain' && e.cause === 'usher').reduce((n, e) => n + e.amount, 0);
  return { position, ushers: moved ? moved.ushersCrossed ?? 0 : 0, usherCoffee, hall: crew ? crew.hall : null };
}

/** The VP an Achievement in hand would score right now, read from a trial run of scoring it. */
export function previewAchievementVp(state, card) {
  const sim = simulate(state, { type: 'scoreAchievement', card });
  if (!sim) return null;
  return sim.events.filter((e) => e.type === 'achievementScored').reduce((n, e) => n + e.vp, 0);
}

/** A short sentence for the hall a trial move reaches, for tooltips. */
export function hallPhrase(id) {
  return hallName(id);
}
