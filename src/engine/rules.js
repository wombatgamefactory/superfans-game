// rules.js - every tuning number of the game (spec R27 CONSTANTS), as plain
// exported objects, one per R27 group.
//
// LOGIC NEVER IMPORTS THESE OBJECTS DIRECTLY. It reads them through
// `getConstants(state)` (state.js), which lays the game's own overrides
// (`config.constants`, simulator `--const.GROUP.NAME=value`) over `RULES`.
// That is what lets a saved game replay under the numbers it was played with.
//
// R28.1-R28.3 (physical-game follow-ups) are work on the printed game, not on the rules, and have no code.
//
// Names are exactly the R27 constant names, grouped as R27.1 .. R27.18. Card
// tables (celebrity values, laurels, swag costs) are derived from the
// generated card data so the two can never disagree; the card data itself is
// in data/cards.js (tools/build-card-data.mjs).

import { CELEBRITY_CARDS, ACHIEVEMENT_CARDS, SWAG_CARDS } from './data/cards.js';

function deepFreeze(v) {
  if (v !== null && typeof v === 'object' && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const k of Object.keys(v)) deepFreeze(v[k]);
  }
  return v;
}

/** R27.1 Game structure. */
export const GAME = {
  HOURS: 5, // R6.1
  PLAYERS_MIN: 2, // R1.1
  PLAYERS_MAX: 5,
  CELEBRITIES_DRAWN_PER_RANK: 2, // R5.4
  HOUR_5_CELEBRITIES: 2, // R6.2
};

/** R27.2 Supplies per player (R2.2). */
export const SUPPLY = {
  CREW_PER_PLAYER: 8,
  HATS_PER_PLAYER: 3,
  BOXES_PER_PLAYER: 1,
  VOLUNTEERS_PER_PLAYER: 6,
};

/** R27.3 Starting values. */
export const START = {
  START_COFFEE: 12, // R5.2, R7.3.1
  START_SELFIES: { green: 1, red: 1, orange: 1 }, // R5.2
  START_VP: 0, // R5.1
  START_ACHIEVEMENTS: 2, // R5.8
  OPENING_CREW_PER_PLAYER: 2, // R5.9
  START_CLUBS: 1, // R5.3
};

/** R27.4 Board and decks. */
export const BOARD = {
  HALL_COUNT: 9, // R3.1
  ROPE_COUNT: 12, // R3.4
  VOLUNTEER_SPACES: 30, // R3.5
  SWAG_MARKET_SLOTS: 5, // R3.7
  CELEBRITY_CARDS: 18, // R2.1
  ACHIEVEMENT_CARDS: 40,
  SWAG_CARDS: 36,
  CLUB_CARDS: 9,
  SWAG_COST_MIX: [20, 9, 7], // R16.9: cards costing 1 / 2 / 3 (a data check)
  ENTRANCE: 'entrance', // R3.2.1 (grid h32)
};

/** R27.5 Queue capacity by player count, per value of variant `queueCapacity` (R3.6). */
export const CAPACITY = {
  QUEUE_CAPACITY: {
    'printed-board': { 2: 4, 3: 6, 4: 7, 5: 7 },
    rulebook: { 2: 5, 3: 7, 4: 8, 5: 8 },
  },
};

/** R27.6 Caps and limits. `null` = no limit. */
export const LIMITS = {
  COFFEE_CAP: 12, // R7.3
  COFFEE_MIN: 0, // R1.3
  SELFIE_LIMIT: null, // R15.1
  VP_LIMIT: null, // R1.5
  ACHIEVEMENT_HAND_SIZE: 2, // R19.1
  ACHIEVER_HAND_BONUS: 1, // R19.1
  CLUB_HAND_LIMIT_MILITIA: 12, // R17.7, only with clubHandLimits = on
  CLUB_HAND_LIMIT_TCG: 10,
};

/** R27.7 Action costs (coffee). */
export const COSTS = {
  COST_MOVE_2: 1, // R10.6
  COST_MOVE_3_CREW: 3, // R10.7
  COST_NEW_NOOB: 4, // R11.1
  COST_UPGRADE: 5, // R12.1
  COST_VOLUNTEER: 2, // R13.1
  COST_TAKE_SELFIE: 1, // R14.1
  COST_SWAG_COFFEE: 0, // R16.1
  COST_PASS: 0, // R18.1
  SELFIE_GAIN_TAKE_SELFIE: 1, // R14.1
};

/** R27.8 Movement and Ushers. */
export const MOVEMENT = {
  MOVE_2_MAX_STEPS: 2, // R10.6
  MOVE_3_MAX_CREW: 3, // R10.7
  USHER_COFFEE_PER_CROSSING: 1, // R10.4
};

