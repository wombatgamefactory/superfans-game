// record.js - the downloadable game record, and replaying one.
//
// A game is a pure function of (config, seed, list of actions) - engine
// contract, "replayGame". The record carries exactly that, plus the facts a
// person (or a spreadsheet) wants: seat types, Hour of each action, the final
// scores and the stats. tools/replay.mjs and tests/replay.test.mjs replay it
// headless and compare the scores.
//
// Format `superfans-record-v1`:
//   { schema, game, version, rulesId, finished, createdAt, seed, variants, config, seats, actions[], finalScores[],
//     stateHash, hoursPlayed, durationSeconds, stats }
//   config   the engine's own getGameConfig(state): players, seed, rngStart, variants, constants
//   actions  [{ n, seat, hour, how, action }] in the order applied. Forced actions the engine applied
//            itself are NOT listed; the engine re-derives them (R23.5)
//   seats    [{ kind: 'human'|'bot', level, name, colour }]
//
// Pure: no DOM, no storage. Runs in the browser and in Node.

import {
  replayGame, scoreGame, getGameConfig, hashState, isGameOver, RULES_ID, nonDefaultVariants,
} from '../engine/index.js';
import { collectStats } from './stats.js';

export const RECORD_SCHEMA = 'superfans-record-v1';

/**
 * @param {object} input
 *   state      the live game state
 *   seats      the page's seats
 *   actions    app.actions: [{ action, seat, hour, how }]
 *   events     app.events (for the stats; optional)
 *   version    CONFIG.VERSION
 *   startedAtMs, endedAtMs  optional wall-clock milliseconds
 * @returns {object} plain JSON
 */
export function buildRecord({ state, seats, actions, events = null, version = '', durationMs = null, now = new Date() }) {
  const config = getGameConfig(state);
  const over = isGameOver(state);
  const rec = {
    schema: RECORD_SCHEMA,
    game: 'superfans',
    version,
    rulesId: RULES_ID,
    finished: over,
    createdAt: now.toISOString(),
    seed: config.seed,
    variants: nonDefaultVariants(state.variants),
    config,
    seats: seats.map((s) => ({ kind: s.kind, level: s.level ?? null, name: s.name, colour: s.colour })),
    actions: actions.map((a, i) => ({ n: i + 1, seat: a.seat, hour: a.hour, how: a.how ?? null, action: a.action })),
    hoursPlayed: state.hour,
    durationSeconds: durationMs === null ? null : Math.round(durationMs / 1000),
    finalScores: [],
    stateHash: hashState(state),
    stats: null,
  };
  try {
    rec.finalScores = scoreGame(state).players.map((p) => ({ seat: p.seat, name: p.name, vp: p.vp, rank: p.rank, bySource: { ...p.bySource } }));
  } catch {
    rec.finalScores = state.players.map((p, seat) => ({ seat, name: p.name, vp: p.vp, rank: null, bySource: {} }));
  }
  if (events) {
    try {
      rec.stats = collectStats(events, state.players, seats);
    } catch {
      rec.stats = null;
    }
  }
  return rec;
}

/** Checks the shape of a record; returns a list of problems (empty = fine). */
export function validateRecord(rec) {
  const problems = [];
  if (!rec || typeof rec !== 'object') return ['not an object'];
  if (rec.schema !== RECORD_SCHEMA) problems.push(`schema is "${rec.schema}", expected "${RECORD_SCHEMA}"`);
  if (rec.game !== 'superfans') problems.push('game is not "superfans"');
  if (!rec.config || !Array.isArray(rec.config.players)) problems.push('config.players is missing');
  if (!Array.isArray(rec.actions)) problems.push('actions is not a list');
  if (!Array.isArray(rec.finalScores)) problems.push('finalScores is not a list');
  return problems;
}

/**
 * Replays a record headless and compares with its own final scores.
 * @returns {{ ok: boolean, problems: string[], scores: {seat:number,vp:number}[], expected: object[], hashOk: boolean|null, rulesIdMatches: boolean, state?: object }}
 */
export function replayRecord(rec) {
  const problems = validateRecord(rec);
  const out = { ok: false, problems, scores: [], expected: rec && rec.finalScores ? rec.finalScores : [], hashOk: null, rulesIdMatches: !rec || rec.rulesId === RULES_ID };
  if (problems.length) return out;
  if (!out.rulesIdMatches) problems.push(`the record was made under rules "${rec.rulesId}"; this build plays "${RULES_ID}"`);
  let state;
  try {
    state = replayGame(rec.config, rec.actions.map((a) => a.action));
  } catch (err) {
    problems.push(`replay failed: ${err.message}`);
    return out;
  }
  out.state = state;
  if (rec.finished && !isGameOver(state)) problems.push('the record says the game finished, but the replay is not over');
  const sc = scoreGame(state);
  out.scores = sc.players.map((p) => ({ seat: p.seat, vp: p.vp, rank: p.rank }));
  for (const e of out.expected) {
    const got = out.scores.find((s) => s.seat === e.seat);
    if (!got) problems.push(`seat ${e.seat + 1} is missing from the replay`);
    else if (got.vp !== e.vp) problems.push(`seat ${e.seat + 1}: record says ${e.vp} VP, replay gives ${got.vp}`);
    else if (e.rank !== null && e.rank !== undefined && got.rank !== e.rank) problems.push(`seat ${e.seat + 1}: record says rank ${e.rank}, replay gives ${got.rank}`);
  }
  if (rec.stateHash) {
    out.hashOk = hashState(state) === rec.stateHash;
    if (!out.hashOk) problems.push('the replayed final state differs from the recorded state hash');
  }
  out.ok = problems.length === 0;
  return out;
}

/** File name for a download: kebab-case, seed in it. */
export function recordFileName(rec) {
  return `superfans-game-record-${rec.seed}.json`;
}
