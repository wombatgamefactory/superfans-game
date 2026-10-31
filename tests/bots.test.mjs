// bots.test.mjs - the heuristic bots (task T11): interface, purity, legality and strength.
//
// Semantics: permanently green. Every check here is an assertion; the
// strength figures and seat win rates are also printed (with jitter, as the
// web-board-game skill requires for any turn-order number).
//
//   1. Interface: BOT_LEVELS, isAsyncLevel, chooseAction for every level with
//      a function rng and an engine rng { s }, determinism, the state never
//      changed, unknown levels refused.
//   2. Strength (2 players, seats alternated, jitter 0.3):
//        Medium beats Random in >= 90% of 200 games;
//        Medium beats Easy in >= 65% of 200 games.
//   3. Termination: 500 games at 2-5 players with mixed Easy / Medium /
//      Random seats: every game ends, zero refusals, every bot action is one
//      of getValidActions, no safety stop, the bot never runs a conversion
//      window to the engine's cap.
//   4. Seat win rates of all-Medium 3-player games (printed, with sigma).
//
// The games run in parallel child processes (this file re-invoked with
// `--worker <job>`); per-game seeds come from the job and the game index, so
// results do not depend on the number of processes.

import { spawn } from 'node:child_process';
import { availableParallelism, cpus } from 'node:os';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import * as E from '../src/engine/index.js';
import { BOT_LEVELS, isAsyncLevel, chooseAction, getBot } from '../src/bots/index.js';
import { HEURISTIC_WEIGHTS, rolloutPolicy, scoreValidActions } from '../src/bots/heuristicBot.js';

const SELF = fileURLToPath(import.meta.url);
const JITTER = 0.3;
// QUICK=1 (npm run test:quick) plays fewer games per check. Every threshold is unchanged; only the sample
// size shrinks, so a quick pass is a smoke check and the full run (npm test) stays the gate.
const QUICK = process.env.QUICK === '1';
const scale = (n) => (QUICK ? Math.max(20, Math.round(n / 4)) : n);

// ---------------------------------------------------------------------------
// Worker: plays a block of games and prints one JSON line
// ---------------------------------------------------------------------------

function seatLevels(job, g) {
  if (job.kind === 'duel') {
    const aSeat = g % job.players;
    return Array.from({ length: job.players }, (_, i) => (i === aSeat ? job.a : job.b));
  }
  if (job.kind === 'mixed') {
    const r = E.makeRng(`mixed-levels:${job.seed}:${g}`);
    return Array.from({ length: job.players }, () => E.rngPick(r, ['easy', 'medium', 'random']));
  }
  return Array.from({ length: job.players }, () => job.a);
}

function playGame(job, g) {
  const n = job.players;
  const levels = seatLevels(job, g);
  const state = E.createGame({ playerCount: n }, { seed: `${job.seed}:${g}` });
  const rngs = levels.map((_, i) => E.makeRng(`bot:${job.seed}:${g}:${i}`));
  const out = { levels, startPlayer: state.startPlayer, decisions: 0, botDecisions: 0, botMs: 0, refusals: 0, offList: 0, maxConversions: 0, safety: 0 };
  let steps = 0;
  while (!E.isGameOver(state)) {
    const seat = state.toAct;
    const level = levels[seat];
    const legal = E.getValidActions(state);
    let action;
    if (level === 'random') action = E.rngPick(rngs[seat], legal);
    else {
      const t0 = performance.now();
      action = chooseAction(state, level, rngs[seat], { jitter: JITTER });
      out.botMs += performance.now() - t0;
      out.botDecisions++;
      const keys = new Set(legal.map(E.actionKey));
      if (!keys.has(E.actionKey(action))) out.offList++;
    }
    let events;
    try {
      events = E.applyAction(state, action);
    } catch (err) {
      out.refusals++;
      out.error = `${err.message} :: ${JSON.stringify(action)}`;
      break;
    }
    for (const ev of events) if (ev.type === E.EVENTS.SAFETY_STOP) out.safety++;
    for (const f of state.stack) if (levels[f.player] !== 'random' && typeof f.conversions === 'number' && f.conversions > out.maxConversions) out.maxConversions = f.conversions; // bot seats only
    out.decisions++;
    if (++steps > 20000) {
      out.error = 'more than 20000 decisions';
      break;
    }
  }
  out.ended = E.isGameOver(state);
  out.turnCapped = state.flags.turnCapped;
  const sc = E.scoreGame(state);
  out.winner = sc.winner;
  out.vp = state.players.map((p) => p.vp);
  return out;
}

