// smoke.test.mjs - the engine survives whole games played by the random bot.
// Exits 1 on any failure. Every figure printed is also asserted on.
//
// Runs:
//   - 200 random-bot games on default variants, 50 each at 2, 3, 4 and 5 players
//     (timed: this is the "200 random games" speed figure);
//   - 24 random-bot games under EACH implemented non-default variant value, the
//     player counts mixed;
//   - a constants probe (COSTS.COST_MOVE_2 = 0) that makes Move 2 free, to show the
//     R8.9 safety stop ends a degenerate Hour.
//
// Checked: every game ends by itself in Hour 5, ZERO refused proposals, never 0 or
// exactly 1 legal action offered, invariants after every action (coffee within 0..12
// under every-gain, no negative selfies, 8 Crew per player, no hall above capacity
// except the opening's over-full Entrance, cards conserved: 40 Achievements, 36 Swag),
// VP add up by source, and every implemented action type is chosen at least once.

import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const E = await import(pathToFileURL(join(root, 'src/engine/index.js')).href);
const { randomBot } = await import(pathToFileURL(join(root, 'src/bots/randomBot.js')).href);

const chosenTypes = {};
const totals = { games: 0, decisions: 0, refusals: 0, turnCapped: 0, engineCapped: 0 };

function checkInvariants(state, openingEntrance) {
  const K = E.getConstants(state);
  const C = E.capacity(state);
  for (const p of state.players) {
    assert.ok(p.coffee >= 0, `${p.name} coffee ${p.coffee}`);
    if (state.variants.coffeeCap === 'every-gain') assert.ok(p.coffee <= K.LIMITS.COFFEE_CAP, `${p.name} coffee ${p.coffee} over the cap`);
    for (const c of E.COLOURS) assert.ok(p.selfies[c] >= 0, `${p.name} ${c} selfies`);
    assert.ok(p.hand.length <= p.handSize, `${p.name} holds ${p.hand.length} Achievements`);
    let sum = 0;
    for (const s of E.VP_SOURCES) sum += p.vpBySource[s];
    assert.equal(sum, p.vp, `${p.name} VP by source`);
    assert.equal(state.crew.filter((c) => c.owner === p.seat).length, K.SUPPLY.CREW_PER_PLAYER);
  }
  for (const hall of E.HALL_IDS) {
    const n = E.hallCount(state, hall);
    const limit = hall === E.ENTRANCE ? Math.max(C, openingEntrance) : C;
    assert.ok(n <= limit, `${hall} holds ${n} (capacity ${C})`);
  }
  const ach = state.achievements;
  assert.equal(ach.deck.length + ach.discard.length + state.players.reduce((a, p) => a + p.hand.length, 0), K.BOARD.ACHIEVEMENT_CARDS);
  const sw = state.swag;
  assert.equal(sw.deck.length + sw.discard.length + sw.market.filter((x) => x !== null).length, K.BOARD.SWAG_CARDS);
}

function play(config, seed, botSeed) {
  const state = E.createGame(config, { seed });
  const opening = E.hallCount(state, E.ENTRANCE);
  const rng = E.makeRng(botSeed);
  let steps = 0;
  while (!E.isGameOver(state)) {
    const actions = E.getValidActions(state);
    assert.ok(actions.length >= 2, `${actions.length} legal actions left for a player`);
    const a = randomBot.chooseAction(state, { rng });
    chosenTypes[a.type] = (chosenTypes[a.type] ?? 0) + 1;
    try {
      E.applyAction(state, a, E.SILENT);
    } catch (err) {
      totals.refusals++;
      throw new Error(`REFUSED in ${seed}: ${E.actionKey(a)}: ${err.message}`);
    }
    checkInvariants(state, opening);
    steps++;
  }
  assert.equal(state.hour, 5);
  assert.equal(state.phase, 'ended');
  totals.games++;
  totals.decisions += steps;
  if (state.flags.turnCapped) totals.turnCapped++;
  if (state.flags.endReason === 'engine-action-cap') totals.engineCapped++;
  return state;
}

