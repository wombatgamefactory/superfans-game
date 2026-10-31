// state.js - the shape of the game state and everything that treats the state
// as a value: build it, copy it, hash it, save it, hide what is hidden.
//
// THE STATE IS PLAIN JSON. Every value must survive
// JSON.parse(JSON.stringify(state)): objects, arrays, strings, finite numbers,
// booleans and null. Never undefined, never a function, a Date, a Map, a Set
// or a class instance. Undo, saved games, bug reports, replay, blind copies
// for search and the Web Worker hand-off all depend on it. The field list is
// in web-build-notes/engine-contract.md, "State shape".
//
// `createInitialState` builds the table as it is after setup (R5), before
// anybody has decided anything. The public `createGame` (game.js) then runs the
// engine forward to the first decision.

import { RULES } from './rules.js';
import { resolveVariants, UNIMPLEMENTED_VARIANT_VALUES } from './variants.js';
import { makeRng, cloneRng, forkRng, shuffle, rngInt } from './rng.js';
import { CELEBRITY_CARDS, ACHIEVEMENT_CARDS, SWAG_CARDS, CLUB_CARDS } from './data/cards.js';
import { ENTRANCE, VOLUNTEER_SPACE_IDS, COLOURS, DEFAULT_PLAYER_COLOURS } from './board.js';
import { VP_SOURCES } from './events.js';

export const SCHEMA_VERSION = 1;

/** Identifies the rules data in play; a save made against another is refused. */
export const RULES_ID = 'superfans-spec-v2';

// ---------------------------------------------------------------------------
// Constants per game
// ---------------------------------------------------------------------------

const constantsCache = new Map();

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function kindOf(v) {
  if (Array.isArray(v)) return 'an array';
  if (v === null) return 'null';
  if (typeof v === 'object') return 'an object';
  return `a ${typeof v}`;
}

/** An override must be of the same kind as its default; arrays keep their length. */
function checkConstantKind(base, value, where) {
  if (kindOf(base) !== kindOf(value)) {
    throw new Error(`Constant "${where}" must be ${kindOf(base)} like its default in src/engine/rules.js; ${JSON.stringify(value)} is ${kindOf(value)}.`);
  }
  if (typeof base === 'number' && !Number.isFinite(value)) {
    throw new Error(`Constant "${where}" must be a finite number; ${String(value)} is not.`);
  }
  if (Array.isArray(base)) {
    if (value.length !== base.length) {
      throw new Error(`Constant "${where}" must be an array of ${base.length} entries like its default; ${value.length} were given.`);
    }
    for (let i = 0; i < base.length; i++) checkConstantKind(base[i], value[i], `${where}[${i}]`);
  }
}

/** Deep copy of `base` with `patch` laid over it. Unknown keys and wrong kinds are errors. */
function mergeConstants(base, patch, path) {
  const out = Array.isArray(base) ? base.slice() : { ...base };
  for (const key of Object.keys(patch)) {
    const where = path ? `${path}.${key}` : key;
    if (!Object.prototype.hasOwnProperty.call(base, key)) {
      throw new Error(`Unknown constant "${where}". Check the spelling against src/engine/rules.js.`);
    }
    const b = base[key];
    const p = patch[key];
    if (isPlainObject(b) && isPlainObject(p)) out[key] = mergeConstants(b, p, where);
    else {
      checkConstantKind(b, p, where);
      out[key] = p;
    }
  }
  return out;
}

/**
 * The constants in force for this game: `RULES`, or `RULES` with the game's
 * `constantOverrides` laid over it. EVERY logic file reads tuning numbers
 * through this function.
 */
export function getConstants(state) {
  const key = state.constantsKey;
  if (key === null) return RULES;
  let merged = constantsCache.get(key);
  if (!merged) {
    merged = deepFreeze(mergeConstants(RULES, state.constantOverrides, ''));
    constantsCache.set(key, merged);
  }
  return merged;
}

// ---------------------------------------------------------------------------
// The decision stack. `state.stack` holds pending decisions; the LAST element
// is the one being asked now and `state.toAct` is always its `player`. Only
// these three functions touch the stack, so the two can never disagree.
// ---------------------------------------------------------------------------

/** The pending decision, or null. */
export function topFrame(state) {
  const n = state.stack.length;
  return n === 0 ? null : state.stack[n - 1];
}

/** Adds a decision on top. `frame` is plain JSON with `kind` and `player`. */
export function pushFrame(state, frame) {
  state.stack.push(frame);
  state.toAct = frame.player;
}

