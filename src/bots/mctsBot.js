// mctsBot.js - the Hard bot: a Monte Carlo search on top of Medium (task T15).
//
// HOW IT PLAYS, IN ONE PARAGRAPH
//
// At the one decision of a turn that sets its plan - the main action of a
// normal turn - the bot asks Medium (`scoreValidActions`) for its favourite
// three actions, then plays each of them forward a few times: on a fresh
// BLIND copy of the game (everything it cannot see re-dealt at random), apply
// the action, then let MEDIUM play every seat (the bot's own later turns
// included) to the end of the current Hour, so that the Hour's celebrity walks
// and scores, and read Medium's evaluation of the result (own value minus the
// weighted rivals). The candidates share their random draws (the same deal and
// the same Medium stream for every candidate in an iteration: "common random
// numbers"), so what is compared is the difference the action makes, not the
// luck of the deal. The weakest candidate is dropped halfway (successive
// halving), and the bot plays the best mean, keeping Medium's own choice
// unless another beats it by `deviationMargin`. Every other decision
// (conversions, effect steps, the pass Achievement, pass-turn rewards, the
// Squad and final windows) is Medium's: cheap, many and rarely worth it.
//
// WHY THIS SHAPE AND NOT THE CONTINENTAL RAILS TREE (bot-notes-v2.md, section 4)
//
// Continental Rails' Hard grows a PUCT tree with Medium's scores as priors and
// Medium playouts to the end of the game. There a Medium decision costs 26
// microseconds; here about 15-40 ms, so a Medium playout to the end costs ~1 s
// and a tree is unaffordable. The cheap `rolloutPolicy` (and a 1-ply greedy
// policy) were measured as playout policies and rejected: their game-end
// margins barely track the truth (an oracle of Medium playouts) and the search
// lost to Medium (36-51%). What works is the true continuation - Medium for
// every seat - cut at the natural horizon of this game, the end of the Hour,
// with Medium's static evaluation beyond it. Kept from the reference design:
// open loop (nothing stored per state), priors from `scoreValidActions` (to
// choose and order candidates), hidden information re-drawn each iteration,
// a budget per TURN, an injected clock. The 'playout' mode (cheap policy to a
// horizon, score margin) is kept behind `mode` for the record and future A/B.
//
// A search that models every opponent as a heuristic flatters itself against
// that heuristic (web-board-game skill, "Bots"): the ladder figures are Hard
// against Medium, not Hard against people.
//
// HIDDEN INFORMATION (R23.2). The search never reads another seat's hand or a
// deck order: every iteration starts from `blindCopy(canonicalCopy(state), me, rng)`, so
// other hands, unscored discards and both deck orders are re-dealt from the
// bot's OWN stream, and the game RNG of the copy is a fork of that stream.
//
// PURITY. No clock of its own (`now` is injected by the caller, e.g. the Web
// Worker in bot-worker.js), no randomness but the `rng` handed in, no output,
// no storage, nothing remembered between calls. The state is never changed.

import {
  getValidActions,
  applyAction,
  SILENT,
  cloneState,
  cloneRng,
  forkRng,
  makeRng,
  rngNext,
  hashSeed,
  blindCopy,
  topFrame,
  isGameOver,
  actionKey,
  CONVERSION_TYPES,
} from '../engine/index.js';
import { scoreValidActions, chooseHeuristicAction, rolloutPolicy, evaluatePosition, evaluateAll, evaluationContext } from './heuristicBot.js';

// ---------------------------------------------------------------------------
// Tuning constants
// ---------------------------------------------------------------------------
//
// ONE object. `opts.mcts` overrides any entry for one call (A/B duels).
// "A/B" figures are 2-player duels against Medium, seats alternated, jitter
// 0.3 (bot-notes-v2.md, section 4).

