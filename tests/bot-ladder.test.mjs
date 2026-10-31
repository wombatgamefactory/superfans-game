// bot-ladder.test.mjs - the Hard search bot (task T15) and the difficulty ladder.
//
// Semantics: permanently green. Every check is an assertion; the ladder
// figures and timings are also printed (with sigma).
//
//   1. Interface: hard through chooseAction (sync, isAsyncLevel false),
//      legal, deterministic for one rng seed with an iteration allowance, the
//      state never changed, setting overrides checked, a time budget with a
//      real clock, the hard stop with a runaway clock, the Web Worker request
//      handler (bot-worker.js) with and without a clock.
//   2. Hidden information: the search's choice and statistics do not change
//      when the other seat's hand, the unscored discards and both deck orders
//      are scrambled (it only ever sees blind copies).
//   3. Ladder (2 players, seats alternated, jitter 0.3, Hard at the TEST
//      allowance of LADDER_PLAYOUTS playouts a turn):
//        Hard beats Medium in >= 65% of 100 games; zero refusals.
//
// The games run in parallel child processes (this file re-invoked with
// `--worker <job>`); per-game seeds come from the job and the game index, so
// results do not depend on the number of processes.

import { spawn } from 'node:child_process';
import { availableParallelism, cpus } from 'node:os';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import * as E from '../src/engine/index.js';
import { BOT_LEVELS, isAsyncLevel, chooseAction, searchHard, MCTS_SETTINGS } from '../src/bots/index.js';
import { handleBotRequest } from '../src/bots/bot-worker.js';

const SELF = fileURLToPath(import.meta.url);
const JITTER = 0.3;
/** The test allowance: playouts per Hard turn (the default without a clock is MCTS_SETTINGS.hardPlayouts). */
const LADDER_PLAYOUTS = MCTS_SETTINGS.hardPlayouts;

// ---------------------------------------------------------------------------
// Worker: plays a block of games and prints one JSON line
// ---------------------------------------------------------------------------

function playGame(job, g) {
  const n = job.players;
  const aSeat = g % n;
  const levels = Array.from({ length: n }, (_, i) => (i === aSeat ? job.a : job.b));
  const state = E.createGame({ playerCount: n }, { seed: `${job.seed}:${g}` });
  const rngs = levels.map((_, i) => E.makeRng(`bot:${job.seed}:${g}:${i}`));
  const out = { levels, decisions: 0, refusals: 0, offList: 0, hardMs: 0, hardSearched: 0, hardMaxMs: 0, hardTurns: [] };
  let turnMs = null;
  while (!E.isGameOver(state)) {
    const seat = state.toAct;
    const level = levels[seat];
    const legal = E.getValidActions(state);
    const frame = E.topFrame(state);
    const t0 = performance.now();
    const action = level === 'hard'
      ? chooseAction(state, 'hard', rngs[seat], { jitter: JITTER, iterations: job.playouts })
      : chooseAction(state, level, rngs[seat], { jitter: JITTER });
    const dt = performance.now() - t0;
    if (level === 'hard') {
      out.hardMs += dt;
      if (frame.kind === 'turn' && turnMs === null) turnMs = 0;
      if (turnMs !== null) turnMs += dt;
      if (dt > out.hardMaxMs) out.hardMaxMs = dt;
    } else if (turnMs !== null) {
      out.hardTurns.push(turnMs);
      turnMs = null;
    }
    if (!legal.some((a) => E.actionKey(a) === E.actionKey(action))) out.offList++;
    try {
      E.applyAction(state, action, E.SILENT);
    } catch (err) {
      out.refusals++;
      out.error = `${err.message} :: ${JSON.stringify(action)}`;
      break;
    }
    out.decisions++;
    if (out.decisions > 20000) {
      out.error = 'more than 20000 decisions';
      break;
    }
  }
  if (turnMs !== null) out.hardTurns.push(turnMs);
  out.ended = E.isGameOver(state);
  out.winner = E.scoreGame(state).winner;
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
// Parent
// ---------------------------------------------------------------------------

const PROCS = Math.max(2, Math.min(16, (typeof availableParallelism === 'function' ? availableParallelism() : cpus().length) - 2));

function runChunk(job) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SELF, '--worker', JSON.stringify(job)], { stdio: ['ignore', 'pipe', 'inherit'] });
    let text = '';
    child.stdout.on('data', (d) => (text += d));
    child.on('close', (code) => (code !== 0 ? reject(new Error(`worker exited ${code}`)) : resolve(JSON.parse(text))));
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