/** Removes the decision on top. */
export function popFrame(state) {
  state.stack.pop();
  const top = topFrame(state);
  state.toAct = top === null ? null : top.player;
}

// ---------------------------------------------------------------------------
// Building the initial state
// ---------------------------------------------------------------------------

function deepFreeze(v) {
  if (v !== null && typeof v === 'object' && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const k of Object.keys(v)) deepFreeze(v[k]);
  }
  return v;
}

function jsonClone(v) {
  return JSON.parse(JSON.stringify(v));
}

/** A fresh `{ green, red, orange }` count object. */
export function selfieCounts(green = 0, red = 0, orange = 0) {
  return { green, red, orange };
}

function normalisePlayers(config, K) {
  let list = config.players;
  if (!Array.isArray(list)) {
    const n = config.playerCount;
    if (!Number.isInteger(n)) throw new Error('createGame needs config.players (an array) or config.playerCount (2 to 5).');
    list = Array.from({ length: n }, () => ({}));
  }
  const { PLAYERS_MIN, PLAYERS_MAX } = K.GAME;
  if (list.length < PLAYERS_MIN || list.length > PLAYERS_MAX) {
    throw new Error(`Superfans is for ${PLAYERS_MIN} to ${PLAYERS_MAX} players; ${list.length} were given.`);
  }
  return list.map((p, i) => ({
    name: p && typeof p.name === 'string' && p.name.length > 0 ? p.name : `Player ${i + 1}`,
    colour: p && typeof p.colour === 'string' && p.colour.length > 0 ? p.colour : DEFAULT_PLAYER_COLOURS[i],
  }));
}

// R2.3: the After Party cards and the workbook-only components (Gifts, Trophies, Clock tokens) are cut; nothing here stores them.
// R23.1: everything is public (board, queues, Volunteers, coffee, selfies, VP, supply, Club, pass state, the schedule with its
// colours R4.3.3, the market, deck sizes, scored Achievements) except R23.2's hidden cards.
function newPlayer(seat, entry, K) {
  const vpBySource = {};
  for (const s of VP_SOURCES) vpBySource[s] = 0;
  const sel = K.START.START_SELFIES;
  return {
    seat,
    name: entry.name,
    colour: entry.colour,
    coffee: K.START.START_COFFEE, // R5.2
    selfies: selfieCounts(sel.green, sel.red, sel.orange), // R5.2
    vp: K.START.START_VP, // R5.1
    vpBySource, // R22.7
    hats: K.SUPPLY.HATS_PER_PLAYER, // in supply (R2.2)
    boxes: K.SUPPLY.BOXES_PER_PLAYER,
    volunteers: K.SUPPLY.VOLUNTEERS_PER_PLAYER, // in supply
    club: null, // R5.3
    clubUsedThisHour: false, // R17.5, R6.4
    hand: [], // R19.1: Achievement card ids, SECRET (R23.2)
    handSize: K.LIMITS.ACHIEVEMENT_HAND_SIZE, // R19.1 (+1 per Achiever under `hand-size`)
    achieversUsed: 0, // R16.8 swag_orange_07 Achiever cards used: each lets the hand hold one more than handSize says under `draw-two-keep-one`
    passSlot: 0, // R18: 0 = not passed this Hour, else slot 1..4
    mainActionsThisHour: 0, // R8.9 (Pass excluded)
  };
}

/** R5.9 - the seats in reverse turn order from the first player's right, the first player last. */
export function openingOrder(first, n) {
  const out = [];
  for (let i = 1; i <= n; i++) out.push((first - i + n * 2) % n);
  return out;
}

/**
 * Builds the table after setup (R5). All randomness of setup is drawn here,
 * from SIX sub-streams forked from the game RNG in a fixed order, one per
 * purpose, so switching one setup draw off (e.g. `clubs` = `off`) never
 * changes another (contract "RNG"):
 *   1 clubs (R5.3), 2 celebrity decks A, B, C (R5.4), 3 colours (R4.3.1),
 *   4 Swag deck (R5.7), 5 Achievement deck (R5.8), 6 first player (R5.9).
 * After setup the game stream itself is used for reshuffles (R16.5, R19.8)
 * and the Militia roll (R17.6.6).
 *
 * Deck convention: the next card to draw is the LAST element (`deck.pop()`).
 */