/** R27.9 Selfie Exchange rates (R15.2). */
export const EXCHANGE = {
  EXCHANGE_E1: { PAY: 2, GAIN_COFFEE: 1 },
  EXCHANGE_E2: { PAY: 2, GAIN_SELFIES: 1 },
  EXCHANGE_E3: { PAY: 4, GAIN_VP: 2 },
};

/** R27.10 Hour schedule (R5.4, R4.3, R20.5, R6.3). */
export const SCHEDULE = {
  SLOTS: ['1', '2', '3', '4', '5a', '5b'],
  SLOT_HOUR: { 1: 1, 2: 2, 3: 3, 4: 4, '5a': 5, '5b': 5 },
  SLOT_RANK: { 1: 'A', 2: 'A', 3: 'B', 4: 'B', '5a': 'C', '5b': 'C' },
  /** R4.3.2: slots sharing a colour letter share a figure. */
  COLOUR_SLOT: { 1: 'X', 2: 'Y', 3: 'Z', 4: 'X', '5a': 'Y', '5b': 'Z' },
  /** celebrityColours = fixed-slots. */
  FIXED_COLOURS: { X: 'green', Y: 'red', Z: 'orange' },
  /** R5.6: on the board at setup. */
  PLACED_AT_SETUP: ['1', '2', '3'],
  /** R20.5: after the Walk of Hour h, this slot is placed. */
  PLACED_AFTER_HOUR: { 1: '4', 2: '5a', 3: '5b' },
};

/** R27.11 Pass ladder (R18). PASS_SLOT_REWARD is indexed by slot: [unused, slot 1, slot 2, slot 3, slot 4]. */
export const PASS = {
  PASS_SLOTS: 4,
  PASS_FIRST_PASSER_COFFEE: 2, // R18.2.2
  PASS_DISCARD_COFFEE: 2, // R18.2.3
  PASS_DRAW_ACHIEVEMENTS: 1, // R18.2.4 (not in Hour 5)
  PASS_SLOT_REWARD: [0, 0, 1, 2, 3], // R18.4: slot 1 has no reward beyond R18.2
};

/** R27.12 Celebrity Walk. */
export const WALK = {
  WALK_SELFIES_PRIME_POSITION: 1, // R20.3.1
  WALK_SELFIES_PHOTOGRAPHER: 1, // R20.3.2
};

/** R27.13 Celebrity coffee values and scoring tables, by card id (R4.2, R21.2). */
export const CELEBRITIES = {
  CELEBRITIES: Object.fromEntries(
    CELEBRITY_CARDS.map((c) => [c.id, { COFFEE: c.coffee, METHOD: c.scoring.method, VALUES: c.scoring.values.slice() }]),
  ),
  SCORE_IN_ORDER_LENGTH: 7, // R21.3
  COUNT_TOTAL_BANDS: [2, 4], // R21.2: upper bounds of bands 1-2 and 3-4; above is 5+
};

/** R27.14 Achievements. */
export const ACHIEVEMENTS = {
  ACHIEVEMENT_FINAL_MULTIPLIER: 3, // R22.3
  ACHIEVEMENT_OTHER_MULTIPLIER: 1, // R19.4
  ACHIEVEMENT_LAUREL: Object.fromEntries(ACHIEVEMENT_CARDS.map((a) => [a.id, a.laurel])),
  /** Numeric parameters of the count conditions (R27.14 table), read by achievements.js as `$NAME`. */
  ACHIEVEMENT_PARAMS: {
    scoring_03: { PAIR_SIZE: 2, MAX_PAIRS: 5 },
    scoring_05: { MIN_CREW: 2 },
    scoring_13: { MIN_VOLUNTEERS: 2 },
    scoring_16: { MIN_CREW: 3 },
    scoring_17: { MAX_SETS: 3 },
    scoring_20: { MIN_CREW: 2 },
    scoring_22: { MIN_CREW: 2 },
    scoring_26: { MIN_BADGES: 2 },
    scoring_31: { MIN_CREW: 3 },
    scoring_33: { POSITION: 2 },
    scoring_35: { MIN_CREW: 2 },
    scoring_39: { PER_COFFEE: 3 },
    scoring_40: { MIN_COFFEE: 8 },
  },
};