export const MCTS_SETTINGS = Object.freeze({
  // --- which decisions are searched
  /** Main actions are searched from this Hour on (earlier ones are Medium's). */
  searchFromHour: 1,

  // --- candidates (from Medium's scores)
  /** At most this many root candidates, Medium's best first. */
  maxCandidates: 3,
  /** Only candidates Medium scores within this many VP-equivalents of its best. */
  candidateWindow: 8,

  // --- what one sample of a candidate is
  /**
   * 'reply': apply the candidate, finish its follow-ups, let the other seats answer (until the bot's next main
   * decision, or the Hour's Walk) with `replyPolicy`, then score with Medium's evaluation (own - weighted rivals).
   * 'playout': apply the candidate, then play to `horizon` with the cheap rolloutPolicy and read the margin.
   */
  mode: 'reply',
  /** Who answers in 'reply' mode: 'medium' (the real Medium, conversions and follow-ups included) or 'greedy' (1-ply, no conversions, ~3x cheaper). */
  replyPolicy: 'medium',
  /**
   * How many of the bot's OWN later main decisions are also played (by the reply policy) inside a 'reply' sample
   * before it is scored. 20 = in effect "to the end of the Hour" (the sample always stops after the Walk).
   * A/B (100 2p games v Medium, 3 candidates, 12 samples): 0 (stop at the bot's next decision) won 51%; 20 won 67%.
   */
  ownTurns: 20,
  /** Jitter of the Medium that plays inside a sample (the same whatever jitter the caller asks of Hard; all A/B ran at 0.3). */
  playoutJitter: 0.3,
  /** Livelock guard on the decisions of one 'reply' sample. */
  maxReplyDecisions: 200,

  // --- the playout ('playout' mode)
  /** Hard cap on the decisions of one playout (livelock guard; a 2p game is ~95 decisions, 5p ~300). */
  maxPlayoutDecisions: 3000,
  /**
   * Where a playout stops: 'game' = the real end of the game (score margin);
   * 'hour' = after the current Hour's Walk, then Medium's static evaluation.
   */
  horizon: 'game',
  /** The bot's own follow-up steps right after the candidate are answered by a 1-ply greedy step on Medium's evaluation (at most this many). */
  greedyFollowUps: 6,
  /** Further playout decisions answered by the greedy 1-ply step (for every seat) before the cheap policy takes over. */
  greedyPlayoutDecisions: 0,

  // --- the result (VP)
  /** The margin over the best other player is squashed: scale x tanh(margin / scale). */
  marginScale: 40,
  /** VP-equivalents added for finishing first. */
  winBonus: 10,

  // --- the choice
  /** Medium's choice is kept unless another candidate's mean result beats it by this much (VP). */
  deviationMargin: 2,
  /** With fewer paired iterations than this the bot plays Medium's choice. */
  minIterations: 4,

  // --- the budget (per TURN; the only searched decision of a turn is its main action)
  /** Default thinking time of one turn when a clock is given (ms). */
  hardTimeBudgetMs: 1200,
  /** With a clock: an iteration is not started if it is predicted to end past budget x this. */
  overrunAllowance: 1.15,
  /** Default samples per turn when no clock is given (Node, the simulator, tests). */
  hardPlayouts: 12,
});

/** MCTS_SETTINGS with `overrides` laid over it; unknown names throw, so a misspelt override cannot run the baseline. */
export function resolveSettings(overrides) {
  if (overrides === null || overrides === undefined) return MCTS_SETTINGS;
  if (typeof overrides !== 'object') throw new Error('mctsBot: `mcts` must be an object of overrides of MCTS_SETTINGS.');
  for (const name of Object.keys(overrides)) {
    if (!Object.prototype.hasOwnProperty.call(MCTS_SETTINGS, name)) {
      throw new Error(`mctsBot: unknown setting "${name}". The settings are: ${Object.keys(MCTS_SETTINGS).join(', ')}.`);
    }
  }
  return { ...MCTS_SETTINGS, ...overrides };
}

const CONVERSIONS = new Set(CONVERSION_TYPES);

function toEngineRng(rng) {
  if (rng && typeof rng.s === 'number') return rng;
  if (typeof rng === 'function') return { s: hashSeed(`mcts:${Math.floor(rng() * 4294967296)}`) };
  return makeRng('mcts');
}

/**
 * A copy of `state` in which everything `me` cannot see is put in a FIXED
 * order: the unseen Achievements (deck + other hands + other seats' unscored
 * discards) sorted and dealt back in that order, the Swag deck sorted, the
 * game RNG zeroed. blindCopy shuffles its pool from the order it is given, so
 * without this the deals (though uniformly random either way) would depend on
 * the real hidden order; with it, the search's every number provably does not
 * (tests/bot-ladder.test.mjs scrambles the hidden cards and gets the same move
 * and the same statistics).
 */
