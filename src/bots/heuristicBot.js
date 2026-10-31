// heuristicBot.js - the heuristic bot: Medium as it stands, Easy as a shallower
// and noisier version of the same evaluator, and a cheap `rolloutPolicy` for
// the Hard bot's playouts (task T15).
//
// HOW IT PLAYS
//
// Every decision is one atomic action from getValidActions(state). The bot
// tries each legal action on a copy of the game, then scores the position it
// leads to with one evaluation function, in one currency: VP-equivalents
// ("what this position is worth in final VP"). It plays the action whose
// position scores best. Nothing is remembered between decisions: the plan is
// worked out again from the state every time, so the same policy can be
// called on cloned states in any order (tree search, the simulator).
//
// The evaluation of a position, for each seat (`evaluateAll`):
//
//   vp                 VP already scored.
//   celebrity forecast for every celebrity not yet done (this Hour's, the
//                      ones already on the board, and the scheduled ones -
//                      the schedule and routes are public, R4.3.3): the VP
//                      its destination would pay the seat with the queue as
//                      it stands now, times a certainty weight that falls
//                      with the Hours until it walks (`forecastWeight`) and
//                      rises as players pass this Hour (`lockInWeight`, the
//                      queues lock when the last player passes, R18.5).
//   walk selfies       the same celebrities' routes: a selfie for Prime
//                      Position and for the Photographer in every hall the
//                      figure will enter (R20.3), at the same certainty.
//   coffee             `coffeeValue` per coffee that can be carried past the
//                      next Coffee Break (12 - next Hour's income, R7.3). On
//                      the Floor, coffee above that is "use it or lose it" and
//                      worth only `excessCoffeeValue`, so spending it is
//                      nearly free and the bot spends down before it passes;
//                      after passing the excess is worth nothing. This is the
//                      "queue position versus coffee" trade-off.
//                      After the Hour 5 Floor coffee is worth nothing (except
//                      to the Selfie Stick Squad, R17.6.9).
//   selfies            `selfieValue` each up to a soft cap (they buy Swag),
//                      then the E3 floor of 0.5 VP; a bonus for each Swag card
//                      in the market the seat can afford in its colour (so
//                      the bot collects the colours the market wants).
//   board presence     Crew on the board, VIP/AAA badges and Volunteers, worth
//                      a little per Hour left (later celebrities, Ushers'
//                      coffee, Security's queue priority).
//   pass ladder        for a seat that has passed: the slot rewards (R18.4)
//                      it should collect from the turns the others still have
//                      (estimated from their coffee and selfies).
//   club ready         a main-action Club power still unused this Hour.
//   Achievement hand   ONLY for the bot's own seat (hands are secret, R23.2):
//                      each card's count x laurel on the board now. In Hours
//                      1-4, before passing, the coming pass is already counted
//                      (best card x `handPassScore`, plus a new card drawn), so
//                      passing is never attractive just for "cashing in"; after
//                      passing the best card counts most. In Hour 5 the hand is worth sum + 2 x best: one
//                      card is scored at the pass and the one kept is tripled
//                      at the end (R22.3), so the bot keeps the card it can
//                      grow and builds the board towards it. A card drawn
//                      during the lookahead is unknown and worth `newCardValue`.
//
// The score of a position for the bot = own value - `opponentWeight` x the
// opponents' value (the one opponent at two players; half best, half average
// with more). So pushing a rival out of Prime Position counts too.
//
// Follow-up choices (a Swag effect, the steps of Move 1 Crew x3, the
// Achievement to score when passing) are completed greedily inside the
// lookahead (`completeFollowUps`), so buying Teleport is scored by the best
// place to teleport to, and passing by the best Achievement to score.
//
// CONVERSIONS (Exchange, Strike a Pose, Rare Finds) are free and repeatable in
// a window (R15.5). A conversion is played only when it improves the position
// by more than `conversionMargin` on its own, or when it makes possible a main
// action better than any available now (e.g. E2 for the missing selfie of a
// Swag card). The bot makes at most `maxConversionsPerWindow` in one frame,
// and in the Squad and final windows it ends the window as soon as no
// conversion clears the margin, so it never runs into the engine's safety cap
// (SAFETY.MAX_CONVERSIONS_PER_WINDOW = 40).
//
// EASY is the same evaluator with: only this Hour's celebrity forecast, no
// opponent term, no pass-ladder estimate, no follow-up completion, no
// conversion planning, and Gaussian noise on every score (`noise`).
//
// THE ANTI-LIVELOCK GUARDS (web-board-game skill, "AI Bots")
//   (a) the bot always returns an action taken from getValidActions(state);
//   (b) a lookahead the engine refuses (should never happen) scores far below
//       everything, so the action is used only when nothing else exists;
//   (c) after `mainActionSoftCap` main actions in one Hour, every main action
//       but Pass is penalised more for each further one (Usher loops: two own
//       Ushers make Move 2 pay for itself, R8.9);
//   (d) conversions are bounded per frame (above).
//
// HIDDEN INFORMATION. Every lookahead runs on `blindCopy(state, me, rng)`:
// other seats' hands, unscored discards and both deck orders are re-dealt at
// random from the bot's OWN stream. Opponents' hands are never read; drawn
// cards are valued at a constant. The game's RNG is never read or advanced.
//
// PURITY. No DOM, no console, no clock, no storage, no randomness but the
// `rng` handed in. The state passed in is never changed.

