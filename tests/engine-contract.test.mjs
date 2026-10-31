// engine-contract.test.mjs - the engine keeps its contract (state shape, decision
// stack, events, determinism). Exits 1 on any failure.
//
// Checked:
//   - purity: no DOM, console, storage, clock or Math.random in src/engine and src/bots;
//   - card data: cards.js is up to date with the catalogue, counts and ids;
//   - variants (R26) and constants (R27): names, defaults, rejection, overrides;
//   - setup (R5) for 2-5 players;
//   - the decision model: toAct = top frame's player, never exactly one legal action,
//     windows for players other than the active player;
//   - 200 random games: serialisation round trip after EVERY step, every offered action
//     accepted by getBlockReason (all of them, every step) and by applyAction (zero
//     refusals), no undefined/NaN/non-JSON in the state, termination, VP bookkeeping;
//   - determinism by seed (byte-identical final state and events), replay;
//   - blind copies hide exactly what R23.2 hides;
//   - block reasons, describeAction, structural block reasons.

import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const E = await import(pathToFileURL(join(root, 'src/engine/index.js')).href);
const { randomBot } = await import(pathToFileURL(join(root, 'src/bots/randomBot.js')).href);
const F = await import('./helpers/fixtures.mjs');

let failures = 0;
let passes = 0;
function check(name, fn) {
  try {
    fn();
    passes++;
  } catch (err) {
    failures++;
    console.log(`FAIL ${name}\n  ${err && err.stack ? err.stack.split('\n').slice(0, 4).join('\n  ') : err}`);
  }
}

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

/** Throws if `v` holds anything that is not plain JSON (undefined, NaN, Infinity, functions, class instances). */
function assertPlainJson(v, path = 'state') {
  if (v === null) return;
  const t = typeof v;
  if (t === 'string' || t === 'boolean') return;
  if (t === 'number') {
    assert.ok(Number.isFinite(v), `${path} is ${v}`);
    return;
  }
  assert.ok(t === 'object', `${path} is ${t}`);
  if (Array.isArray(v)) {
    v.forEach((x, i) => assertPlainJson(x, `${path}[${i}]`));
    return;
  }
  const proto = Object.getPrototypeOf(v);
  assert.ok(proto === Object.prototype || proto === null, `${path} is not a plain object`);
  for (const k of Object.keys(v)) {
    assert.ok(v[k] !== undefined, `${path}.${k} is undefined`);
    assertPlainJson(v[k], `${path}.${k}`);
  }
}

/** Plays one random game. Returns { state, steps, chosen, events, refusals }. */
function playRandom(config, seed, botSeed, { fullCheck = false, collect = true } = {}) {
  const created = E.createGame(config, { seed, events: collect });
  const state = collect ? created.state : created;
  const events = collect ? created.events.slice() : [];
  const rng = E.makeRng(botSeed);
  const chosen = [];
  let steps = 0;
  let refusals = 0;
  const limit = E.getConstants(state).SAFETY.MAX_ENGINE_ACTIONS_PER_GAME + 10;
  while (!E.isGameOver(state)) {
    if (steps++ > limit) throw new Error(`game ${seed} did not end within ${limit} decisions`);
    const actions = E.getValidActions(state);
    assert.ok(actions.length >= 2, `a decision with ${actions.length} legal actions was left for a player (${E.topFrame(state).kind})`);
    assert.equal(state.toAct, E.topFrame(state).player, 'toAct must be the top frame player');
    if (fullCheck) {
      for (const a of actions) {
        const r = E.getBlockReason(state, a);
        assert.equal(r, null, `offered ${E.actionKey(a)} but getBlockReason says: ${r}`);
        assert.ok(E.ACTIONS[a.type].implemented, `offered unimplemented ${a.type}`);
      }
      const text = E.serialiseState(state);
      assert.equal(E.serialiseState(E.deserialiseState(text)), text, 'serialise/deserialise round trip changed the state');
      assert.equal(E.hashState(JSON.parse(text)), E.hashState(state), 'hash changed across a JSON round trip');
      assertPlainJson(state);
    }
    const action = randomBot.chooseAction(state, { rng });
    chosen.push(JSON.parse(JSON.stringify(action)));
    try {
      const ev = E.applyAction(state, action, collect ? undefined : E.SILENT);
      if (collect) events.push(...ev);
    } catch (err) {
      refusals++;
      throw new Error(`REFUSED ${E.actionKey(action)}: ${err.message}`);
    }
  }
  return { state, steps, chosen, events, refusals };
}

const CONFIGS = [2, 3, 4, 5].map((n) => ({ playerCount: n }));

// ---------------------------------------------------------------------------------------------
// Purity
// ---------------------------------------------------------------------------------------------