export function canonicalCopy(state, me) {
  const c = cloneState(state);
  const ach = c.achievements;
  const pool = ach.deck.slice();
  for (const p of c.players) if (p.seat !== me) pool.push(...p.hand);
  for (const d of ach.discard) if (!d.scored && d.owner !== me) pool.push(d.card);
  pool.sort();
  let i = 0;
  for (const p of c.players) if (p.seat !== me) p.hand = p.hand.map(() => pool[i++]);
  for (const d of ach.discard) if (!d.scored && d.owner !== me) d.card = pool[i++];
  ach.deck = pool.slice(i);
  c.swag.deck.sort();
  c.rng = { s: 0 };
  return c;
}

// ---------------------------------------------------------------------------
// Which decisions are searched
// ---------------------------------------------------------------------------

/**
 * The share of the per-turn allowance the pending decision gets: 1 for the
 * main action of a normal turn, 0 (= Medium plays it) for everything else.
 * Conversions taken before the main action are Medium's (so the turn's search
 * still has its whole allowance when the main action comes).
 */
export function decisionShare(state, S = MCTS_SETTINGS) {
  const f = topFrame(state);
  return f !== null && f.kind === 'turn' && state.hour >= S.searchFromHour ? 1 : 0;
}

// ---------------------------------------------------------------------------
// The playout
// ---------------------------------------------------------------------------

/** 1-ply greedy step on Medium's evaluation for `sim.toAct`, conversions left out. Returns an action. */
export function greedyAction(sim, ctxCache = {}) {
  const seat = sim.toAct;
  const acts = getValidActions(sim);
  let ctx = ctxCache[seat];
  if (ctx === undefined) ctx = ctxCache[seat] = evaluationContext(sim, seat, 'medium');
  ctx.known = new Set(sim.players[seat].hand);
  let best = null;
  let bestScore = -Infinity;
  for (const a of acts) {
    if (CONVERSIONS.has(a.type)) continue;
    const c = cloneState(sim);
    try {
      applyAction(c, a, SILENT);
    } catch {
      continue;
    }
    const s = evaluatePosition(c, ctx);
    if (s > bestScore) {
      bestScore = s;
      best = a;
    }
  }
  return best ?? acts[0];
}

function isFollowUp(sim, me) {
  if (isGameOver(sim) || sim.toAct !== me) return false;
  const f = topFrame(sim);
  return f !== null && f.kind !== 'turn' && f.kind !== 'passTurn' && f.kind !== 'squadWindow' && f.kind !== 'finalWindow';
}

/** Plays `sim` on to the horizon. Mutates `sim`. */
function playout(sim, me, rng, S) {
  const ctxCache = {};
  for (let k = 0; k < S.greedyFollowUps && isFollowUp(sim, me); k++) applyAction(sim, greedyAction(sim, ctxCache), SILENT);
  const hour = sim.hour;
  let decisions = 0;
  while (!isGameOver(sim) && decisions < S.maxPlayoutDecisions) {
    if (S.horizon === 'hour' && (sim.hour !== hour || sim.phase === 'final')) break;
    const a = decisions < S.greedyPlayoutDecisions ? greedyAction(sim, ctxCache) : rolloutPolicy(sim, rng);
    applyAction(sim, a, SILENT);
    decisions += 1;
  }
}

const MAIN_FRAMES = new Set(['turn', 'passTurn']);

/**
 * One 'reply' sample: after the candidate (already applied), finish the bot's own follow-ups greedily, then let
 * the game run with the reply policy until the bot's next main decision (after `ownTurns` more of its own, played
 * greedily), the end of the Hour (its Walk has then scored) or the end of the game. Returns Medium's evaluation for
 * `me` (own value - opponentWeight x rivals), in VP-equivalents. Mutates `sim`.
 */
function replySample(sim, me, S, ctx, rng, jitter, weights, stop) {
  const ctxCache = {};
  for (let k = 0; k < S.greedyFollowUps && isFollowUp(sim, me); k++) applyAction(sim, greedyAction(sim, ctxCache), SILENT);
  const hour = sim.hour;
  let own = 0;
  for (let d = 0; d < S.maxReplyDecisions && !isGameOver(sim); d++) {
    if (stop !== null && stop()) return null; // out of time: the caller abandons this iteration
    if (sim.hour !== hour || sim.phase === 'final') break;
    const f = topFrame(sim);
    const mine = sim.toAct === me;
    if (mine && f !== null && MAIN_FRAMES.has(f.kind)) {
      if (own >= S.ownTurns) break;
      own += 1;
    }
    let a;
    if (S.replyPolicy === 'greedy') a = greedyAction(sim, ctxCache);
    else a = chooseHeuristicAction(sim, { level: 'medium', rng, jitter, weights: mine ? weights : undefined });
    applyAction(sim, a, SILENT);
  }
  return evaluatePosition(sim, ctx);
}