import {
  getValidActions,
  applyAction,
  SILENT,
  cloneState,
  blindCopy,
  topFrame,
  getConstants,
  destinationPayouts,
  primeOwner,
  photographerOwner,
  hourIncome,
  selfieTotal,
  achievementValue,
  volunteersOf,
  clubCost,
  hashSeed,
  rngNext,
  actionKey,
  CELEBRITY_CARDS,
  CONVERSION_TYPES,
  HALL_IDS,
} from '../engine/index.js';

// ---------------------------------------------------------------------------
// Tuning constants
// ---------------------------------------------------------------------------
//
// ONE object, values in VP-equivalents unless the comment says otherwise.
// `options.weights` overrides any entry for one bot (A/B tuning, archetypes
// in the simulator). Where a value was tuned, the comment gives the duel that
// justified it: "A/B 54%" = the changed Medium won 54% of 2-player games
// against the baseline Medium, seats alternated, jitter 0.3 (see
// web-build-notes/bot-notes-v1.md for the method and sigma).

export const HEURISTIC_WEIGHTS = Object.freeze({
  // --- coffee and selfies
  /** Value of one coffee that can be carried past the next Coffee Break (set by hand; not A/B-tuned yet). */
  coffeeValue: 0.8,
  /** Coffee on the Floor above what can be carried past the next Coffee Break (use it or lose it). A/B: 0 vs 0.2 gave 48.7% (308 games, sigma 2.8): neutral, kept. Added after T12 measured 75% of coffee income lost to the cap; now 24%. */
  excessCoffeeValue: 0.2,
  /** Coffee left to the Selfie Stick Squad at the end (Strike a Pose: 1 coffee -> 2 selfies -> 1 VP at E3). */
  coffeeFinalSquad: 0.9,
  /** Value of each selfie up to `selfieSoftCap` (they buy Swag), by Hour 1..5. */
  selfieValue: [0, 0.7, 0.7, 0.65, 0.6, 0.55],
  /** Selfies beyond this many are worth only the E3 floor. */
  selfieSoftCap: 8,
  /** E3 / final rate: 4 selfies = 2 VP (R15.2, R22.4). */
  selfieFloor: 0.5,
  /** Each Swag card in the market the seat can afford now (counts up to 2). */
  swagAfford: 0.35,

  // --- celebrities
  /** Certainty of a celebrity's forecast payout by Hours until it walks (0 = this Hour). */
  forecastWeight: [0.7, 0.35, 0.2, 0.12, 0.08, 0.05],
  /** This Hour's weight moves this share of the way to 1 as the other players pass. */
  lockInWeight: 0.6,
  /** A walk selfie (Prime Position / Photographer in an entered hall) counts this fraction of its value. */
  walkSelfieWeight: 1.0,

  // --- board presence, each x (Hours left / 5)
  /** A Crew on the board (future celebrities, Achievement counts). */
  crewOnBoard: 1.2,
  /** A VIP or AAA badge (queue priority, by-badge scoring). */
  badge: 1.5,
  /** An Usher (coffee when your Crew cross it). */
  usher: 1.0,
  /** A Security volunteer (priority in its hall's queue). */
  security: 0.8,
  /** A Photographer (selfies from every walk into its hall beyond the forecast). */
  photographer: 0.6,

  // --- passing
  /** Share of the estimated pass-ladder rewards counted for a seat that has passed. */
  ladder: 0.1, // A/B: 0.5 won 28% vs 0, 0.25 won 42%, 0.1 won 47% (308 games each, sigma 2.8); 0.1 kept: neutral against Medium, better against Easy (81% v 79%)
  /** Coffee an opponent spends per turn on average (estimates its remaining turns). */
  avgActionCost: 2.0,
  /** Selfies an opponent spends per extra turn (Swag). */
  selfiesPerTurn: 3,
  /** Upper bound on the turns counted for the ladder. */
  maxLadderTurns: 8,
  /** A main-action Club power still unused this Hour (affordable). */
  clubReady: 1.0,

  // --- the Achievement hand (own seat only)
  /** Hours 1-4: the best card (scored at the next pass). */
  handBest: 0.85,
  /** Hours 1-4 before passing: the card the coming pass will score (the board may still change). */
  handPassScore: 0.9,
  /** Hours 1-4: each other card. */
  handOther: 0.4,
  /** Hour 5 before passing: (sum + 2 x best) x this. */
  handHour5: 0.85,
  /** Hour 5 after passing (the card waiting to be tripled): x this. */
  handHeld: 0.9,
  /** A card drawn during the lookahead (unknown): its expected value at x1. */
  newCardValue: 4,

  // --- the opponents
  /** Weight of the opponents' value in the bot's score. */
  opponentWeight: 0.8,

  // --- search shape
  /** Follow-up frames completed greedily in a lookahead, per action. */
  maxFollowUpSteps: 6,
  /** Per action group (type, Swag card, Club option) only the best few by first look are completed. */
  followTopPerGroup: 3,
  /** A conversion must improve the score by this much (stops pointless conversions and loops). */
  conversionMargin: 0.15,
  /** At most this many conversions in one frame (the engine allows 40). */
  maxConversionsPerWindow: 8,
  /** Newly enabled actions examined per conversion. */
  enableMaxCandidates: 8,
  /** After this many main actions in one Hour, main actions other than Pass are penalised. */
  mainActionSoftCap: 30,
  /** Penalty per main action beyond the soft cap. */
  overCapPenalty: 0.5,
});