/** R27.15 Swag: cost in selfies of the card's colour, and numeric effect parameters. */
export const SWAG = {
  SWAG_COST: Object.fromEntries(SWAG_CARDS.map((s) => [s.id, s.cost])),
  SWAG_PARAMS: {
    swag_green_04: { MAX_STEPS: 3 },
    swag_green_05: { COFFEE_PER_CREW: 1 },
    swag_green_07: { MAX_STEPS: 2 },
    swag_green_08: { MAX_CREW: 2 },
    swag_green_09: { CREW: 2 },
    swag_red_03: { COFFEE: 3 },
    swag_red_05: { COFFEE_PER_CREW: 1 },
    swag_red_06: { COFFEE_PER_USHER: 2 },
    swag_red_09: { MAX_USHERS: 2 },
    swag_red_10: { COFFEE_PER_VIP: 2 },
    swag_red_11: { COFFEE_PER_CREW: 2, MAX_COFFEE: 6 },
    swag_red_12: { VP_PER_CREW: 1 },
    swag_orange_03: { SELFIES: 3 },
    swag_orange_04: { MULTIPLIER: 1, DRAW: 1 },
    swag_orange_06: { COFFEE_PER_PHOTOGRAPHER: 2 },
    swag_orange_07: { DRAW: 1, HAND_BONUS: 1, DRAW_TWO: 2 },
    swag_orange_08: { VP_PER_SELFIE: 2, MAX_VP: 10 },
    swag_orange_09: { SELFIES_PER_PHOTOGRAPHER: 1 },
    swag_orange_11: { SELFIES: 3 },
    swag_orange_12: { VP_PER_HALL: 3 },
  },
};

/** R27.16 Clubs (R17.6): coffee costs and numbers, by card id. */
export const CLUBS = {
  CLUBS: {
    club_01: { COST_VIP: 5, COST_AAA: 8 },
    club_02: { COST: 1, PLACEMENTS: 1 },
    club_03: { COST: 1, SELFIES: 4 },
    club_04: { COST: 1, VP_PER_SELFIE: 1, MAX_VP: 5, SELFIES: 4 },
    club_05: { COST: 3, DRAW: 3, DISCARD: 3 },
    club_06: { COST: 1, TOKENS: 6, KEEP_PROBABILITY: 0.5, FIXED_KEPT: 3, VP_PER_TOKEN_LOST: 1 },
    club_07: { COST: 0, PAY: 2, GAIN: 3 },
    club_08: { COST: 2, VP_PER_HALL: 2 },
    club_09: { COST: 1, SELFIES: 2 },
  },
};

/** R27.17 Final scoring. */
export const FINAL = {
  FINAL_SELFIES_PER_EXCHANGE: 4, // R22.4
  FINAL_VP_PER_EXCHANGE: 2,
  FINAL_COFFEE_VP: 0, // R22.5
};

/** R27.18 Safety stops (digital only). */
export const SAFETY = {
  MAX_MAIN_ACTIONS_PER_PLAYER_PER_HOUR: 60, // R8.9
  MAX_ENGINE_ACTIONS_PER_GAME: 20000, // R27.18 [chosen v2]
  /**
   * NOT IN THE SPEC - engine-only guard (contract "Safety stops"): the most free
   * conversions one player may make in one window (one turn, one pass-turn, the
   * Squad window, the final window). Strike a Pose (+2 selfies for 1 coffee)
   * and E1 (+1 coffee for 2 selfies) form a loop that changes the state but
   * goes nowhere; without a cap a random bot never leaves it.
   */
  MAX_CONVERSIONS_PER_WINDOW: 40,
};

/**
 * All groups, by name. `config.constants` overrides use these group names:
 * `{ COSTS: { COST_MOVE_2: 2 } }`; the simulator spells it `--const.COSTS.COST_MOVE_2=2`.
 */
export const RULES = deepFreeze({
  GAME,
  SUPPLY,
  START,
  BOARD,
  CAPACITY,
  LIMITS,
  COSTS,
  MOVEMENT,
  EXCHANGE,
  SCHEDULE,
  PASS,
  WALK,
  CELEBRITIES,
  ACHIEVEMENTS,
  SWAG,
  CLUBS,
  FINAL,
  SAFETY,
});

/** The R27 section of each group, for documentation and the simulator's --help. */
export const CONSTANT_GROUP_RULES = Object.freeze({
  GAME: 'R27.1',
  SUPPLY: 'R27.2',
  START: 'R27.3',
  BOARD: 'R27.4',
  CAPACITY: 'R27.5',
  LIMITS: 'R27.6',
  COSTS: 'R27.7',
  MOVEMENT: 'R27.8',
  EXCHANGE: 'R27.9',
  SCHEDULE: 'R27.10',
  PASS: 'R27.11',
  WALK: 'R27.12',
  CELEBRITIES: 'R27.13',
  ACHIEVEMENTS: 'R27.14',
  SWAG: 'R27.15',
  CLUBS: 'R27.16',
  FINAL: 'R27.17',
  SAFETY: 'R27.18',
});