/** The result for `me`, in VP: squashed margin over the best other seat plus a bonus for first place. */
function resultOf(sim, me, S, ctx) {
  // At an 'hour' horizon (or a capped playout): Medium's static evaluation of every seat (the hand only for `me`,
  // the same for every candidate, so the comparison is fair).
  const vals = isGameOver(sim) ? sim.players.map((p) => p.vp) : evaluateAll(sim, ctx);
  let best = -Infinity;
  for (let q = 0; q < vals.length; q++) if (q !== me && vals[q] > best) best = vals[q];
  const margin = vals[me] - best;
  return S.marginScale * Math.tanh(margin / S.marginScale) + (margin > 0 ? S.winBonus : margin === 0 ? S.winBonus / 2 : 0);
}

// ---------------------------------------------------------------------------
// The search
// ---------------------------------------------------------------------------

/**
 * Searches the decision of `state.toAct`. Returns
 * `{ action, searched, iterations, playouts, candidates, reason }`, where
 * `candidates` lists `{ action, key, prior, mean, n }` (best first) for tests
 * and the notes. `action` is always one of getValidActions(state).
 *
 * @param {object} state the real state (never changed)
 * @param {object} [opts]
 *   rng           the bot's own stream ({ s } or a function)
 *   jitter        Medium's tie-break (also used for Medium's own decisions)
 *   weights       Medium weight overrides
 *   timeBudgetMs  thinking time for one TURN (needs `now`); 0 = play Medium
 *   iterations    playouts for one TURN, in place of the clock (deterministic)
 *   now           () => ms, injected; bots never read a clock themselves
 *   mcts          overrides of MCTS_SETTINGS
 */