/** What each level switches on. `hard` is mapped to medium in index.js until T15. */
export const LEVEL_SETTINGS = Object.freeze({
  easy: Object.freeze({
    /** Standard deviation of the noise added to every score (VP). */
    noise: 1.5,
    /** Celebrities forecast: only this Hour's. */
    forecastHours: 1,
    followUps: false,
    conversionPlanning: false,
    ladder: false,
    opponents: false,
  }),
  medium: Object.freeze({
    noise: 0,
    forecastHours: 6,
    followUps: true,
    conversionPlanning: true,
    ladder: true,
    opponents: true,
  }),
});

const CONVERSIONS = new Set(CONVERSION_TYPES);
const FOLLOW_UP_FRAMES = new Set(['effect', 'moveSteps', 'passAchievement', 'achieverKeep', 'discardToLimit', 'openingPlacement']);
const MAIN_ACTION_CLUBS = new Set(['club_01', 'club_02', 'club_03', 'club_04', 'club_05', 'club_06', 'club_08']);
const CARD_BY_ID = Object.fromEntries(CELEBRITY_CARDS.map((c) => [c.id, c]));
const FAIL_SCORE = -1e6;

// ---------------------------------------------------------------------------
// Randomness: accepts a function () => [0,1) or an engine RNG { s }
// ---------------------------------------------------------------------------

function toRand(rng) {
  if (typeof rng === 'function') return rng;
  if (rng && typeof rng.s === 'number') return () => rngNext(rng);
  throw new Error('heuristicBot: rng must be a function returning [0, 1) or an engine RNG { s }.');
}

function engineRngFrom(rand) {
  return { s: hashSeed(`heuristic-bot:${Math.floor(rand() * 4294967296)}`) };
}

