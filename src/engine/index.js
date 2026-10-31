// index.js - the public face of the engine.
//
// Bots, the simulator, the UI and the tests import from THIS file only.
// web-build-notes/engine-contract.md describes every export. Engine files
// import each other in one direction:
//
//   data/cards, rng, events -> rules -> variants -> board -> state -> queries
//     -> achievements -> scoring -> legality -> actions -> game -> index
//
// The engine is 100% pure: no DOM, no console, no storage, no clock, no
// unseeded randomness. State is plain JSON; the RNG is threaded through it.

// Games
export { createGame, isGameOver, toAct, replayGame } from './game.js';
export { applyAction, SILENT, MUTATORS, ENGINE_LIMITS } from './actions.js';
export {
  getValidActions,
  getBlockReason,
  getStructuralBlockReason,
  describeAction,
  describeDecision,
  frameLabel,
  actionKey,
  actionFamilies,
  windowOf,
  clubOf,
  ACTIONS,
  FRAMES,
  FRAME_ACCEPTS,
  MAIN_ACTION_TYPES,
  CONVERSION_TYPES,
  EFFECT_STEP_TYPES,
  STOP_ACTION_TYPES,
} from './legality.js';
export { scoreGame, destinationPayouts } from './scoring.js';

// State as a value
export {
  SCHEMA_VERSION,
  RULES_ID,
  getConstants,
  topFrame,
  cloneState,
  hashState,
  getGameConfig,
  serialiseState,
  deserialiseState,
  blindCopy,
  openingOrder,
  createInitialState,
} from './state.js';

// Reads
export * from './queries.js';
export { countAchievement, achievementValue, achievementSpec, ACHIEVEMENT_SPECS, ACHIEVEMENT_METRICS } from './achievements.js';

// Tables
export { EVENTS, VP_SOURCES, SECRET_EVENT_TYPES, COFFEE_CAUSES, SELFIE_CAUSES } from './events.js';
export * from './variants.js';
export * from './rules.js';
export * from './board.js';
export { CELEBRITY_CARDS, ACHIEVEMENT_CARDS, SWAG_CARDS, CLUB_CARDS, PASS_CARD, CARD_DATA_SOURCE } from './data/cards.js';
export { makeRng, cloneRng, forkRng, rngNext, rngInt, rngPick, shuffle, hashSeed } from './rng.js';