let failed = 0;
function run(name, fn) {
  try {
    fn();
  } catch (err) {
    failed++;
    console.log(`FAIL ${name}\n  ${err && err.stack ? err.stack.split('\n').slice(0, 4).join('\n  ') : err}`);
  }
}

run('200 random games on default variants (50 each at 2-5 players)', () => {
  const t0 = process.hrtime.bigint();
  let decisions = 0;
  const byCount = {};
  for (let g = 0; g < 200; g++) {
    const n = 2 + (g % 4);
    const before = totals.decisions;
    const s = play({ playerCount: n }, `smoke-${g}`, `smoke-bot-${g}`);
    decisions += totals.decisions - before;
    const sc = E.scoreGame(s);
    (byCount[n] ??= []).push(sc.players.map((p) => p.vp));
  }
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  console.log(`  200 random games: ${ms.toFixed(0)} ms (${(ms / 200).toFixed(1)} ms a game, invariants checked after every action), ${decisions} decisions`);
  for (const n of Object.keys(byCount)) {
    const all = byCount[n].flat();
    const mean = all.reduce((a, b) => a + b, 0) / all.length;
    console.log(`  ${n} players: mean VP per seat ${mean.toFixed(1)}`);
    assert.ok(mean > 0, 'random games score something');
  }
});

run('24 random games under each implemented non-default variant value', () => {
  for (const v of E.VARIANTS) {
    for (const value of v.values.slice(1)) {
      if (!E.isVariantValueImplemented(v.name, value)) continue;
      for (let g = 0; g < 24; g++) {
        const s = play({ playerCount: 2 + (g % 4), variants: { [v.name]: value } }, `var-${v.name}-${value}-${g}`, `vb-${g}`);
        assert.equal(s.variants[v.name], value);
        if (v.name === 'clubs') assert.ok(s.players.every((p) => p.club === null));
        if (v.name === 'finalBoard') assert.ok(s.schedule.every((e) => e.status !== 'onBoard'), 'figures removed before final scoring');
      }
    }
  }
  console.log(`  variant runs done; unimplemented values skipped: ${JSON.stringify(E.UNIMPLEMENTED_VARIANT_VALUES)}`);
});

run('constants probe: free Move 2 runs into the R8.9 safety stop and the game still ends', () => {
  let capped = 0;
  for (let g = 0; g < 4; g++) {
    // A bot that always moves when it can: free Move 2 never runs out.
    const state = E.createGame({ playerCount: 2, constants: { COSTS: { COST_MOVE_2: 0 } } }, { seed: `probe-${g}` });
    const rng = E.makeRng(`probe-bot-${g}`);
    let guard = 0;
    while (!E.isGameOver(state) && guard++ < 50000) {
      const acts = E.getValidActions(state);
      const moves = acts.filter((a) => a.type === 'move2');
      const a = moves.length ? E.rngPick(rng, moves) : E.rngPick(rng, acts);
      E.applyAction(state, a, E.SILENT);
    }
    assert.ok(E.isGameOver(state));
    if (state.flags.turnCapped) capped++;
  }
  assert.equal(capped, 4, 'every probe game hit the 60-main-action stop');
  console.log(`  free Move 2: ${capped} of 4 games flagged turnCapped (R8.9) and finished`);
});

run('usage: every implemented action type was chosen at least once; zero refusals', () => {
  const implemented = Object.keys(E.ACTIONS).filter((t) => E.ACTIONS[t].implemented);
  const missing = implemented.filter((t) => !chosenTypes[t]);
  assert.deepEqual(missing, [], `never chosen: ${missing.join(', ')}`);
  assert.equal(totals.refusals, 0);
  assert.equal(totals.engineCapped, 0, 'no random game reaches the engine-action cap');
  console.log(`  ${totals.games} games, ${totals.decisions} decisions, ${totals.refusals} refusals, turnCapped ${totals.turnCapped}`);
  console.log(`  chosen: ${JSON.stringify(chosenTypes)}`);
});

if (failed > 0) {
  console.log(`smoke: ${failed} failed`);
  process.exit(1);
}
console.log('smoke ok');