export function search(state, opts = {}) {
  const S = resolveSettings(opts.mcts);
  const rng = toEngineRng(opts.rng);
  const rand = () => rngNext(rng);
  const me = state.toAct;
  const now = typeof opts.now === 'function' ? opts.now : null;
  const started = now === null ? 0 : now(); // the clock covers Medium's scoring of the root too
  // Everything below reads only `canon`, never the real hidden order (HIDDEN INFORMATION above).
  const canon = canonicalCopy(state, me);
  const scored = scoreValidActions(canon, { level: 'medium', rng: forkRng(rng), weights: opts.weights });
  if (scored.length === 0) throw new Error('mctsBot: there is no legal action (the game is over).');
  const jitter = Number(opts.jitter) || 0;
  let mediumBest = scored[0];
  let mbScore = -Infinity;
  for (const r of scored) {
    const s = r.score + (jitter > 0 ? jitter * rand() : 0);
    if (s > mbScore) {
      mbScore = s;
      mediumBest = r;
    }
  }
  const medium = (reason, extra = {}) => ({ action: mediumBest.action, searched: false, iterations: 0, playouts: 0, candidates: [], reason, ...extra });

  const share = decisionShare(state, S);
  if (share <= 0) return medium('not a searched decision');
  if (CONVERSIONS.has(mediumBest.action.type)) return medium('Medium converts first');

  // --- the allowance
  let maxPlayouts = Infinity;
  let deadline = null;
  if (typeof opts.iterations === 'number') maxPlayouts = Math.floor(opts.iterations * share);
  else {
    const budget = typeof opts.timeBudgetMs === 'number' ? opts.timeBudgetMs : S.hardTimeBudgetMs;
    if (!(budget > 0)) return medium('no budget');
    if (now === null) maxPlayouts = Math.floor(S.hardPlayouts * (budget / S.hardTimeBudgetMs) * share);
    else deadline = budget * share;
  }

  // --- the candidates: Medium's best few, its own choice first
  const pool = scored
    .filter((r) => !CONVERSIONS.has(r.action.type) && r !== mediumBest && r.score >= mediumBest.score - S.candidateWindow)
    .sort((a, b) => b.score - a.score)
    .slice(0, S.maxCandidates - 1);
  const cands = [mediumBest, ...pool].map((r) => ({ action: r.action, key: actionKey(r.action), prior: r.score, sum: 0, n: 0, alive: true }));
  if (cands.length < 2) return medium('one candidate');
  if (maxPlayouts < S.minIterations * cands.length) return medium('allowance too small');

  // --- successive halving with common random numbers
  const rounds = Math.max(1, Math.ceil(Math.log2(cands.length)));
  const ctx = evaluationContext(state, me, 'medium', opts.weights ?? null);
  let alive = cands.slice();
  let playouts = 0;
  let iterations = 0;
  let reason = 'allowance spent';
  let outOfTime = false;
  // With a clock, a sample is abandoned (and its iteration discarded) at budget x overrunAllowance.
  const hardStop = deadline === null ? null : () => now() - started > deadline * S.overrunAllowance;
  for (let round = 0; round < rounds && alive.length > 1; round++) {
    const roundEndPlayouts = (maxPlayouts * (round + 1)) / rounds;
    const roundEndMs = deadline === null ? null : (deadline * (round + 1)) / rounds;
    let roundIterations = 0;
    for (;;) {
      if (deadline !== null) {
        // Do not start an iteration that is predicted to end past the round's share (one per round is always run).
        const elapsed = now() - started;
        const perPlayout = playouts > 0 ? elapsed / playouts : 0;
        if (roundIterations > 0 && elapsed + perPlayout * alive.length > roundEndMs) break;
        if (iterations > 0 && elapsed + perPlayout * alive.length > deadline * S.overrunAllowance) break;
      } else if (playouts + alive.length > roundEndPlayouts && roundIterations > 0) break;
      if (deadline === null && playouts + alive.length > maxPlayouts) break;
      const detRng = forkRng(rng);
      const blind = blindCopy(canon, me, detRng);
      const playRng = forkRng(rng);
      // An iteration counts only when every surviving candidate has its sample (the comparison stays paired).
      const values = [];
      for (const c of alive) {
        const sim = cloneState(blind);
        applyAction(sim, c.action, SILENT);
        let v;
        if (S.mode === 'reply') v = replySample(sim, me, S, ctx, cloneRng(playRng), S.playoutJitter, opts.weights, hardStop);
        else {
          playout(sim, me, cloneRng(playRng), S);
          v = resultOf(sim, me, S, ctx);
        }
        if (v === null) break;
        values.push(v);
      }
      if (values.length < alive.length) {
        outOfTime = true;
        break;
      }
      alive.forEach((c, k) => {
        c.sum += values[k];
        c.n += 1;
      });
      playouts += alive.length;
      iterations += 1;
      roundIterations += 1;
    }
    if (outOfTime) {
      reason = 'time spent';
      break;
    }
    if (round < rounds - 1) {
      alive.sort((a, b) => b.sum / b.n - a.sum / a.n);
      alive = alive.slice(0, Math.max(2, Math.ceil(alive.length / 2)));
    }
    if (deadline !== null && now() - started >= deadline) {
      reason = 'time spent';
      break;
    }
  }

  const list = cands
    .filter((c) => c.n > 0)
    .map((c) => ({ action: c.action, key: c.key, prior: c.prior, mean: c.sum / c.n, n: c.n }))
    .sort((a, b) => b.n - a.n || b.mean - a.mean);
  if (iterations < S.minIterations) return medium('too few iterations', { iterations, playouts, candidates: list });

  // --- the choice: among the survivors (most samples), the best mean; Medium's choice wins unless beaten by deviationMargin
  const topN = list[0].n;
  const finalists = list.filter((c) => c.n === topN);
  let pick = finalists.reduce((b, c) => (c.mean > b.mean ? c : b));
  const med = finalists.find((c) => c.key === cands[0].key);
  if (med && pick !== med && pick.mean - med.mean < S.deviationMargin) pick = med;
  const legal = getValidActions(state);
  const action = legal.find((a) => actionKey(a) === pick.key);
  if (action === undefined) return medium('chosen action not in the legal list', { iterations, playouts, candidates: list });
  return { action, searched: true, iterations, playouts, candidates: list, reason };
}

/**
 * The Hard bot's action for `state.toAct` (synchronous).
 * @param {object} state the game state (not changed)
 * @param {object} [opts] as `search`
 * @returns {object} one of getValidActions(state)
 */
export function chooseHardAction(state, opts = {}) {
  return search(state, opts).action;
}