export function createInitialState(config, options = {}) {
  if (config === null || typeof config !== 'object') throw new Error('createGame needs a config object.');

  const variants = resolveVariants(config.variants ?? {});
  for (const name of Object.keys(UNIMPLEMENTED_VARIANT_VALUES)) {
    if (UNIMPLEMENTED_VARIANT_VALUES[name].includes(variants[name])) {
      throw new Error(`Variant "${name}" = ${JSON.stringify(variants[name])} is not implemented in this build yet.`);
    }
  }

  let constantOverrides = null;
  let constantsKey = null;
  if (config.constants !== undefined && config.constants !== null) {
    if (!isPlainObject(config.constants)) throw new Error('config.constants must be an object keyed by group name.');
    if (Object.keys(config.constants).length > 0) {
      constantOverrides = jsonClone(config.constants);
      mergeConstants(RULES, constantOverrides, ''); // validates; throws on a typo or a wrong kind
      constantsKey = JSON.stringify(constantOverrides);
      deepFreeze(constantOverrides);
    }
  }

  const seed = options.seed ?? config.seed ?? null;
  let rng;
  if (options.rng) rng = cloneRng(options.rng);
  else if (config.rngStart) rng = cloneRng(config.rngStart);
  else if (seed !== null) rng = makeRng(seed);
  else throw new Error('createGame needs a seed: createGame(config, { seed }) with a number or a string.');
  const rngStart = cloneRng(rng);

  const state = {
    schemaVersion: SCHEMA_VERSION,
    config: null,
    variants: deepFreeze(variants),
    constantOverrides,
    constantsKey,
    rng,
    seq: 0,
    nextStamp: 1,
    hour: 1,
    phase: 'setup',
    step: null,
    stepIndex: 0,
    startPlayer: 0,
    firstPlayer: 0,
    turn: { number: 0, player: null, kind: null },
    stack: [],
    toAct: null,
    openingQueue: [], // R5.9.1 fallback: seats that still place an opening Crew by hand (empty under `overfill`)
    players: [],
    crew: [],
    volunteers: {},
    schedule: [],
    swag: { deck: [], market: [], discard: [] },
    achievements: { deck: [], discard: [] },
    hourState: { firstPasser: null, passOrder: [] },
    flags: { turnCapped: false, endReason: null },
    final: null,
  };
  const K = getConstants(state);
  const entries = normalisePlayers(config, K);
  const n = entries.length;
  state.players = entries.map((e, i) => newPlayer(i, e, K));
  state.config = deepFreeze({
    playerCount: n,
    players: entries.map((e) => ({ name: e.name, colour: e.colour })),
    seed: seed === null ? null : seed,
    rngStart,
    rulesId: RULES_ID,
  });

  // Crew: CREW_PER_PLAYER per seat, all N00b in supply (R5.2). Ids `c<seat>-<n>`, n from 1.
  for (let s = 0; s < n; s++) {
    for (let i = 1; i <= K.SUPPLY.CREW_PER_PLAYER; i++) {
      state.crew.push({ id: `c${s}-${i}`, owner: s, hall: null, badge: 'N00b', stamp: null });
    }
  }
  for (const id of VOLUNTEER_SPACE_IDS) state.volunteers[id] = null;

  const rClubs = forkRng(rng);
  const rCelebs = forkRng(rng);
  const rColours = forkRng(rng);
  const rSwag = forkRng(rng);
  const rAch = forkRng(rng);
  const rFirst = forkRng(rng);

  // R5.3 - one Club each (or none under clubs = off). The rest are never stored.
  if (variants.clubs === 'random') {
    const clubs = shuffle(rClubs, CLUB_CARDS.map((c) => c.id));
    for (const p of state.players) p.club = clubs.pop();
  }

  // R5.4 - shuffle the rank decks A, B, C (in that order) and draw 2 from each.
  const drawn = {};
  for (const rank of ['A', 'B', 'C']) {
    const deck = shuffle(rCelebs, CELEBRITY_CARDS.filter((c) => c.rank === rank).map((c) => c.id));
    drawn[rank] = [];
    for (let i = 0; i < K.GAME.CELEBRITIES_DRAWN_PER_RANK; i++) drawn[rank].push(deck.pop());
  }
  const bySlot = { 1: drawn.A[0], 2: drawn.A[1], 3: drawn.B[0], 4: drawn.B[1], '5a': drawn.C[0], '5b': drawn.C[1] };

  // R5.5, R4.3.1 - colour letters X, Y, Z dealt green / red / orange. R4.3.5: because Hour 4, 5a and 5b reuse X, Y, Z,
  // each colour appears exactly twice across the six slots whatever the deal. R4.3.3: all six colours are public from the start.
  let letters;
  if (variants.celebrityColours === 'random-slots') {
    const deal = shuffle(rColours, COLOURS.slice());
    letters = { X: deal[0], Y: deal[1], Z: deal[2] };
  } else {
    letters = { ...K.SCHEDULE.FIXED_COLOURS };
  }
  const cardById = new Map(CELEBRITY_CARDS.map((c) => [c.id, c]));
  state.schedule = K.SCHEDULE.SLOTS.map((slot) => {
    const card = cardById.get(bySlot[slot]);
    const onBoard = K.SCHEDULE.PLACED_AT_SETUP.includes(slot); // R5.6
    return {
      slot,
      hour: K.SCHEDULE.SLOT_HOUR[slot],
      card: card.id,
      colour: letters[K.SCHEDULE.COLOUR_SLOT[slot]], // R4.3.2
      status: onBoard ? 'onBoard' : 'waiting', // 'waiting' | 'onBoard' | 'done'
      figure: onBoard ? card.start : null,
      marker: onBoard ? card.destination : null,
    };
  });

  // R5.7 - Swag deck and market.
  state.swag.deck = shuffle(rSwag, SWAG_CARDS.map((s) => s.id));
  for (let i = 0; i < K.BOARD.SWAG_MARKET_SLOTS; i++) state.swag.market.push(state.swag.deck.pop() ?? null);

  // R5.8 - Achievement deck; deal START_ACHIEVEMENTS to each, one card at a time from seat 0.
  state.achievements.deck = shuffle(rAch, ACHIEVEMENT_CARDS.map((a) => a.id));
  for (let r = 0; r < K.START.START_ACHIEVEMENTS; r++) {
    for (const p of state.players) p.hand.push(state.achievements.deck.pop());
  }

  // R5.9 - first player, then the opening in reverse turn order.
  const first = variants.firstPlayer === 'seat-0' ? 0 : rngInt(rFirst, n);
  state.startPlayer = first;
  state.firstPlayer = first;
  const entranceCapacity = K.CAPACITY.QUEUE_CAPACITY[variants.queueCapacity][n];
  let inEntrance = 0;
  for (const seat of openingOrder(first, n)) {
    for (let k = 0; k < K.START.OPENING_CREW_PER_PLAYER; k++) {
      if (variants.fivePlayerOpening === 'fallback' && inEntrance >= entranceCapacity) {
        // R5.9.1 `fallback`: the Entrance is full, so this Crew is placed by its owner as a New N00b would be (R11.2).
        state.openingQueue.push(seat);
        continue;
      }
      // R5.9.1 `overfill`: every opening Crew goes into the Entrance, even over capacity.
      const crew = state.crew.find((c) => c.owner === seat && c.hall === null);
      crew.hall = ENTRANCE;
      crew.stamp = state.nextStamp++;
      inEntrance++;
    }
  }

  state.phase = 'setup';
  state.step = 'opening';
  if (state.openingQueue.length === 0) {
    state.phase = 'coffeeBreak';
    state.step = 'start';
  }
  return state;
}