/** Plays a 2-player game with Medium until a normal turn whose main action Hard would search. */
function searchedPosition(seed, minHour = 2) {
  const s = E.createGame({ playerCount: 2 }, { seed });
  const r = E.makeRng(`pos:${seed}`);
  for (let k = 0; k < 5000 && !E.isGameOver(s); k++) {
    if (s.hour >= minHour && E.topFrame(s).kind === 'turn') {
      const res = searchHard(s, { rng: E.makeRng('probe'), iterations: 12 });
      if (res.searched) return s;
    }
    E.applyAction(s, chooseAction(s, 'medium', r, { jitter: JITTER }), E.SILENT);
  }
  throw new Error('no searched position found');
}

console.log(`bot-ladder.test.mjs (${PROCS} worker processes, Hard at ${LADDER_PLAYOUTS} playouts a turn)`);

// 1. Interface ---------------------------------------------------------------

await check('interface: hard is a synchronous level; legal, deterministic, state unchanged', () => {
  assert.ok(BOT_LEVELS.includes('hard'));
  assert.equal(isAsyncLevel('hard'), false);
  const s = searchedPosition('iface');
  const before = E.hashState(s);
  const keys = new Set(E.getValidActions(s).map(E.actionKey));
  const a1 = chooseAction(s, 'hard', E.makeRng('h1'), { iterations: 60 });
  const a2 = chooseAction(s, 'hard', E.makeRng('h1'), { iterations: 60 });
  const a3 = chooseAction(s, 'hard', () => 0.25, { iterations: 60 });
  assert.ok(keys.has(E.actionKey(a1)) && keys.has(E.actionKey(a3)), 'hard returned an action not on the list');
  assert.equal(E.actionKey(a1), E.actionKey(a2), 'hard is not deterministic for one rng seed');
  const r = searchHard(s, { rng: E.makeRng('h1'), iterations: 60 });
  assert.equal(r.searched, true);
  assert.ok(r.playouts <= 60, `spent ${r.playouts} playouts of 60`);
  assert.equal(E.hashState(s), before, 'the search changed the state');
  assert.throws(() => searchHard(s, { rng: E.makeRng('x'), mcts: { noSuchSetting: 1 } }), /unknown setting/);
  // Non-searched decisions (a squad window, a follow-up) are Medium's and cheap.
  const t = E.createGame({ playerCount: 2 }, { seed: 'iface-2' });
  const legal = new Set(E.getValidActions(t).map(E.actionKey));
  assert.ok(legal.has(E.actionKey(chooseAction(t, 'hard', E.makeRng('h2')))));
});

await check('interface: a time budget with an injected clock is respected; the worker handler answers', () => {
  const s = searchedPosition('clock');
  const keys = new Set(E.getValidActions(s).map(E.actionKey));
  // A real clock (tests may read one; bots may not): the turn ends near its budget.
  const t0 = performance.now();
  const r = searchHard(s, { rng: E.makeRng('c'), timeBudgetMs: 1200, now: () => performance.now() });
  const ms = performance.now() - t0;
  assert.ok(keys.has(E.actionKey(r.action)));
  console.log(`       1200 ms budget: ${ms.toFixed(0)} ms, ${r.playouts} samples, searched ${r.searched} (${r.reason})`);
  assert.ok(ms < 1200 * MCTS_SETTINGS.overrunAllowance + 1500, `the search took ${ms.toFixed(0)} ms on a 1200 ms budget`);
  // A runaway clock (1 s a reading): the hard stop abandons the sample and Medium's choice is played at once.
  let fake = 0;
  const t1 = performance.now();
  const stopped = searchHard(s, { rng: E.makeRng('c'), timeBudgetMs: 1200, now: () => (fake += 1000) });
  assert.equal(stopped.searched, false);
  assert.ok(keys.has(E.actionKey(stopped.action)));
  assert.ok(performance.now() - t1 < 5000, 'the hard stop did not stop the search');
  const rep = handleBotRequest({ id: 7, state: JSON.parse(JSON.stringify(s)), level: 'hard', seed: 12345, options: { iterations: 40 } });
  assert.equal(rep.ok, true, rep.error);
  assert.equal(rep.id, 7);
  assert.ok(keys.has(E.actionKey(rep.action)));
  const rep2 = handleBotRequest({ id: 8, state: s, level: 'hard', seed: { s: 99 }, options: { timeBudgetMs: 300 } }, () => performance.now());
  assert.equal(rep2.ok, true, rep2.error);
  assert.ok(keys.has(E.actionKey(rep2.action)));
  const bad = handleBotRequest({ id: 9, state: s, level: 'expert', seed: 1 });
  assert.equal(bad.ok, false);
  const noSeed = handleBotRequest({ id: 10, state: s, level: 'hard' });
  assert.equal(noSeed.ok, false);
});