/** Roughly normal, mean 0, sd 1 (sum of four uniforms). */
function gaussian(rand) {
  return (rand() + rand() + rand() + rand() - 2) * 1.732;
}

export function resolveWeights(overrides) {
  if (!overrides) return HEURISTIC_WEIGHTS;
  for (const k of Object.keys(overrides)) {
    if (!(k in HEURISTIC_WEIGHTS)) throw new Error(`heuristicBot: unknown weight "${k}".`);
  }
  return { ...HEURISTIC_WEIGHTS, ...overrides };
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

function makeContext(state, me, settings, W) {
  return { me, settings, W, known: new Set(state.players[me].hand) };
}

/** Hours still to play including the current one if its Walk has not happened. */
function hoursLeft(st) {
  if (st.phase === 'final' || st.phase === 'ended') return 0;
  return 5 - st.hour + (st.phase === 'walk' ? 0 : 1);
}

/** R20.2 - the halls a celebrity still enters (its figure stands on the start hall until it walks). */
function hallsToEnter(entry, card) {
  const route = card.route;
  const at = entry.figure === null ? 0 : Math.max(0, route.indexOf(entry.figure));
  return route.slice(at + 1);
}

/** Forecast VP and walk selfies per seat from every celebrity still to score. */
function forecast(st, ctx, vpOut, selfieOut) {
  const W = ctx.W;
  const n = st.players.length;
  const passed = st.players.filter((p) => p.passSlot > 0).length;
  for (const e of st.schedule) {
    if (e.status === 'done') continue;
    const d = e.hour - st.hour;
    if (d < 0 || d >= ctx.settings.forecastHours) continue;
    let w = W.forecastWeight[Math.min(d, W.forecastWeight.length - 1)];
    if (d === 0) {
      if (st.phase === 'walk' || st.phase === 'final') w = 1;
      else if (st.phase === 'floor') w += (1 - w) * W.lockInWeight * (passed / n);
    }
    const card = CARD_BY_ID[e.card];
    const dest = e.marker ?? card.destination;
    for (const pay of destinationPayouts(st, e.card, dest)) vpOut[pay.player] += w * pay.vp;
    const ws = w * W.walkSelfieWeight;
    for (const hall of hallsToEnter(e, card)) {
      const prime = primeOwner(st, hall);
      if (prime !== null) selfieOut[prime] += ws;
      const ph = photographerOwner(st, hall);
      if (ph !== null) selfieOut[ph] += ws;
    }
  }
}

function coffeeValue(st, p, ctx) {
  const W = ctx.W;
  const K = getConstants(st);
  const cap = K.LIMITS.COFFEE_CAP;
  const c = p.coffee;
  const squad = p.club === 'club_09';
  const h = st.hour;
  // What can be carried past the next Coffee Break without being burnt by the cap (R7.3).
  const keep = h >= 5 ? 0 : Math.max(0, cap - hourIncome(st, h + 1));
  const carry = () => {
    if (h >= 5) return squad ? c * W.coffeeFinalSquad : 0;
    return Math.min(c, keep) * W.coffeeValue;
  };
  // On the Floor before passing: coffee above `keep` must be spent this Hour or
  // be lost, so it is worth only what a spare action buys (`excessCoffeeValue`).
  const open = () => {
    if (h >= 5 && squad) return c * W.coffeeFinalSquad;
    return Math.min(c, keep) * W.coffeeValue + Math.max(0, c - keep) * W.excessCoffeeValue;
  };
  switch (st.phase) {
    case 'setup':
    case 'coffeeBreak': {
      // Income of this Hour still to come: anything above cap - income is burnt (R7.3).
      const kept = Math.min(c, Math.max(0, cap - hourIncome(st, h)));
      return kept * W.coffeeValue;
    }
    case 'floor':
      return p.passSlot === 0 ? open() : carry();
    case 'walk':
      return carry();
    case 'final':
      return squad ? c * W.coffeeFinalSquad : 0;
    default:
      return 0;
  }
}

function selfieValue(st, p, ctx, expectedWalk) {
  const W = ctx.W;
  const total = selfieTotal(p.selfies);
  if (st.phase === 'final') return Math.floor(total / 4) * 2 + (total % 4) * 0.05;
  const sv = W.selfieValue[Math.min(st.hour, 5)];
  const t = total + expectedWalk;
  let v = Math.min(t, W.selfieSoftCap) * sv + Math.max(0, t - W.selfieSoftCap) * W.selfieFloor;
  if (st.phase === 'floor' || st.phase === 'coffeeBreak' || st.phase === 'setup') {
    const K = getConstants(st);
    let afford = 0;
    for (const id of st.swag.market) {
      if (id === null) continue;
      const colour = id.startsWith('swag_green') ? 'green' : id.startsWith('swag_red') ? 'red' : 'orange';
      if (p.selfies[colour] >= K.SWAG.SWAG_COST[id]) afford++;
    }
    v += Math.min(afford, 2) * W.swagAfford;
  }
  return v;
}

function boardValue(st, p, ctx, frac) {
  if (frac <= 0) return 0;
  const W = ctx.W;
  let crew = 0;
  let badges = 0;
  for (const c of st.crew) {
    if (c.owner !== p.seat || c.hall === null) continue;
    crew++;
    if (c.badge !== 'N00b') badges++;
  }
  let v = crew * W.crewOnBoard + badges * W.badge;
  for (const s of volunteersOf(st, p.seat)) {
    v += s.role === 'usher' ? W.usher : s.role === 'security' ? W.security : W.photographer;
  }
  return v * frac;
}

/**
 * Turns an opponent who has not passed is still expected to take this Hour:
 * one, plus the coffee it would burn by passing now (above what it can carry
 * past the next Coffee Break, R7.3) spent at `avgActionCost` a turn, plus its
 * Swag purchases. A rational player keeps playing only while it has coffee to
 * burn, so this is what a seat that passes can count on for the ladder.
 */
function estimatedTurns(st, p, W, keep) {
  if (p.passSlot > 0) return 0;
  return 1 + Math.max(0, p.coffee - keep) / W.avgActionCost + selfieTotal(p.selfies) / W.selfiesPerTurn;
}

function ladderValue(st, p, ctx) {
  if (!ctx.settings.ladder || st.phase !== 'floor' || p.passSlot === 0) return 0;
  const W = ctx.W;
  const K = getConstants(st);
  const keep = st.hour >= 5 ? 0 : Math.max(0, K.LIMITS.COFFEE_CAP - hourIncome(st, st.hour + 1));
  let turns = 0;
  for (const o of st.players) if (o.seat !== p.seat) turns = Math.max(turns, estimatedTurns(st, o, W, keep));
  turns = Math.min(turns, W.maxLadderTurns);
  const rewards = K.PASS.PASS_SLOT_REWARD;
  const top = K.PASS.PASS_SLOTS;
  let sum = 0;
  let slot = p.passSlot;
  for (let k = 0; k < Math.floor(turns); k++) {
    slot = Math.min(slot + 1, top);
    sum += rewards[slot];
  }
  const frac = turns - Math.floor(turns);
  if (frac > 0) sum += frac * rewards[Math.min(slot + 1, top)];
  return sum * W.ladder;
}

function clubReadyValue(st, p, ctx) {
  if (st.phase !== 'floor' || p.passSlot > 0 || p.clubUsedThisHour || !MAIN_ACTION_CLUBS.has(p.club)) return 0;
  return p.coffee >= clubCost(st, p.club, 'vip') ? ctx.W.clubReady : 0;
}

function handValue(st, p, ctx) {
  const W = ctx.W;
  const vals = p.hand.map((card) => (ctx.known.has(card) ? achievementValue(st, p.seat, card) : W.newCardValue));
  if (vals.length === 0) return 0;
  let sum = 0;
  let best = 0;
  for (const v of vals) {
    sum += v;
    if (v > best) best = v;
  }
  const finalShape = sum + (vals.length >= 2 ? 2 * best : 0); // one scored at the pass, the best kept and tripled
  if (st.phase === 'final') return sum + 2 * best;
  if (st.hour < 5) {
    // Held into a later Hour: the best card is likely scored at the next pass.
    const held = (b, rest) => W.handBest * b + W.handOther * rest;
    if (p.passSlot > 0 || st.phase === 'walk') return held(best, sum - best);
    // Not passed yet this Hour: the pass is coming anyway, so count its result
    // now (best card scored, one card drawn). Passing then gains nothing by
    // itself and the bot passes when its coffee and position say so.
    const rest = sum - best;
    const restBest = Math.max(vals.length >= 2 ? Math.max(...vals.filter((v, i) => i !== vals.indexOf(best))) : 0, W.newCardValue);
    return W.handPassScore * best + held(restBest, rest + W.newCardValue - restBest);
  }
  if (p.passSlot > 0 || st.phase === 'walk') return (sum + 2 * best) * W.handHeld;
  return finalShape * W.handHour5;
}

/** The value of the position for every seat, in VP-equivalents. */
export function evaluateAll(st, ctx) {
  const n = st.players.length;
  const out = new Array(n).fill(0);
  if (st.phase === 'ended') {
    for (const p of st.players) out[p.seat] = p.vp;
    return out;
  }
  const vp = new Array(n).fill(0);
  const walk = new Array(n).fill(0);
  if (st.phase !== 'final') forecast(st, ctx, vp, walk);
  const frac = hoursLeft(st) / 5;
  for (const p of st.players) {
    let v = p.vp + vp[p.seat];
    v += coffeeValue(st, p, ctx);
    v += selfieValue(st, p, ctx, walk[p.seat]);
    v += boardValue(st, p, ctx, frac);
    v += ladderValue(st, p, ctx);
    v += clubReadyValue(st, p, ctx);
    if (p.seat === ctx.me) v += handValue(st, p, ctx);
    out[p.seat] = v;
  }
  return out;
}

/** The bot's score of a position: own value minus the weighted opponents. */
export function evaluatePosition(st, ctx) {
  const vals = evaluateAll(st, ctx);
  const me = ctx.me;
  if (!ctx.settings.opponents || vals.length < 2) return vals[me];
  let best = -Infinity;
  let sum = 0;
  for (let i = 0; i < vals.length; i++) {
    if (i === me) continue;
    sum += vals[i];
    if (vals[i] > best) best = vals[i];
  }
  const others = vals.length - 1;
  const opp = others === 1 ? best : 0.5 * best + 0.5 * (sum / others);
  return vals[me] - ctx.W.opponentWeight * opp;
}

// ---------------------------------------------------------------------------
// Lookahead
// ---------------------------------------------------------------------------

function tryApply(st, action) {
  const c = cloneState(st);
  try {
    applyAction(c, action, SILENT);
  } catch {
    return null; // guard (b): never expected - the action came from getValidActions
  }
  return c;
}

function pendingFollowUp(st, me) {
  if (st.phase === 'ended' || st.toAct !== me) return false;
  const f = topFrame(st);
  return f !== null && FOLLOW_UP_FRAMES.has(f.kind);
}

/** Greedily answers the bot's own follow-up frames (Swag effect steps, move steps, the pass Achievement). Mutates `st`. */
function completeFollowUps(st, ctx) {
  for (let step = 0; step < ctx.W.maxFollowUpSteps; step++) {
    if (!pendingFollowUp(st, ctx.me)) return st;
    const acts = getValidActions(st);
    if (acts.length === 0) return st;
    let bestState = null;
    let bestScore = -Infinity;
    for (const a of acts) {
      const after = tryApply(st, a);
      if (after === null) continue;
      const s = evaluatePosition(after, ctx);
      if (s > bestScore) {
        bestScore = s;
        bestState = after;
      }
    }
    if (bestState === null) return st;
    st = bestState;
  }
  return st;
}

function groupKey(a) {
  if (a.type === 'buySwag') return `buySwag:${a.card}`;
  if (a.type === 'clubPower') return `clubPower:${a.option}`;
  return a.type;
}

/**
 * Scores every legal action for `state.toAct`.
 * @param {object} state the real game state (not changed)
 * @param {object} [options] `{ level = 'medium', rng, weights }` - rng is the bot's own stream (function or { s })
 * @returns {{ action: object, score: number }[]} in getValidActions order (no noise or jitter added)
 */
export function scoreValidActions(state, options = {}) {
  const level = options.level === 'easy' ? 'easy' : 'medium';
  const settings = LEVEL_SETTINGS[level];
  const W = resolveWeights(options.weights);
  const rand = toRand(options.rng ?? { s: 1 });
  const actions = getValidActions(state);
  if (actions.length === 0) return [];
  const me = state.toAct;
  const ctx = makeContext(state, me, settings, W);
  const blind = blindCopy(state, me, engineRngFrom(rand));
  const base = evaluatePosition(blind, ctx);
  const frame = topFrame(state);

  const rows = actions.map((action) => {
    const after = tryApply(blind, action);
    return {
      action,
      after,
      conv: CONVERSIONS.has(action.type),
      score: after === null ? FAIL_SCORE : evaluatePosition(after, ctx),
    };
  });

  // Follow-ups: complete the best few of each group whose lookahead stops at one of the bot's own follow-up frames.
  if (settings.followUps) {
    const groups = new Map();
    for (const r of rows) {
      if (r.after === null || !pendingFollowUp(r.after, me)) continue;
      const k = groupKey(r.action);
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(r);
    }
    for (const list of groups.values()) {
      list.sort((a, b) => b.score - a.score);
      for (const r of list.slice(0, W.followTopPerGroup)) {
        r.after = completeFollowUps(r.after, ctx);
        r.score = evaluatePosition(r.after, ctx);
      }
    }
  }

  // Conversions: only when they pay for themselves or open a better main action.
  const nonConv = rows.filter((r) => !r.conv);
  const bestNon = nonConv.length ? Math.max(...nonConv.map((r) => r.score)) : base;
  const convRows = rows.filter((r) => r.conv);
  if (convRows.length) {
    const capped = frame !== null && (frame.conversions ?? 0) >= W.maxConversionsPerWindow;
    const baseKeys = settings.conversionPlanning ? new Set(actions.map(actionKey)) : null;
    for (const r of convRows) {
      if (capped || r.after === null) {
        r.score = Math.min(r.score, bestNon) - 1000;
        continue;
      }
      let effective = bestNon + (r.score - base);
      if (baseKeys !== null && r.after.toAct === me) {
        const fresh = getValidActions(r.after).filter((a) => !CONVERSIONS.has(a.type) && !baseKeys.has(actionKey(a)));
        for (const a of fresh.slice(0, W.enableMaxCandidates)) {
          let next = tryApply(r.after, a);
          if (next === null) continue;
          if (settings.followUps) next = completeFollowUps(next, ctx);
          const s = evaluatePosition(next, ctx);
          if (s > effective) effective = s;
        }
      }
      r.score = effective - W.conversionMargin;
    }
  }

  // Guard (c): a long run of main actions in one Hour (Usher loops).
  const p = state.players[me];
  if (frame !== null && frame.kind === 'turn' && p.mainActionsThisHour >= W.mainActionSoftCap) {
    const over = p.mainActionsThisHour - W.mainActionSoftCap + 1;
    for (const r of rows) if (!r.conv && r.action.type !== 'pass') r.score -= over * W.overCapPenalty;
  }

  return rows.map((r) => ({ action: r.action, score: r.score }));
}

/**
 * The heuristic bot's choice for `state.toAct`.
 * @param {object} state the real game state (not changed)
 * @param {object} [options] `{ level: 'easy'|'medium', rng, jitter = 0, weights }`
 * @returns {object} one of getValidActions(state)
 */
export function chooseHeuristicAction(state, options = {}) {
  const rand = toRand(options.rng ?? { s: 1 });
  const level = options.level === 'easy' ? 'easy' : 'medium';
  const scored = scoreValidActions(state, { ...options, level, rng: rand });
  if (scored.length === 0) throw new Error('heuristicBot: there is no legal action (the game is over).');
  const noise = LEVEL_SETTINGS[level].noise;
  const jitter = Number(options.jitter) || 0;
  let best = scored[0];
  let bestScore = -Infinity;
  for (const r of scored) {
    let s = r.score;
    if (noise > 0) s += noise * gaussian(rand);
    if (jitter > 0) s += jitter * rand();
    if (s > bestScore) {
      bestScore = s;
      best = r;
    }
  }
  return best.action;
}

// ---------------------------------------------------------------------------
// The cheap rollout policy (for the Hard bot's playouts, T15)
// ---------------------------------------------------------------------------
//
// No copies of the state and no lookahead: each legal action gets a quick
// feature score from the state as it is, plus noise, and the best is played.
// About 10x cheaper than Medium. It never makes a conversion except to end a
// window, moves Crew towards the destinations of the celebrities on the
// board, takes selfies and Swag while it has coffee to spare, passes when its
// coffee is down to what it can carry, takes VP on the ladder, and scores the
// Achievement worth most (keeping the better one for the triple in Hour 5).

/** Halls worth standing in now: destinations of the celebrities on the board, this Hour's most. */
function hallPull(st) {
  const pull = {};
  for (const h of HALL_IDS) pull[h] = 0;
  for (const e of st.schedule) {
    if (e.status !== 'onBoard' || e.marker === null) continue;
    pull[e.marker] += e.hour === st.hour ? 3 : 1;
  }
  return pull;
}

function rolloutFeature(st, a, me, pull) {
  const p = st.players[me];
  const K = getConstants(st);
  const cap = K.LIMITS.COFFEE_CAP;
  const carryLimit = st.hour >= 5 ? 0 : Math.max(0, cap - hourIncome(st, st.hour + 1));
  const crewHall = (id) => {
    const c = st.crew.find((x) => x.id === id);
    return c ? c.hall : null;
  };
  switch (a.type) {
    case 'move2':
    case 'move3':
    case 'moveStep':
    case 'effectMove': {
      const from = crewHall(a.crew);
      return (pull[a.to] ?? 0) - (from ? pull[from] ?? 0 : 0) - (a.type === 'move3' ? 0.8 : 0.2);
    }
    case 'effectMovePair':
      return 2 * ((pull[a.to] ?? 0) - (pull[crewHall(a.crew)] ?? 0));
    case 'newNoob':
    case 'placeOpeningCrew':
    case 'effectPlaceCrew':
      return st.hour <= 3 ? 1 + (pull[a.hall] ?? 0) * 0.3 : 0.2;
    case 'upgrade':
      return st.hour <= 4 ? 0.9 : 0.1;
    case 'volunteer':
      return st.hour <= 3 ? 0.5 : 0;
    case 'takeSelfie':
      return 0.6;
    case 'buySwag':
      return 1.2;
    case 'clubPower':
      return 1.5;
    case 'pass':
      return p.coffee <= carryLimit + 1 ? 2.5 : -1;
    case 'passReward':
      return a.reward === 'vp' ? 1 : 0.5;
    case 'scoreAchievement':
    case 'discardAchievement': {
      const v = achievementValue(st, me, a.card);
      if (a.type === 'discardAchievement') return 1.5 - v;
      if (st.hour === 5 && p.hand.length >= 2) {
        const other = Math.max(...p.hand.filter((c) => c !== a.card).map((c) => achievementValue(st, me, c)));
        return v > other ? -v : v; // keep the better card for the triple
      }
      return v;
    }
    case 'endConversions':
      return 0;
    case 'stopMoving':
    case 'effectDone':
      return 0;
    default:
      if (CONVERSIONS.has(a.type)) return -50;
      return 0.1;
  }
}

/**
 * A cheap policy for playouts: no lookahead, feature scores plus noise.
 * @param {object} state the game state (not changed)
 * @param {Function|{s:number}} rng the bot's own stream
 * @returns {object} one of getValidActions(state)
 */
export function rolloutPolicy(state, rng) {
  const rand = toRand(rng);
  const actions = getValidActions(state);
  if (actions.length === 0) throw new Error('rolloutPolicy: there is no legal action (the game is over).');
  const me = state.toAct;
  const pull = hallPull(state);
  let best = actions[0];
  let bestScore = -Infinity;
  for (const a of actions) {
    const s = rolloutFeature(state, a, me, pull) + rand() * 0.8;
    if (s > bestScore) {
      bestScore = s;
      best = a;
    }
  }
  return best;
}

/** Exported for tests and the simulator: the evaluation context for a seat. */
export function evaluationContext(state, seat, level = 'medium', weights = null) {
  return makeContext(state, seat, LEVEL_SETTINGS[level === 'easy' ? 'easy' : 'medium'], resolveWeights(weights));
}