// ---------------------------------------------------------------------------
// Copying, hashing, saving
// ---------------------------------------------------------------------------

function deepClone(v) {
  if (v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) {
    const out = new Array(v.length);
    for (let i = 0; i < v.length; i++) out[i] = deepClone(v[i]);
    return out;
  }
  const out = {};
  for (const k in v) out[k] = deepClone(v[k]);
  return out;
}

/**
 * A fast, independent copy of a state (not a JSON round trip). `config`,
 * `variants` and `constantOverrides` are frozen and shared; the rest is copied.
 */
export function cloneState(state) {
  const out = {};
  for (const k in state) {
    if (k === 'config' || k === 'variants' || k === 'constantOverrides') out[k] = state[k];
    else out[k] = deepClone(state[k]);
  }
  return out;
}

let h1 = 0;
let h2 = 0;

function addInt(n) {
  h1 = Math.imul(h1 ^ n, 0x01000193);
  h2 = Math.imul(h2 ^ n, 0x85ebca6b);
  h2 ^= h2 >>> 13;
}

function addString(s) {
  for (let i = 0; i < s.length; i++) addInt(s.charCodeAt(i));
  addInt(0x1f);
}

function addValue(v) {
  if (v === null) {
    addInt(0x6e);
    return;
  }
  switch (typeof v) {
    case 'number':
      if (Number.isInteger(v) && v >= -2147483648 && v <= 2147483647) {
        addInt(0x23);
        addInt(v | 0);
      } else addString(String(v));
      return;
    case 'string':
      addInt(0x22);
      addString(v);
      return;
    case 'boolean':
      addInt(v ? 0x74 : 0x66);
      return;
    case 'object':
      if (Array.isArray(v)) {
        addInt(0x5b);
        for (let i = 0; i < v.length; i++) addValue(v[i]);
        addInt(0x5d);
      } else {
        addInt(0x7b);
        for (const k in v) {
          addString(k);
          addValue(v[k]);
        }
        addInt(0x7d);
      }
      return;
    default:
      throw new Error(`hashState: the state holds a ${typeof v}, which is not plain JSON.`);
  }
}

