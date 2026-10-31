// smoke.test.mjs - the engine survives whole games played by the random bot.
// Exits 1 on any failure. Every figure printed is also asserted on.
//
// Runs (T9: the whole rule set is in, so every action type, card and variant value is exercised):
//   - 500 random-bot games on default variants, 125 each at 2, 3, 4 and 5 players (timed);
//   - 24 random-bot games under EACH non-default variant value, the player counts mixed
//     (all 12 variants, every value implemented);
//   - 120 games under random COMBINATIONS of variant values;
//   - a constants probe (COSTS.COST_MOVE_2 = 0) that makes Move 2 free, to show the
//     R8.9 safety stop ends a degenerate Hour.
//
// Checked: every game ends by itself in Hour 5, ZERO refused proposals, never 0 or
// exactly 1 legal action offered, invariants after every action (coffee within 0..12
// under every-gain, no negative selfies, 8 Crew / 3 hats / 1 box / 6 Volunteers per
// player accounted for, no hall above capacity except the opening's over-full Entrance,
// cards conserved: 40 Achievements, 36 Swag), VP add up by source, and EVERY action
// type (all 34) is chosen at least once.

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
    // R19.1: hand size 2 (+1 per Achiever); Longbox Legion holds up to 3 more until its discards are done
    assert.ok(p.hand.length <= p.handSize + p.achieversUsed + (longboxPending(state, p.seat) ? 3 : 0), `${p.name} holds ${p.hand.length} Achievements`);
    // R2.2: the pieces are limited and always accounted for
    const mine = state.crew.filter((c) => c.owner === p.seat);
    assert.equal(mine.filter((c) => c.badge !== 'N00b').length + p.hats, K.SUPPLY.HATS_PER_PLAYER, `${p.name} hats`);
    assert.equal(mine.filter((c) => c.badge === 'AAA').length + p.boxes, K.SUPPLY.BOXES_PER_PLAYER, `${p.name} box`);
    assert.equal(Object.values(state.volunteers).filter((v) => v === p.seat).length + p.volunteers, K.SUPPLY.VOLUNTEERS_PER_PLAYER, `${p.name} Volunteers`);
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
  const aside = state.stack.filter((f) => f.kind === 'achieverKeep').reduce((a, f) => a + f.cards.length, 0);
  assert.equal(ach.deck.length + ach.discard.length + aside + state.players.reduce((a, p) => a + p.hand.length, 0), K.BOARD.ACHIEVEMENT_CARDS);
  const sw = state.swag;
  assert.equal(sw.deck.length + sw.discard.length + sw.market.filter((x) => x !== null).length, K.BOARD.SWAG_CARDS);
}

/** Whether a Longbox Legion discard is pending for the seat. */
function longboxPending(state, seat) {
  return state.stack.some((f) => f.kind === 'effect' && f.player === seat && f.source.card === 'club_05');
}

/** A hoarder: random, but never spends selfies on exchanges and favours the actions that gain them (to reach the Club hand limits). */
const hoarder = {
  chooseAction(state, { rng }) {
    const all = E.getValidActions(state);
    const weighted = [];
    for (const a of all) {
      if (a.type === 'exchange') continue;
      const w = ['clubPower', 'rareFinds', 'takeSelfie', 'strikeAPose'].includes(a.type) ? 6 : 1;
      for (let i = 0; i < w; i++) weighted.push(a);
    }
    return E.rngPick(rng, weighted.length > 0 ? weighted : all);
  },
};

function play(config, seed, botSeed, clubs = null, bot = randomBot) {
  const state = E.createGame(config, { seed });
  if (clubs) clubs.slice(0, state.players.length).forEach((club, seat) => (state.players[seat].club = club)); // force Clubs (the engine reads them from the state)
  const opening = E.hallCount(state, E.ENTRANCE);
  const rng = E.makeRng(botSeed);
  let steps = 0;
  while (!E.isGameOver(state)) {
    const actions = E.getValidActions(state);
    assert.ok(actions.length >= 2, `${actions.length} legal actions left for a player`);
    const a = bot.chooseAction(state, { rng });
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

run('500 random games on default variants (125 each at 2-5 players)', () => {
  const t0 = process.hrtime.bigint();
  let decisions = 0;
  const byCount = {};
  for (let g = 0; g < 500; g++) {
    const n = 2 + (g % 4);
    const before = totals.decisions;
    const s = play({ playerCount: n }, `smoke-${g}`, `smoke-bot-${g}`);
    decisions += totals.decisions - before;
    const sc = E.scoreGame(s);
    (byCount[n] ??= []).push(sc.players.map((p) => p.vp));
  }
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  console.log(`  500 random games: ${ms.toFixed(0)} ms (${(ms / 500).toFixed(1)} ms a game, invariants checked after every action), ${decisions} decisions`);
  for (const n of Object.keys(byCount)) {
    const all = byCount[n].flat();
    const mean = all.reduce((a, b) => a + b, 0) / all.length;
    console.log(`  ${n} players: mean VP per seat ${mean.toFixed(1)}`);
    assert.ok(mean > 0, 'random games score something');
  }
});

run('24 random games under each non-default variant value (all 12 variants)', () => {
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
  assert.deepEqual(E.UNIMPLEMENTED_VARIANT_VALUES, {}, 'every variant value is implemented');
  console.log(`  variant runs done: ${E.VARIANTS.reduce((a, v) => a + v.values.length - 1, 0)} non-default values x 24 games`);
});

run('60 games with the hand-limit Clubs forced on (clubHandLimits = on): Meeple Militia and TCG Traders discard at turn end', () => {
  for (let g = 0; g < 60; g++) {
    const s = play({ playerCount: 2 + (g % 4), variants: { clubHandLimits: 'on', clubs: 'off' } }, `limits-${g}`, `lb-${g}`, ['club_06', 'club_07', 'club_09', 'club_04', 'club_08'], hoarder);
    assert.equal(s.variants.clubHandLimits, 'on');
    assert.ok(s.players[0].club === 'club_06', 'the forced Club is in place');
  }
});

run('120 random games under random combinations of variant values', () => {
  const rng = E.makeRng('combos');
  for (let g = 0; g < 120; g++) {
    const variants = {};
    for (const v of E.VARIANTS) variants[v.name] = E.rngPick(rng, v.values);
    play({ playerCount: 2 + (g % 4), variants }, `combo-${g}`, `cb-${g}`);
  }
  console.log('  120 combination games done');
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

run('usage: all 34 action types were chosen at least once; zero refusals', () => {
  const implemented = Object.keys(E.ACTIONS).filter((t) => E.ACTIONS[t].implemented);
  assert.equal(implemented.length, 34, 'all 34 action types are implemented');
  assert.deepEqual(implemented.sort(), Object.keys(E.ACTIONS).sort());
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
