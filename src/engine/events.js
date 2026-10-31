// events.js - event names, VP sources, and the event sink used while one
// action is applied.
//
// `applyAction` RETURNS the events of that action (and of everything that
// followed from it automatically); the game state carries no log. A log in the
// state would be copied by every cloneState, and search clones constantly.
//
// The sink is a module variable that is open only for the length of one
// applyAction call. Mutators call `emit(record)` freely; when the caller asked
// for no events (SILENT) the record is dropped. Nothing here outlives the call,
// so the engine stays a pure function of (state, action).
//
// Every event is plain JSON: `{ type, seq, ...fields }`, `seq` being the number
// of the applied action it belongs to (state.seq). The fields of every type are
// listed in web-build-notes/engine-contract.md, "Events".
//
// SECRET EVENTS. Events of the types in SECRET_EVENT_TYPES carry a hidden card
// id and `secret: true` with `player` = the only seat allowed to see `card`.
// A UI showing a log to another seat must hide `card` (R23.2).

/** Every event type. Use these constants; never spell an event name inline. */
export const EVENTS = Object.freeze({
  /** An action was applied: { player, action, auto, text }. `auto` true = the engine applied a forced choice (R23.5). */
  ACTION: 'action',
  /** { hour, firstPlayer, celebrities: [slot ids walking this Hour] } */
  HOUR_START: 'hourStart',
  /** { hour, phase } phase = 'coffeeBreak' | 'floor' | 'walk' | 'final' */
  PHASE_START: 'phaseStart',
  /** { hour, player, turn, kind: 'normal' | 'pass' } */
  TURN_START: 'turnStart',
  /** { player, amount (actually gained), lost (over the cap, R7.3), cause, detail } */
  COFFEE_GAIN: 'coffeeGain',
  /** { player, amount, cause } cause = the action type that paid */
  COFFEE_SPEND: 'coffeeSpend',
  /** { player, gain: { green, red, orange }, cause, detail } */
  SELFIE_GAIN: 'selfieGain',
  /** { player, pay: { green, red, orange }, cause } */
  SELFIE_SPEND: 'selfieSpend',
  /** { player, amount, source (VP_SOURCES), detail } - the ONLY event that adds VP. Sum per seat = scoreGame. */
  VP: 'vp',
  /** { player, kind: 'E1'|'E2'|'E3'|'strike-a-pose'|'rare-finds', window, pay, gain } */
  CONVERSION: 'conversion',
  /** { player, crew, hall, badge, stamp, cause } */
  CREW_PLACED: 'crewPlaced',
  /** { player (who moved it), owner, crew, from, to, path, ushersCrossed, ushersPaid, jump, cause } */
  CREW_MOVED: 'crewMoved',
  /** { player, crew, hall, from, to, cause } badges */
  CREW_UPGRADED: 'crewUpgraded',
  /** { player, space, role, cause } */
  VOLUNTEER_PLACED: 'volunteerPlaced',
  /** { player, from, to, role, cause } */
  VOLUNTEER_MOVED: 'volunteerMoved',
  /** { player, hour, order (1 = first to pass), first: boolean } */
  PASSED: 'passed',
  /** { player, slot, reward: 'coffee' | 'vp', amount } */
  PASS_REWARD: 'passReward',
  /** SECRET. { player, card, cause, secret: true } */
  ACHIEVEMENT_DRAWN: 'achievementDrawn',
  /** { player, card, count, laurel, multiplier, vp, choice, when: 'pass'|'swag'|'final', tripled } (public, R19.7) */
  ACHIEVEMENT_SCORED: 'achievementScored',
  /** SECRET. { player, card, cause, secret: true } (unscored discard, R19.7) */
  ACHIEVEMENT_DISCARDED: 'achievementDiscarded',
  /** { deck: 'achievement' | 'swag', size } */
  DECK_RESHUFFLED: 'deckReshuffled',
  /** { player, card, colour, cost, slot } */
  SWAG_BOUGHT: 'swagBought',
  /** { slot, card (null when nothing could be dealt) } */
  SWAG_DEALT: 'swagDealt',
  /** { player, club, option, coffee } */
  CLUB_USED: 'clubUsed',
  /** { celebrity (card id), slot, colour, figure (hall), marker (hall) } */
  CELEBRITY_PLACED: 'celebrityPlaced',
  /** { celebrity, slot, colour, hall, step, of } a walk step (R20.2) */
  CELEBRITY_ENTERED: 'celebrityEntered',
  /** { celebrity, slot, colour, hall, method, hour, payouts: [{ player, crew, position, badge, vp }], totals: [vp per seat] } */
  CELEBRITY_SCORED: 'celebrityScored',
  /** { celebrity, slot } figure and marker off the board (R20.5) */
  CELEBRITY_REMOVED: 'celebrityRemoved',
  /** { from, to } the First Player marker moved (R6.3) */
  FIRST_PLAYER_MOVED: 'firstPlayerMoved',
  /** { kind: 'main-actions' | 'conversions' | 'engine-actions', player, limit } (R8.9, R27.18) */
  SAFETY_STOP: 'safetyStop',
  /** { reason: 'complete' | 'engine-action-cap', turnCapped, scores: scoreGame(state) } */
  GAME_END: 'gameEnd',
});