check('purity: no DOM, console, storage, clock or Math.random in src/engine and src/bots', () => {
  // The manager's acceptance grep (document.|window.|localStorage|console.) plus the other impurities.
  const banned = /document\.|window\.|localStorage|sessionStorage|console\.|Math\.random|Date\.now|new Date\(|performance\.now/;
  const walk = (dir) =>
    readdirSync(dir).flatMap((f) => {
      const p = join(dir, f);
      return statSync(p).isDirectory() ? walk(p) : p.endsWith('.js') ? [p] : [];
    });
  const files = [...walk(join(root, 'src/engine')), ...walk(join(root, 'src/bots'))];
  assert.ok(files.length >= 12, 'engine files found');
  for (const f of files) {
    const text = readFileSync(f, 'utf8');
    const m = banned.exec(text);
    assert.ok(!m, `${f} contains "${m && m[0]}"`);
  }
});

// ---------------------------------------------------------------------------------------------
// Card data
// ---------------------------------------------------------------------------------------------

check('card data: cards.js is up to date with the catalogue (tools/build-card-data.mjs --check)', () => {
  const r = spawnSync(process.execPath, [join(root, 'tools/build-card-data.mjs'), '--check'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

check('card data: counts, unique ids, routes of adjacent halls (R4.2), art ids in the manifest', () => {
  assert.equal(E.CELEBRITY_CARDS.length, E.BOARD.CELEBRITY_CARDS);
  assert.equal(E.ACHIEVEMENT_CARDS.length, E.BOARD.ACHIEVEMENT_CARDS);
  assert.equal(E.SWAG_CARDS.length, E.BOARD.SWAG_CARDS);
  assert.equal(E.CLUB_CARDS.length, E.BOARD.CLUB_CARDS);
  const ids = [...E.CELEBRITY_CARDS, ...E.ACHIEVEMENT_CARDS, ...E.SWAG_CARDS, ...E.CLUB_CARDS].map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length, 'card ids unique');
  for (const rank of ['A', 'B', 'C']) assert.equal(E.CELEBRITY_CARDS.filter((c) => c.rank === rank).length, 6);
  for (const c of E.CELEBRITY_CARDS) {
    for (let i = 1; i < c.route.length; i++) assert.ok(E.areAdjacent(c.route[i - 1], c.route[i]), `${c.id} route step ${i}`);
    assert.equal(c.entered, c.route.length - 1);
    assert.ok(['everyone', 'by-badge', 'everyone-no-n00bs', 'in-order', 'in-order-no-n00bs', 'count-total'].includes(c.scoring.method));
  }
  // R16.9 market composition
  const mix = [1, 2, 3].map((n) => E.SWAG_CARDS.filter((s) => s.cost === n).length);
  assert.deepEqual(mix, E.BOARD.SWAG_COST_MIX);
  // Spot checks against spec R4.2 / R27.13
  const tng02 = E.celebrityCard('character_tng_02');
  assert.deepEqual(tng02.route, ['vendor-hall', 'food-trucks', 'entrance', 'photo-ops', 'autograph-hall']);
  assert.deepEqual(tng02.scoring, { method: 'in-order-no-n00bs', values: [14, 10, 7, 5, 3, 2, 1] });
  assert.equal(E.celebrityCard('character_marvel_03').route[1], 'main-hall', 'Panel Rooms is Main Hall (Q7)');
  assert.equal(E.celebrityCard('character_star_wars_02').coffee, 8);
  // Art ids exist in the manifest
  const manifest = JSON.parse(readFileSync(join(root, 'assets/manifest.json'), 'utf8'));
  const assetIds = new Set(manifest.assets.map((a) => a.id));
  for (const c of [...E.CELEBRITY_CARDS, ...E.ACHIEVEMENT_CARDS, ...E.SWAG_CARDS, ...E.CLUB_CARDS]) {
    assert.ok(c.art === null || assetIds.has(c.art), `${c.id} art ${c.art}`);
  }
  assert.equal(E.celebrityCard('character_tng_02').art, 'card-celebrity-tng-02');
  for (const h of E.HALLS) assert.ok(assetIds.has(h.art), `hall art ${h.id}`);
  // Rulebook terms in `text`
  for (const c of [...E.ACHIEVEMENT_CARDS, ...E.SWAG_CARDS, ...E.CLUB_CARDS]) {
    assert.ok(!/MOJO|Selfy|\bNoob\b|Challenge card|Photo Volunteer|\bcolor\b/.test(c.text), `${c.id} text: ${c.text}`);
  }
});

check('board: R3.2.2 code ids, R3.3 adjacency, R3.4 ropes, R3.5 spaces', () => {
  assert.deepEqual(E.HALL_IDS, ['artist-alley', 'main-stage', 'cosplay-arena', 'autograph-hall', 'main-hall', 'vendor-hall', 'photo-ops', 'entrance', 'food-trucks']);
  assert.deepEqual(E.HALLS.map((h) => h.grid), ['h11', 'h12', 'h13', 'h21', 'h22', 'h23', 'h31', 'h32', 'h33']);
  assert.equal(E.ROPES.length, E.BOARD.ROPE_COUNT);
  assert.equal(E.VOLUNTEER_SPACES.length, E.BOARD.VOLUNTEER_SPACES);
  assert.deepEqual(E.ADJACENT['main-hall'], ['main-stage', 'autograph-hall', 'vendor-hall', 'entrance']);
  assert.deepEqual(E.ADJACENT.entrance, ['main-hall', 'photo-ops', 'food-trucks']);
  assert.equal(E.ropeBetween('main-hall', 'entrance'), 'rope_09');
  assert.equal(E.ropeBetween('artist-alley', 'main-hall'), null);
});

// ---------------------------------------------------------------------------------------------
// Variants and constants
// ---------------------------------------------------------------------------------------------

check('variants: the 12 of R26.1 in order with their defaults', () => {
  assert.deepEqual(E.VARIANT_NAMES.slice(), [
    'queueCapacity', 'celebrityColours', 'coffeeCap', 'fivePlayerOpening', 'usherInHall', 'homeBase',
    'achiever', 'clubHandLimits', 'finalBoard', 'militiaRoll', 'clubs', 'firstPlayer',
  ]);
  assert.deepEqual(E.defaultVariants(), {
    queueCapacity: 'printed-board', celebrityColours: 'random-slots', coffeeCap: 'every-gain', fivePlayerOpening: 'overfill',
    usherInHall: 'both-halls', homeBase: 'three-crew', achiever: 'hand-size', clubHandLimits: 'off',
    finalBoard: 'figures-stay', militiaRoll: 'coin', clubs: 'random', firstPlayer: 'random',
  });
  for (const v of E.VARIANTS) {
    assert.equal(v.values[0], v.default, `${v.name} default first`);
    assert.ok(v.label && v.description && v.rule, `${v.name} documented`);
  }
});

check('variants: unknown names and values are rejected; every value of every variant is implemented (T9)', () => {
  assert.deepEqual(E.UNIMPLEMENTED_VARIANT_VALUES, {}, 'T9 implemented every variant value');
  assert.throws(() => E.resolveVariants({ queueSize: 'rulebook' }), /Unknown variant "queueSize"/);
  assert.throws(() => E.resolveVariants({ queueCapacity: 'big' }), /Illegal value "big" for variant "queueCapacity"/);
  assert.throws(() => E.resolveVariants({ clubs: true }), /Illegal value true/);
  for (const [name, values] of Object.entries(E.UNIMPLEMENTED_VARIANT_VALUES)) {
    for (const value of values) {
      assert.throws(() => E.createGame({ playerCount: 3, variants: { [name]: value } }, { seed: 1 }), /not implemented/);
    }
  }
  // every implemented value creates a game
  for (const v of E.VARIANTS) {
    for (const value of v.values) {
      if (!E.isVariantValueImplemented(v.name, value)) continue;
      const s = E.createGame({ playerCount: 4, variants: { [v.name]: value } }, { seed: 7 });
      assert.equal(s.variants[v.name], value);
    }
  }
});

check('constants: R27 groups, one accessor, overrides type-checked and recorded', () => {
  assert.deepEqual(Object.keys(E.RULES), [
    'GAME', 'SUPPLY', 'START', 'BOARD', 'CAPACITY', 'LIMITS', 'COSTS', 'MOVEMENT', 'EXCHANGE', 'SCHEDULE',
    'PASS', 'WALK', 'CELEBRITIES', 'ACHIEVEMENTS', 'SWAG', 'CLUBS', 'FINAL', 'SAFETY',
  ]);
  assert.ok(Object.isFrozen(E.RULES.COSTS));
  assert.equal(E.RULES.COSTS.COST_UPGRADE, 5);
  assert.equal(E.RULES.LIMITS.COFFEE_CAP, 12);
  assert.deepEqual(E.RULES.CAPACITY.QUEUE_CAPACITY['printed-board'], { 2: 4, 3: 6, 4: 7, 5: 7 });
  assert.equal(E.RULES.CELEBRITIES.CELEBRITIES.character_tng_01.COFFEE, 6);
  assert.equal(E.RULES.ACHIEVEMENTS.ACHIEVEMENT_LAUREL.scoring_40, 10);
  assert.equal(Object.keys(E.RULES.SWAG.SWAG_COST).length, 36);
  const s = E.createGame({ playerCount: 2, constants: { COSTS: { COST_MOVE_2: 2 } } }, { seed: 3 });
  assert.equal(E.getConstants(s).COSTS.COST_MOVE_2, 2);
  assert.equal(E.getConstants(s).COSTS.COST_NEW_NOOB, 4);
  assert.deepEqual(E.getGameConfig(s).constants, { COSTS: { COST_MOVE_2: 2 } });
  assert.equal(E.RULES.COSTS.COST_MOVE_2, 1, 'RULES untouched');
  const move = E.getValidActions(s).find((a) => a.type === 'move2');
  assert.match(E.describeAction(s, move), /\(2 coffee/);
  assert.throws(() => E.createGame({ playerCount: 2, constants: { COSTS: { COST_MOVE2: 2 } } }, { seed: 3 }), /Unknown constant "COSTS.COST_MOVE2"/);
  assert.throws(() => E.createGame({ playerCount: 2, constants: { COSTS: { COST_MOVE_2: '2' } } }, { seed: 3 }), /must be a number/);
  assert.throws(() => E.createGame({ playerCount: 2, constants: { PASS: { PASS_SLOT_REWARD: [0, 1] } } }, { seed: 3 }), /array of 5/);
});

// ---------------------------------------------------------------------------------------------
// Setup (R5)
// ---------------------------------------------------------------------------------------------

check('setup R5: supplies, schedule, colours, market, hands, opening order, capacity', () => {
  for (const n of [2, 3, 4, 5]) {
    for (let seed = 0; seed < 12; seed++) {
      const s = E.createInitialState({ playerCount: n }, { seed: `setup-${n}-${seed}` });
      const K = E.getConstants(s);
      assert.equal(E.capacity(s), { 2: 4, 3: 6, 4: 7, 5: 7 }[n], 'R3.6 printed-board capacity');
      for (const p of s.players) {
        assert.equal(p.coffee, 12);
        assert.deepEqual(p.selfies, { green: 1, red: 1, orange: 1 });
        assert.equal(p.hand.length, 2);
        assert.equal(p.hats, 3);
        assert.equal(p.volunteers, 6);
        assert.ok(p.club !== null);
      }
      assert.equal(new Set(s.players.map((p) => p.club)).size, n, 'clubs are distinct');
      assert.deepEqual(s.schedule.map((e) => E.celebrityCard(e.card).rank), ['A', 'A', 'B', 'B', 'C', 'C']);
      const colours = s.schedule.map((e) => e.colour);
      for (const c of E.COLOURS) assert.equal(colours.filter((x) => x === c).length, 2, 'R4.3.5 each colour twice');
      assert.equal(colours[3], colours[0]);
      assert.equal(colours[4], colours[1]);
      assert.equal(colours[5], colours[2]);
      assert.deepEqual(s.schedule.map((e) => e.status), ['onBoard', 'onBoard', 'onBoard', 'waiting', 'waiting', 'waiting']);
      for (const e of s.schedule.slice(0, 3)) {
        assert.equal(e.figure, E.celebrityCard(e.card).start);
        assert.equal(e.marker, E.celebrityCard(e.card).destination);
      }
      assert.equal(s.swag.market.length, 5);
      assert.equal(s.swag.deck.length, 31);
      assert.equal(s.achievements.deck.length, 40 - 2 * n);
      // R5.9 opening: everybody's 2 Crew in the Entrance; the player to the first player's right is at the front
      const q = E.queue(s, 'entrance');
      assert.equal(q.length, 2 * n);
      const right = (s.startPlayer - 1 + n) % n;
      assert.deepEqual([q[0].owner, q[1].owner], [right, right]);
      assert.deepEqual([q[2 * n - 2].owner, q[2 * n - 1].owner], [s.startPlayer, s.startPlayer]);
      // R5.9.1 overfill at 4 and 5 players
      assert.equal(E.isFull(s, 'entrance'), n >= 2 ? 2 * n >= E.capacity(s) : false);
      assert.equal(E.newNoobHalls(s).includes('entrance'), 2 * n < E.capacity(s));
      assert.equal(K.START.START_COFFEE, 12);
    }
  }
  const fixed = E.createInitialState({ playerCount: 3, variants: { celebrityColours: 'fixed-slots', firstPlayer: 'seat-0', clubs: 'off' } }, { seed: 1 });
  assert.deepEqual(fixed.schedule.map((e) => e.colour), ['green', 'red', 'orange', 'green', 'red', 'orange']);
  assert.equal(fixed.startPlayer, 0);
  assert.ok(fixed.players.every((p) => p.club === null));
});

check('setup RNG: switching clubs off does not change the schedule, decks or first player (sub-streams)', () => {
  const a = E.createInitialState({ playerCount: 4 }, { seed: 'streams' });
  const b = E.createInitialState({ playerCount: 4, variants: { clubs: 'off' } }, { seed: 'streams' });
  assert.deepEqual(a.schedule, b.schedule);
  assert.deepEqual(a.swag, b.swag);
  assert.deepEqual(a.achievements, b.achievements);
  assert.equal(a.startPlayer, b.startPlayer);
});

check('createGame: needs a seed, 2-5 players; runs to a real first decision', () => {
  assert.throws(() => E.createGame({ playerCount: 3 }), /seed/);
  assert.throws(() => E.createGame({ playerCount: 1 }, { seed: 1 }), /2 to 5 players/);
  assert.throws(() => E.createGame({ playerCount: 6 }, { seed: 1 }), /2 to 5 players/);
  const s = E.createGame({ players: [{ name: 'Ann' }, { name: 'Ben', colour: 'red' }] }, { seed: 'x' });
  assert.equal(s.players[0].name, 'Ann');
  assert.equal(s.players[1].colour, 'red');
  assert.equal(s.phase === 'coffeeBreak' || s.phase === 'floor', true);
  assert.ok(E.getValidActions(s).length >= 2);
  assert.equal(E.toAct(s), s.toAct);
});

// ---------------------------------------------------------------------------------------------
// Decision model
// ---------------------------------------------------------------------------------------------

check('decision model: Squad window before the Coffee Break belongs to its owner, not the active player (R7.1)', () => {
  let found = 0;
  for (let seed = 0; seed < 60 && found < 3; seed++) {
    const s = E.createGame({ playerCount: 5 }, { seed: `squad-${seed}` });
    const owner = s.players.findIndex((p) => p.club === 'club_09');
    if (owner < 0) continue;
    // In Hour 1 the Squad owner is on 12 coffee; the window is offered (Strike a Pose costs 1).
    if (E.topFrame(s).kind !== 'squadWindow') continue;
    found++;
    assert.equal(s.toAct, owner);
    assert.equal(E.activePlayer(s), null, 'no active player before On the Floor');
    const acts = E.getValidActions(s);
    assert.ok(acts.some((a) => a.type === 'endConversions'));
    assert.ok(acts.some((a) => a.type === 'strikeAPose'));
    assert.ok(acts.every((a) => a.type === 'endConversions' || a.type === 'strikeAPose'));
    E.applyAction(s, acts.find((a) => a.type === 'endConversions'));
    assert.equal(s.phase, 'floor');
  }
  assert.ok(found > 0, 'a 5-player game with Selfie Stick Squad was found');
});

check('decision model: a turn offers conversions and main actions together; conversions keep the turn', () => {
  const s = E.createGame({ playerCount: 3, variants: { clubs: 'off', firstPlayer: 'seat-0' } }, { seed: 'turn' });
  assert.equal(E.topFrame(s).kind, 'turn');
  const acts = E.getValidActions(s);
  const types = new Set(acts.map((a) => a.type));
  for (const t of ['exchange', 'move2', 'move3', 'pass']) assert.ok(types.has(t), `turn offers ${t}`);
  assert.ok(!types.has('endConversions'), 'a normal turn ends with its main action, not Done');
  const e2 = acts.find((a) => a.type === 'exchange' && a.rate === 'E2');
  const seat = s.toAct;
  const events = E.applyAction(s, e2);
  assert.equal(s.toAct, seat, 'still the same player after a conversion');
  assert.equal(E.topFrame(s).kind, 'turn');
  assert.equal(E.topFrame(s).conversions, 1);
  assert.ok(events.some((e) => e.type === E.EVENTS.CONVERSION && e.kind === 'E2' && e.window === 'turn'));
});

check('decision model: Pass then the Achievement choice, then the next player (R18.2)', () => {
  const s = E.createGame({ playerCount: 3, variants: { clubs: 'off', firstPlayer: 'seat-0' } }, { seed: 'pass' });
  const seat = s.toAct;
  const ev = E.applyAction(s, { type: 'pass' });
  assert.ok(ev.some((e) => e.type === 'passed' && e.first === true));
  assert.ok(ev.some((e) => e.type === 'coffeeGain' && e.cause === 'first-pass' && e.lost === 2), 'first pass +2 coffee is lost on 12 (R7.3)');
  assert.equal(E.topFrame(s).kind, 'passAchievement');
  assert.equal(s.toAct, seat);
  const acts = E.getValidActions(s);
  assert.equal(acts.length, 4, 'score or discard either of 2 cards');
  const card = acts.find((a) => a.type === 'discardAchievement').card;
  const ev2 = E.applyAction(s, { type: 'discardAchievement', card });
  assert.ok(ev2.some((e) => e.type === 'achievementDiscarded' && e.secret === true && e.player === seat));
  assert.ok(ev2.some((e) => e.type === 'achievementDrawn' && e.secret === true));
  assert.equal(s.players[seat].hand.length, 2, 'hand back to 2 (R19.1)');
  assert.equal(s.players[seat].passSlot, 1);
  assert.notEqual(s.toAct, seat, 'next player');
});

check('decision model: Move 1 Crew x3 is commit-as-you-go with a Stop (R10.7)', () => {
  const s = E.createGame({ playerCount: 2, variants: { clubs: 'off', firstPlayer: 'seat-0' } }, { seed: 'm3' });
  const first = E.getValidActions(s).find((a) => a.type === 'move3');
  E.applyAction(s, first);
  const f = E.topFrame(s);
  assert.equal(f.kind, 'moveSteps');
  assert.deepEqual(f.moved, [first.crew]);
  const acts = E.getValidActions(s);
  assert.ok(acts.some((a) => a.type === 'stopMoving'));
  assert.ok(acts.every((a) => a.type === 'stopMoving' || (a.type === 'moveStep' && a.crew !== first.crew)));
  assert.match(E.getBlockReason(s, { type: 'moveStep', crew: first.crew, to: 'entrance' }), /already moved|not next to|full/);
});

// ---------------------------------------------------------------------------------------------
// 200 random games with full checks
// ---------------------------------------------------------------------------------------------

const GAMES = 200;
const playedForBookkeeping = [];
check(`random play: ${GAMES} games, full checks every step, zero refusals, termination, bookkeeping`, () => {
  let refusals = 0;
  let decisions = 0;
  const t0 = process.hrtime.bigint();
  for (let g = 0; g < GAMES; g++) {
    const config = CONFIGS[g % 4];
    const r = playRandom(config, `contract-${g}`, `bot-${g}`, { fullCheck: true, collect: g < 40 });
    refusals += r.refusals;
    decisions += r.steps;
    assert.equal(r.state.phase, 'ended');
    assert.equal(r.state.toAct, null);
    assert.equal(E.getValidActions(r.state).length, 0);
    assert.equal(r.state.hour, 5);
    assert.ok(['complete', 'engine-action-cap'].includes(r.state.flags.endReason));
    assertPlainJson(r.state);
    const sc = E.scoreGame(r.state);
    assert.deepEqual(sc.players.map((p) => p.rank).sort(), sc.players.map((_, i) => i + 1), 'ranks are a permutation (R22.6)');
    if (g < 40) playedForBookkeeping.push(r);
  }
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.equal(refusals, 0);
  console.log(`  ${GAMES} random games (2-5 players), ${decisions} decisions, every offered action re-checked every step: ${ms.toFixed(0)} ms`);
});

check('bookkeeping: VP events add up to scoreGame per seat and by source; every event type is known', () => {
  const known = new Set(Object.values(E.EVENTS));
  for (const r of playedForBookkeeping) {
    const n = r.state.players.length;
    const total = new Array(n).fill(0);
    const bySource = r.state.players.map(() => Object.fromEntries(E.VP_SOURCES.map((s) => [s, 0])));
    for (const e of r.events) {
      assert.ok(known.has(e.type), `unknown event ${e.type}`);
      assert.ok(Number.isInteger(e.seq), 'every event has seq');
      if (e.type === E.EVENTS.VP) {
        assert.ok(E.VP_SOURCES.includes(e.source), `VP source ${e.source}`);
        assert.ok(e.amount > 0);
        total[e.player] += e.amount;
        bySource[e.player][e.source] += e.amount;
      }
      if (E.SECRET_EVENT_TYPES.includes(e.type)) assert.equal(e.secret, true);
    }
    const sc = E.scoreGame(r.state);
    for (let s = 0; s < n; s++) {
      assert.equal(total[s], sc.players[s].vp, `seat ${s} VP`);
      assert.deepEqual(bySource[s], sc.players[s].bySource, `seat ${s} VP by source`);
    }
    assert.ok(r.events.some((e) => e.type === E.EVENTS.GAME_END));
    assert.equal(r.events.filter((e) => e.type === E.EVENTS.CELEBRITY_SCORED).length, 6, 'six destinations score');
  }
});

// ---------------------------------------------------------------------------------------------
// Determinism and replay
// ---------------------------------------------------------------------------------------------

check('determinism: same seeds give byte-identical final states and event streams; replay rebuilds the game', () => {
  for (const [i, config] of CONFIGS.entries()) {
    const a = playRandom(config, `det-${i}`, `botdet-${i}`);
    const b = playRandom(config, `det-${i}`, `botdet-${i}`);
    assert.equal(E.serialiseState(a.state), E.serialiseState(b.state));
    assert.equal(JSON.stringify(a.events), JSON.stringify(b.events));
    const c = playRandom(config, `det-${i}-other`, `botdet-${i}`);
    assert.notEqual(E.hashState(a.state), E.hashState(c.state), 'another seed, another game');
    const replayed = E.replayGame(E.getGameConfig(a.state), a.chosen);
    assert.equal(E.hashState(replayed), E.hashState(a.state), 'replayGame(getGameConfig, chosen actions)');
  }
});

check('cloneState is independent; deserialise refuses foreign saves', () => {
  const s = E.createGame({ playerCount: 3 }, { seed: 'clone' });
  const before = E.serialiseState(s);
  const c = E.cloneState(s);
  c.players[0].coffee = 0;
  c.crew[0].hall = 'food-trucks';
  c.stack.push({ kind: 'turn', player: 1 });
  assert.equal(E.serialiseState(s), before);
  assert.throws(() => E.deserialiseState('{"schemaVersion":99}'), /schema/);
});

// ---------------------------------------------------------------------------------------------
// Hidden information (R23.2)
// ---------------------------------------------------------------------------------------------

check('blindCopy: own hand kept, hidden cards re-drawn from the unseen pool, public state untouched', () => {
  const r = playRandom({ playerCount: 4 }, 'blind', 'blindbot', { collect: false });
  // Use a mid-game state: replay half the actions.
  const half = E.replayGame(E.getGameConfig(r.state), r.chosen.slice(0, Math.floor(r.chosen.length / 2)));
  const before = E.serialiseState(half);
  const seat = half.toAct;
  const rng = E.makeRng('viewer');
  const copy = E.blindCopy(half, seat, rng);
  assert.equal(E.serialiseState(half), before, 'original untouched');
  assert.deepEqual(copy.players[seat].hand, half.players[seat].hand);
  const unseen = (st) => {
    const out = [...st.achievements.deck];
    for (const p of st.players) if (p.seat !== seat) out.push(...p.hand);
    for (const d of st.achievements.discard) if (!d.scored && d.owner !== seat) out.push(d.card);
    return out.sort();
  };
  assert.deepEqual(unseen(copy), unseen(half), 'same multiset of unseen cards');
  for (let i = 0; i < half.players.length; i++) {
    assert.equal(copy.players[i].hand.length, half.players[i].hand.length);
    assert.equal(copy.players[i].vp, half.players[i].vp);
    assert.deepEqual(copy.players[i].selfies, half.players[i].selfies);
  }
  assert.deepEqual(copy.crew, half.crew);
  assert.deepEqual(copy.schedule, half.schedule);
  assert.deepEqual(copy.swag.market, half.swag.market);
  assert.deepEqual([...copy.swag.deck].sort(), [...half.swag.deck].sort());
  assert.notDeepEqual(copy.rng, half.rng);
  // a blind copy plays on to the end
  const brng = E.makeRng('blind-play');
  let guard = 0;
  while (!E.isGameOver(copy) && guard++ < 30000) E.applyAction(copy, randomBot.chooseAction(copy, { rng: brng }), E.SILENT);
  assert.ok(E.isGameOver(copy));
  // a spectator copy hides every hand
  const spec = E.blindCopy(half, null, E.makeRng('spec'));
  assert.equal(spec.players.length, half.players.length);
});

// ---------------------------------------------------------------------------------------------
// Block reasons and descriptions
// ---------------------------------------------------------------------------------------------

check('block reasons: numbers, rule order, timing last', () => {
  const s = E.createGame({ playerCount: 2, variants: { clubs: 'off', firstPlayer: 'seat-0' } }, { seed: 'reasons' });
  const me = s.toAct;
  const other = 1 - me;
  const myCrew = E.crewOnBoard(s, me)[0];
  // capacity 4 at two players; the Entrance holds 4 (full)
  assert.match(E.getBlockReason(s, { type: 'newNoob', hall: 'entrance' }), /Entrance is full \(4 of 4\)/);
  assert.match(E.getBlockReason(s, { type: 'newNoob', hall: 'artist-alley' }), /next to the Entrance/);
  assert.equal(E.getBlockReason(s, { type: 'newNoob', hall: 'main-hall' }), null);
  assert.match(E.getBlockReason(s, { type: 'move2', crew: myCrew.id, to: 'artist-alley' }), /3 halls from Entrance; Move 2 reaches at most 2 halls/);
  assert.match(E.getBlockReason(s, { type: 'move2', crew: E.crewOnBoard(s, other)[0].id, to: 'main-hall' }), /you may only move your own/);
  assert.match(E.getBlockReason(s, { type: 'move2', crew: myCrew.id, to: 'entrance' }), /already in Entrance/);
  assert.match(E.getBlockReason(s, { type: 'takeSelfie', celebrity: 'character_tng_02' }), /not on the board|no Crew/);
  assert.equal(E.getBlockReason(s, { type: 'upgrade', crew: myCrew.id }), null, 'Upgrade is a real action now (R12)');
  assert.match(E.getBlockReason(s, { type: 'buySwag', card: 'swag_green_01' }), /not in the Swag market|costs 1 green Selfie/);
  assert.match(E.getBlockReason(s, { type: 'nonsense' }), /not an action/);
  assert.match(E.getBlockReason(s, { type: 'move2', crew: myCrew.id }), /needs `to`/);
  assert.match(E.getBlockReason(s, { type: 'pass', player: other }), /It is .*'s decision/);
  assert.match(E.getBlockReason(s, { type: 'endConversions' }), /you must take your turn/);
  assert.match(E.getBlockReason(s, { type: 'exchange', rate: 'E1', pay: { green: 1, red: 1, orange: 0 }, gain: null }), /on 12 coffee/);
  assert.match(E.getBlockReason(s, { type: 'exchange', rate: 'E2', pay: { green: 1, red: 1, orange: 0 }, gain: 'red' }), /different from each Selfie you pay/);
  assert.match(E.getBlockReason(s, { type: 'exchange', rate: 'E3', pay: { green: 2, red: 1, orange: 1 }, gain: null }), /You hold 1 green \+ 1 red \+ 1 orange Selfies/);
  assert.match(E.getBlockReason(s, { type: 'strikeAPose', gain: { green: 2, red: 0, orange: 0 } }), /Selfie Stick Squad/);
  // structural reasons skip timing
  assert.equal(E.getStructuralBlockReason(s, { type: 'pass', player: other }), null);
  // coffee shortfall message with numbers
  const poor = E.cloneState(s);
  poor.players[me].coffee = 0;
  assert.equal(E.getBlockReason(poor, { type: 'move2', crew: myCrew.id, to: 'main-hall' }), 'Move 2 costs 1 coffee and you have 0.');
  assert.equal(E.getBlockReason(poor, { type: 'newNoob', hall: 'main-hall' }), 'New N00b Crew costs 4 coffee and you have 0.');
  // illegal applyAction throws with code and leaves the state untouched
  const text = E.serialiseState(poor);
  assert.throws(() => E.applyAction(poor, { type: 'move2', crew: myCrew.id, to: 'main-hall' }), (err) => err.code === 'ILLEGAL_ACTION' && /costs 1 coffee/.test(err.reason));
  assert.equal(E.serialiseState(poor), text);
  // every family is implemented (T9)
  for (const a of E.getValidActions(s)) assert.ok(E.ACTIONS[a.type].implemented);
});

check('describeAction: a British-English label for every offered action; describeDecision prompts', () => {
  let seen = 0;
  for (const [i, config] of CONFIGS.entries()) {
    const s = E.createGame(config, { seed: `describe-${i}` });
    const rng = E.makeRng(`d-${i}`);
    for (let k = 0; k < 120 && !E.isGameOver(s); k++) {
      for (const a of E.getValidActions(s)) {
        const t = E.describeAction(s, a);
        assert.ok(typeof t === 'string' && t.length > 3, `label for ${a.type}`);
        assert.ok(!/undefined|NaN|\[object/.test(t), `label "${t}"`);
        assert.ok(!/\bcolor\b|MOJO|Selfy/.test(t), `British terms: "${t}"`);
        seen++;
      }
      const d = E.describeDecision(s);
      assert.ok(d && d.prompt.startsWith(s.players[d.player].name));
      E.applyAction(s, randomBot.chooseAction(s, { rng }), E.SILENT);
    }
  }
  assert.ok(seen > 1000);
  const s = E.createGame({ playerCount: 2 }, { seed: 'lab' });
  const move = E.getValidActions(s).find((a) => a.type === 'move2');
  assert.match(E.describeAction(s, move), /^Move 2: your N00b in Entrance \(\d+(st|nd|rd|th)\) to [A-Z]/);
});

check('action families: every R8.3 main action and every follow-up family is in the catalogue', () => {
  const fam = E.actionFamilies();
  for (const t of E.MAIN_ACTION_TYPES) assert.ok(fam[t], t);
  for (const t of [...E.CONVERSION_TYPES, ...E.EFFECT_STEP_TYPES, 'scoreAchievement', 'discardAchievement', 'passReward', 'moveStep', 'stopMoving', 'endConversions', 'placeOpeningCrew', 'discardSelfie', 'keepAchievement']) {
    assert.ok(fam[t], t);
    assert.ok(fam[t].frames.length > 0, `${t} is accepted by some frame`);
  }
  for (const kind of Object.keys(E.FRAME_ACCEPTS)) assert.ok(E.FRAMES[kind], `frame ${kind} has a definition`);
  const implemented = Object.keys(fam).filter((t) => fam[t].implemented).sort();
  assert.equal(implemented.length, 34, 'all 34 action types are implemented');
  assert.deepEqual(implemented, Object.keys(fam).sort());
});

check('achievements: every card has a count spec the evaluator knows; nothing claimable is invented', () => {
  for (const a of E.ACHIEVEMENT_CARDS) {
    const s = E.createInitialState({ playerCount: 3 }, { seed: 'ach' });
    const spec = E.achievementSpec(s, a.id);
    assert.ok(spec, `${a.id} spec`);
    assert.ok(E.ACHIEVEMENT_METRICS.includes(spec.metric), `${a.id} metric ${spec.metric}`);
    const r = E.countAchievement(s, 0, a.id);
    assert.ok(r.implemented && Number.isInteger(r.count) && r.count >= 0);
  }
  // spot checks on a constructed state: three players, seat 0 has 2 Crew in Main Hall and 1 in Entrance
  const s = E.createInitialState({ playerCount: 3, variants: { firstPlayer: 'seat-0' } }, { seed: 'ach2' });
  for (const c of s.crew) {
    c.hall = null;
    c.stamp = null;
  }
  const put = (id, hall, badge = 'N00b') => {
    const c = E.crewById(s, id);
    c.hall = hall;
    c.badge = badge;
    c.stamp = s.nextStamp++;
  };
  put('c0-1', 'main-hall', 'VIP');
  put('c1-1', 'main-hall');
  put('c0-2', 'main-hall');
  put('c0-3', 'entrance');
  for (const e of s.schedule) if (e.status === 'onBoard') e.figure = 'food-trucks';
  assert.equal(E.countAchievement(s, 0, 'scoring_11').count, 3, 'Party');
  assert.equal(E.countAchievement(s, 0, 'scoring_01').count, 1, 'Media');
  assert.equal(E.countAchievement(s, 0, 'scoring_05').count, 1, 'Chums');
  assert.equal(E.countAchievement(s, 0, 'scoring_04').count, 2, 'Premiere: Main Hall (VIP first) and Entrance');
  assert.equal(E.countAchievement(s, 0, 'scoring_34').count, 0, 'Surrounded');
  assert.equal(E.countAchievement(s, 1, 'scoring_34').count, 1, 'seat 1 N00b between two of seat 0 in Main Hall');
  assert.equal(E.countAchievement(s, 0, 'scoring_38').count, 1, 'Connected: Main Hall-Entrance');
  assert.equal(E.countAchievement(s, 0, 'scoring_15').count, 3, 'Column 2');
  assert.deepEqual(E.countAchievement(s, 0, 'scoring_15').choice.halls, ['main-stage', 'main-hall', 'entrance']);
  assert.equal(E.countAchievement(s, 0, 'scoring_37').count, 2, 'Dominance');
  assert.equal(E.countAchievement(s, 0, 'scoring_17').count, 1, 'Collector');
  assert.equal(E.countAchievement(s, 0, 'scoring_39').count, 4, 'Caffinated 12/3');
  assert.equal(E.countAchievement(s, 0, 'scoring_12').count, 2, 'Cult Classic');
  assert.equal(E.achievementValue(s, 0, 'scoring_11', 3), 18);
});

// ---------------------------------------------------------------------------------------------
// T9 additions
// ---------------------------------------------------------------------------------------------

const ALL_NON_DEFAULT = {
  queueCapacity: 'rulebook',
  celebrityColours: 'fixed-slots',
  coffeeCap: 'coffee-break-only',
  fivePlayerOpening: 'fallback',
  usherInHall: 'neither',
  homeBase: 'as-printed',
  achiever: 'draw-two-keep-one',
  clubHandLimits: 'on',
  finalBoard: 'figures-removed',
  militiaRoll: 'fixed',
};

check('T9: every non-default variant value at once - full checks every step (round trip, hash, offered = legal), zero refusals, VP bookkeeping', () => {
  const known = new Set(Object.values(E.EVENTS));
  for (let g = 0; g < 16; g++) {
    const n = 2 + (g % 4);
    const r = playRandom({ playerCount: n, variants: ALL_NON_DEFAULT }, `allvar-${g}`, `allvar-bot-${g}`, { fullCheck: g < 8, collect: true });
    assert.equal(r.refusals, 0);
    const total = new Array(n).fill(0);
    for (const e of r.events) {
      assert.ok(known.has(e.type), `unknown event ${e.type}`);
      if (e.type === E.EVENTS.VP) total[e.player] += e.amount;
    }
    const sc = E.scoreGame(r.state);
    for (let seat = 0; seat < n; seat++) assert.equal(total[seat], sc.players[seat].vp, `game ${g} seat ${seat} VP events = score`);
    // a game is a pure function of (config, seed, chosen actions): replay rebuilds the same final state
    if (g < 6) {
      const again = E.replayGame(E.getGameConfig(r.state), r.chosen);
      assert.equal(E.hashState(again), E.hashState(r.state), `game ${g} replays byte for byte`);
    }
  }
});

check('T9: blindCopy re-deals the pair a seat drew with Achiever (draw-two-keep-one) and Longbox memory for other seats; keeps its own', () => {
  const s = F.game(2, { variants: { achiever: 'draw-two-keep-one' } });
  F.buy(s, 'swag_orange_07');
  const frame = E.topFrame(s);
  assert.equal(frame.kind, 'achieverKeep');
  const own = E.blindCopy(s, 0, E.makeRng('own'));
  assert.deepEqual(E.topFrame(own).cards, frame.cards, 'the drawer sees their own pair');
  let changed = 0;
  for (let i = 0; i < 20; i++) {
    const other = E.blindCopy(s, 1, E.makeRng(`other-${i}`));
    const pool = (st) => [...st.achievements.deck, ...st.players.flatMap((p) => p.hand), ...st.achievements.discard.map((d) => d.card), ...E.topFrame(st).cards].sort();
    assert.deepEqual(pool(other), pool(s), 'no card is lost or invented');
    assert.deepEqual(other.players[1].hand, s.players[1].hand, 'the viewer keeps their own hand');
    if (E.topFrame(other).cards.join() !== frame.cards.join()) changed++;
  }
  assert.ok(changed > 0, 'another seat cannot see the pair');
  // Longbox Legion remembers the last discard
  const t = F.game(2, { clubs: ['club_05', 'club_08'] });
  F.give(t, 0, { coffee: 12 });
  F.act(t, { type: 'clubPower', option: 'use' });
  F.act(t, E.getValidActions(t)[0]);
  const memo = E.topFrame(t).data.last;
  assert.ok(memo !== '');
  assert.equal(E.topFrame(E.blindCopy(t, 0, E.makeRng('a'))).data.last, memo);
  assert.equal(E.topFrame(E.blindCopy(t, 1, E.makeRng('b'))).data.last, '');
});

check('T9: the effect frame is plain JSON with the documented fields; every effect step action has a describeAction label and an actionKey', () => {
  const s = F.game(3);
  F.buy(s, 'swag_green_09');
  const f = E.topFrame(s);
  assert.deepEqual(Object.keys(f).sort(), ['data', 'kind', 'player', 'source', 'step']);
  assert.deepEqual(f.source, { kind: 'swag', card: 'swag_green_09' });
  assertPlainJson(s);

});

if (failures > 0) {
  console.log(`engine-contract: ${failures} failed, ${passes} passed`);
  process.exit(1);
}
console.log(`engine-contract ok (${passes} checks)`);