// 2. Hidden information ------------------------------------------------------

await check('hidden information: scrambling what Hard cannot see changes nothing', () => {
  for (const seed of ['hid-a', 'hid-b']) {
    const s = searchedPosition(seed);
    const me = s.toAct;
    const other = E.cloneState(s);
    const r = E.makeRng(`scramble:${seed}`);
    // Swap the opponent's hand with deck cards, shuffle both decks.
    const opp = other.players.find((p) => p.seat !== me);
    const pool = [...other.achievements.deck, ...opp.hand];
    E.shuffle(r, pool);
    opp.hand = opp.hand.map(() => pool.pop());
    other.achievements.deck = pool;
    E.shuffle(r, other.swag.deck);
    other.rng = E.makeRng('another game stream');
    assert.notEqual(E.hashState(other), E.hashState(s));
    const a = searchHard(s, { rng: E.makeRng('same'), iterations: 60 });
    const b = searchHard(other, { rng: E.makeRng('same'), iterations: 60 });
    assert.equal(E.actionKey(a.action), E.actionKey(b.action));
    assert.deepEqual(a.candidates.map((c) => [c.key, c.n, c.mean]), b.candidates.map((c) => [c.key, c.n, c.mean]));
  }
});

// 3. Ladder ------------------------------------------------------------------

await check(`ladder: Hard (${LADDER_PLAYOUTS} playouts a turn) beats Medium in >= 65% of 100 two-player games`, async () => {
  const games = await runJob({ a: 'hard', b: 'medium', players: 2, seed: 'ladder-hm', playouts: LADDER_PLAYOUTS }, 100);
  for (const g of games) {
    assert.ok(g.ended, `a game did not end (${g.error ?? 'no error'})`);
    assert.equal(g.refusals, 0, `the engine refused a bot action: ${g.error}`);
    assert.equal(g.offList, 0, 'a bot returned an action not in getValidActions');
  }
  const wins = games.filter((g) => g.levels[g.winner] === 'hard').length;
  const p = wins / games.length;
  const margin = games.reduce((s, g) => {
    const h = g.levels.indexOf('hard');
    return s + g.vp[h] - g.vp[1 - h];
  }, 0) / games.length;
  const turns = games.flatMap((g) => g.hardTurns).sort((x, y) => x - y);
  const mean = turns.reduce((s, x) => s + x, 0) / turns.length;
  console.log(`       Hard vs Medium: ${pct(p)} (sigma ${pct(sigma(p, games.length))}), mean margin ${margin.toFixed(1)} VP`);
  console.log(`       Hard turn time (Node, ${PROCS} processes sharing the machine): mean ${mean.toFixed(0)} ms, median ${turns[Math.floor(turns.length / 2)].toFixed(0)} ms, 95th ${turns[Math.floor(turns.length * 0.95)].toFixed(0)} ms, max ${turns[turns.length - 1].toFixed(0)} ms`);
  assert.ok(p >= 0.65, `Hard won only ${pct(p)}`);
});

console.log(failures ? `${failures} check(s) failed` : 'all bot-ladder checks passed');
process.exit(failures ? 1 : 0);