/** The event types whose `card` only `player` may see. */
export const SECRET_EVENT_TYPES = Object.freeze([EVENTS.ACHIEVEMENT_DRAWN, EVENTS.ACHIEVEMENT_DISCARDED]);

/**
 * R22.7 - every VP gain is tagged with exactly one of these sources. The
 * `detail` of the VP event says more (celebrity method, achievement card and
 * multiplier, pass slot, swag or club card).
 */
export const VP_SOURCES = Object.freeze([
  'celebrity', // R21: destination scoring; detail { card, slot, hall, method, hour, crew, position, badge }
  'achievement-pass', // R18.2.3: scored on passing; detail { card, count, multiplier, hour }
  'achievement-final', // R22.3: last card(s); detail { card, count, multiplier (3 = tripled) }
  'achievement-swag', // Much Better swag_orange_04; detail { card, count, multiplier }
  'pass-slot', // R18.4: detail { slot, hour }
  'exchange', // E3 by choice, in any window; detail { window }
  'final-selfies', // R22.4: automatic E3 at the very end; detail { selfies, exchanges }
  'swag', // Swag effects that give VP (Velvet Rope, Influencer, Look at me!); detail { card }
  'club', // Club powers that give VP (Otaku Alliance, Retro Gaming Guild); detail { club }
  'militia', // Meeple Militia tokens not kept (R17.6.6); detail { club, tokens }
]);

/** Causes used by COFFEE_GAIN. */
export const COFFEE_CAUSES = Object.freeze([
  'coffee-break', 'usher', 'first-pass', 'achievement-discard', 'pass-slot', 'exchange', 'swag', 'club',
]);

/** Causes used by SELFIE_GAIN. */
export const SELFIE_CAUSES = Object.freeze([
  'take-selfie', 'walk-prime', 'walk-photographer', 'exchange', 'strike-a-pose', 'rare-finds', 'swag', 'club', 'militia',
]);

let sink = null;
let sequence = 0;

/** Opens the sink. `collect` false means every emit is dropped (fast path). */
export function openEventSink(collect, seq) {
  sink = collect ? [] : null;
  sequence = seq;
}

/** Closes the sink and returns what was collected (an array, or null). */
export function closeEventSink() {
  const out = sink;
  sink = null;
  return out;
}

/** Tells the sink which applied action the following events belong to. */
export function setEventSeq(seq) {
  sequence = seq;
}

/** Whether events are being collected. Use to skip building a costly record. */
export function eventsOn() {
  return sink !== null;
}

/**
 * Appends one event. `record` must be plain JSON with a string `type` from
 * EVENTS. The engine stamps `seq`.
 */
export function emit(record) {
  if (sink === null) return;
  record.seq = sequence;
  sink.push(record);
}