/**
 * A 16-character hex fingerprint of the WHOLE state (including RNG and hidden
 * deck orders), except `config` (names, seed text) which cannot affect play.
 * Stable across a JSON round trip and across cloneState.
 */
export function hashState(state) {
  h1 = 0x811c9dc5 | 0;
  h2 = 0x2f0b4a13 | 0;
  for (const k in state) {
    if (k === 'config' || k === 'constantOverrides') continue;
    addString(k);
    addValue(state[k]);
  }
  return (h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0');
}

/**
 * The config that recreates this game from scratch: with the actions the
 * players took, `replayGame(getGameConfig(state), actions)` rebuilds the state.
 */
export function getGameConfig(state) {
  const c = state.config;
  const config = {
    players: c.players.map((p) => ({ name: p.name, colour: p.colour })),
    seed: c.seed,
    rngStart: { s: c.rngStart.s },
    variants: { ...state.variants },
  };
  if (state.constantOverrides !== null) config.constants = jsonClone(state.constantOverrides);
  return config;
}

/** The state as JSON text. */
export function serialiseState(state) {
  return JSON.stringify(state);
}

/** A state from JSON text made by serialiseState. Refuses another schema or rules id. */
export function deserialiseState(text) {
  const state = JSON.parse(text);
  if (state === null || typeof state !== 'object' || state.schemaVersion !== SCHEMA_VERSION) {
    throw new Error(`This save is not a Superfans state of schema version ${SCHEMA_VERSION}.`);
  }
  if (!state.config || state.config.rulesId !== RULES_ID) {
    throw new Error(`This save was made under rules "${state.config && state.config.rulesId}"; this build plays "${RULES_ID}".`);
  }
  return state;
}

// ---------------------------------------------------------------------------
// Hidden information (R23.2)
// ---------------------------------------------------------------------------
//
// Hidden from a seat: other players' Achievement hands, other players'
// UNSCORED Achievement discards (R19.7), and the ORDER of the Achievement and
// Swag decks. Everything else in the state is public. Celebrity and Club cards
// left out of the game are never stored. The Swag discard is public (every
// card in it was face up in the market).

/**
 * A copy of `state` as `seat` could imagine it: everything that seat cannot
 * know is re-drawn at random from the cards it has not seen, and the game RNG
 * is replaced. What `seat` knows stays exactly as it is.
 *
 * R23.3: a bot decides using only what a player in its seat could see; the hotseat UI hides the hand the same way.
 * A bot that looks ahead (the Hard search bot) MUST search on blind copies,
 * never on the real state.
 *
 * @param {object} state
 * @param {number|null} seat the viewer; null = a spectator who sees no hand
 * @param {{ s: number }} rng the caller's own RNG (a bot's); it is advanced
 */
export function blindCopy(state, seat, rng) {
  const copy = cloneState(state);
  const ach = copy.achievements;
  const pool = ach.deck.slice();
  for (const p of copy.players) if (p.seat !== seat) pool.push(...p.hand);
  for (const d of ach.discard) if (!d.scored && d.owner !== seat) pool.push(d.card);
  // An Achiever choice waiting for another seat (draw-two-keep-one) holds that seat's two drawn cards.
  const aside = copy.stack.filter((f) => f.kind === 'achieverKeep' && f.player !== seat);
  for (const f of aside) pool.push(...f.cards);
  shuffle(rng, pool);
  for (const p of copy.players) {
    if (p.seat === seat) continue;
    p.hand = p.hand.map(() => pool.pop());
  }
  for (const d of ach.discard) {
    if (!d.scored && d.owner !== seat) d.card = pool.pop();
  }
  for (const f of aside) f.cards = f.cards.map(() => pool.pop());
  // Longbox Legion remembers the last card its owner discarded (to keep the discards in one order): another seat must not see it.
  for (const f of copy.stack) if (f.kind === 'effect' && f.player !== seat && f.data && typeof f.data.last === 'string') f.data.last = '';
  ach.deck = pool;
  shuffle(rng, copy.swag.deck);
  copy.rng = forkRng(rng);
  return copy;
}