if (process.argv[2] === '--worker') {
  const job = JSON.parse(process.argv[3]);
  const games = [];
  for (let g = job.from; g < job.to; g++) games.push(playGame(job, g));
  process.stdout.write(JSON.stringify(games));
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Parent: run jobs in parallel
// ---------------------------------------------------------------------------

const PROCS = Math.max(2, Math.min(16, (typeof availableParallelism === 'function' ? availableParallelism() : cpus().length) - 2));

function runChunk(job) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SELF, '--worker', JSON.stringify(job)], { stdio: ['ignore', 'pipe', 'inherit'] });
    let text = '';
    child.stdout.on('data', (d) => (text += d));
    child.on('close', (code) => {
      if (code !== 0) reject(new Error(`worker exited ${code}`));
      else resolve(JSON.parse(text));
    });
  });
}

async function runJob(job, games) {
  const size = Math.ceil(games / PROCS);
  const chunks = [];
  for (let from = 0; from < games; from += size) chunks.push(runChunk({ ...job, from, to: Math.min(games, from + size) }));
  return (await Promise.all(chunks)).flat();
}

let failures = 0;
async function check(name, fn) {
  const t0 = Date.now();
  try {
    await fn();
    console.log(`  ok  ${name} (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
  } catch (err) {
    failures++;
    console.log(`  FAIL ${name}\n       ${err.stack || err.message}`);
  }
}

const pct = (x) => `${(100 * x).toFixed(1)}%`;
const sigma = (p, n) => Math.sqrt((p * (1 - p)) / n);

function assertClean(games, label) {
  for (const g of games) {
    assert.ok(g.ended, `${label}: a game did not end (${g.error ?? 'no error'})`);
    assert.equal(g.refusals, 0, `${label}: the engine refused a bot action: ${g.error}`);
    assert.equal(g.offList, 0, `${label}: a bot returned an action not in getValidActions`);
    assert.equal(g.turnCapped, false, `${label}: a game hit a safety stop`);
    assert.equal(g.safety, 0, `${label}: a safety-stop event fired`);
    assert.ok(g.maxConversions <= HEURISTIC_WEIGHTS.maxConversionsPerWindow, `${label}: ${g.maxConversions} conversions in one window`);
  }
}

function duelSummary(games, a) {
  let wins = 0;
  games.forEach((g, i) => {
    if (g.levels[g.winner] === a && g.levels.filter((l) => l === a).length === 1) wins++;
  });
  return wins / games.length;
}

function timing(games) {
  const ms = games.reduce((s, g) => s + g.botMs, 0);
  const d = games.reduce((s, g) => s + g.botDecisions, 0);
  return d ? ms / d : 0;
}

console.log(`bots.test.mjs (${PROCS} worker processes${QUICK ? ', QUICK: reduced game counts' : ''})`);

// 1. Interface ---------------------------------------------------------------

await check('interface: BOT_LEVELS, isAsyncLevel, unknown level refused', () => {
  assert.deepEqual([...BOT_LEVELS], ['easy', 'medium', 'hard']);
  for (const l of BOT_LEVELS) assert.equal(isAsyncLevel(l), false);
  const s = E.createGame({ playerCount: 2 }, { seed: 'iface' });
  assert.throws(() => chooseAction(s, 'expert', () => 0.5));
  assert.throws(() => isAsyncLevel('nope'));
});

await check('interface: every level returns a legal action, deterministically, without changing the state', () => {
  for (const n of QUICK ? [2] : [2, 5]) {
    const s = E.createGame({ playerCount: n }, { seed: `iface-${n}` });
    const r = E.makeRng('drive');
    // play a few decisions in so that several frame kinds are met
    for (let k = 0; k < 60 && !E.isGameOver(s); k++) {
      if (k % 4 !== 0) { E.applyAction(s, E.rngPick(r, E.getValidActions(s)), E.SILENT); continue; }
      const legal = E.getValidActions(s);
      const keys = new Set(legal.map(E.actionKey));
      const before = E.hashState(s);
      for (const level of BOT_LEVELS) {
        const f = E.makeRng(`f-${level}-${k}`);
        const fn = () => E.rngNext(f);
        const a1 = chooseAction(s, level, fn, { jitter: 0.3 });
        const a2 = chooseAction(s, level, E.makeRng(`o-${level}-${k}`));
        const a3 = chooseAction(s, level, E.makeRng(`o-${level}-${k}`));
        assert.ok(keys.has(E.actionKey(a1)) && keys.has(E.actionKey(a2)), `${level} returned an action not on the list`);
        assert.equal(E.actionKey(a2), E.actionKey(a3), `${level} is not deterministic for one rng seed`);
      }
      assert.equal(E.hashState(s), before, 'a bot changed the state');
      const rp = rolloutPolicy(s, E.makeRng(`roll-${k}`));
      assert.ok(keys.has(E.actionKey(rp)), 'rolloutPolicy returned an action not on the list');
      const scored = scoreValidActions(s, { level: 'medium', rng: E.makeRng(`sc-${k}`) });
      assert.equal(scored.length, legal.length);
      assert.ok(scored.every((x) => Number.isFinite(x.score)), 'a non-finite score');
      E.applyAction(s, E.rngPick(r, legal), E.SILENT);
    }
  }
});

await check('interface: getBot objects (contract section 13 shape) and the rollout policy play whole games', () => {
  const bots = [getBot('medium'), getBot('random')];
  const s = E.createGame({ playerCount: 2 }, { seed: 'getbot' });
  const rng = E.makeRng('gb');
  while (!E.isGameOver(s)) E.applyAction(s, bots[s.toAct].chooseAction(s, { rng }), E.SILENT);
  for (const n of [2, 4]) {
    const t = E.createGame({ playerCount: n }, { seed: `roll-${n}` });
    const rr = E.makeRng(`rr-${n}`);
    let steps = 0;
    while (!E.isGameOver(t) && steps++ < 20000) E.applyAction(t, rolloutPolicy(t, rr), E.SILENT);
    assert.ok(E.isGameOver(t), 'a rollout game did not end');
    assert.equal(t.flags.turnCapped, false);
  }
});

// 2. Strength ----------------------------------------------------------------

await check('strength: Medium beats Random in >= 90% of 200 two-player games', async () => {
  const games = await runJob({ kind: 'duel', a: 'medium', b: 'random', players: 2, seed: 'mr' }, scale(200));
  assertClean(games, 'medium-random');
  const p = duelSummary(games, 'medium');
  console.log(`       Medium vs Random: ${pct(p)} (sigma ${pct(sigma(p, games.length))}), ${timing(games).toFixed(1)} ms a Medium decision`);
  assert.ok(p >= 0.9, `Medium won only ${pct(p)}`);
});

await check('strength: Medium beats Easy in >= 65% of 200 two-player games', async () => {
  const games = await runJob({ kind: 'duel', a: 'medium', b: 'easy', players: 2, seed: 'me' }, scale(200));
  assertClean(games, 'medium-easy');
  const p = duelSummary(games, 'medium');
  console.log(`       Medium vs Easy: ${pct(p)} (sigma ${pct(sigma(p, games.length))})`);
  assert.ok(p >= 0.65, `Medium won only ${pct(p)}`);
});

await check('strength: Easy is not random (beats Random in >= 80% of 100 two-player games)', async () => {
  const games = await runJob({ kind: 'duel', a: 'easy', b: 'random', players: 2, seed: 'er' }, scale(100));
  assertClean(games, 'easy-random');
  const p = duelSummary(games, 'easy');
  console.log(`       Easy vs Random: ${pct(p)} (sigma ${pct(sigma(p, games.length))}), ${timing(games).toFixed(1)} ms an Easy decision`);
  assert.ok(p >= 0.8, `Easy won only ${pct(p)}`);
});

// 3. Termination -------------------------------------------------------------

await check('termination: 500 mixed games at 2-5 players end with zero refusals', async () => {
  const per = scale(125);
  const jobs = [2, 3, 4, 5].map((players) => runJob({ kind: 'mixed', players, seed: `mix${players}` }, per));
  const games = (await Promise.all(jobs)).flat();
  assert.equal(games.length, 4 * per);
  assertClean(games, 'mixed');
  const decisions = games.reduce((s, g) => s + g.decisions, 0) / games.length;
  console.log(`       ${games.length} games, ${decisions.toFixed(0)} decisions a game, ${timing(games).toFixed(1)} ms a bot decision, max conversions in one window ${Math.max(...games.map((g) => g.maxConversions))}`);
});

// 4. Seat win rates ----------------------------------------------------------

await check('seat win rates: 120 all-Medium three-player games (jitter 0.3, printed)', async () => {
  const games = await runJob({ kind: 'same', a: 'medium', players: 3, seed: 'seats' }, scale(120));
  assertClean(games, 'seats');
  const n = games.length;
  const bySeat = [0, 0, 0];
  const byPos = [0, 0, 0];
  for (const g of games) {
    bySeat[g.winner]++;
    byPos[(g.winner - g.startPlayer + 3) % 3]++;
  }
  const fmt = (arr) => arr.map((w) => `${pct(w / n)} (${((w / n - 1 / 3) / sigma(1 / 3, n)).toFixed(1)} sigma)`).join(', ');
  console.log(`       by seat: ${fmt(bySeat)}`);
  console.log(`       by turn position (1 = Hour 1 first player): ${fmt(byPos)}`);
  console.log(`       mean winning score ${(games.reduce((s, g) => s + Math.max(...g.vp), 0) / n).toFixed(1)}`);
});

console.log(failures ? `${failures} check(s) failed` : 'all bot checks passed');
process.exit(failures ? 1 : 0);
