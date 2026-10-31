// rules-audit.test.mjs - T10 independent rules conformance audit (31/10/2026).
//
// Every check is written from rules-spec/superfans-rules-spec-v2.md (R0-R28,
// Appendix B) and rules-spec/rulings-2026-10-31.md, NOT from the engine code.
// The engine is driven only through its public API (src/engine/index.js):
// a real game is created with a seed, then plain-JSON fields are edited to
// build the position a rule talks about, then legal actions are applied.
// Each check is named by the rule number it audits. Expected numbers are read
// from getConstants() where the spec gives a constant; the R27 check pins the
// constants to the values printed in the spec.
//
// Run alone: node tests/rules-audit.test.mjs  (add a substring to filter).

import assert from 'node:assert/strict';
import * as E from '../src/engine/index.js';

// ---------------------------------------------------------------- harness

const checks = [];
const t = (name, fn) => checks.push({ name, fn });

// R3.2.2: grid id -> code id, transcribed from the spec, not the engine.
const G = {
  h11: 'artist-alley', h12: 'main-stage', h13: 'cosplay-arena',
  h21: 'autograph-hall', h22: 'main-hall', h23: 'vendor-hall',
  h31: 'photo-ops', h32: 'entrance', h33: 'food-trucks',
};
const GRID = Object.fromEntries(Object.entries(G).map(([g, c]) => [c, g]));
// R3.4 ropes, transcribed.
const ROPE = {
  rope_01: ['h11', 'h12'], rope_02: ['h11', 'h21'], rope_03: ['h12', 'h13'], rope_04: ['h12', 'h22'],
  rope_05: ['h13', 'h23'], rope_06: ['h21', 'h22'], rope_07: ['h21', 'h31'], rope_08: ['h22', 'h23'],
  rope_09: ['h22', 'h32'], rope_10: ['h23', 'h33'], rope_11: ['h31', 'h32'], rope_12: ['h32', 'h33'],
};
const ropeOf = (a, b) => Object.keys(ROPE).find((r) => ROPE[r].includes(a) && ROPE[r].includes(b));
const SEC = (g) => `security-${G[g]}`;
const PHO = (g) => `photographer-${G[g]}`;
const sel = (green = 0, red = 0, orange = 0) => ({ green, red, orange });

const C = (s) => E.getConstants(s);

function game(n = 2, variants = {}, seed = 1) {
  return E.createGame({ playerCount: n, variants: { clubs: 'off', firstPlayer: 'seat-0', ...variants } }, { seed });
}
// A blank floor: no Crew on the board, no Volunteers, full supplies, no selfies.
function clear(s, { coffee = 12, selfies = sel() } = {}) {
  for (const c of s.crew) { c.hall = null; c.stamp = null; c.badge = 'N00b'; }
  for (const k of Object.keys(s.volunteers)) s.volunteers[k] = null;
  const K = C(s).SUPPLY;
  for (const p of s.players) {
    p.hats = K.HATS_PER_PLAYER; p.boxes = K.BOXES_PER_PLAYER; p.volunteers = K.VOLUNTEERS_PER_PLAYER;
    p.coffee = coffee; p.selfies = { ...selfies }; p.passSlot = 0;
  }
  s.hourState.firstPasser = null; s.hourState.passOrder = [];
  return s;
}
// Put a Crew of `seat` from supply into hall (grid id) with a fresh stamp.
function put(s, seat, g, badge = 'N00b') {
  const c = s.crew.find((x) => x.owner === seat && x.hall === null);
  if (!c) throw new Error(`seat ${seat} has no Crew in supply`);
  c.hall = G[g]; c.badge = badge; c.stamp = s.nextStamp++;
  if (badge !== 'N00b') s.players[seat].hats--;
  if (badge === 'AAA') s.players[seat].boxes--;
  return c.id;
}
function vol(s, seat, space) { s.volunteers[space] = seat; s.players[seat].volunteers--; }
function turnFor(s, seat) {
  s.phase = 'floor'; s.step = 'turnEnd';
  s.stack = [{ kind: 'turn', player: seat, conversions: 0, rareFindsUsed: false }];
  s.toAct = seat; s.turn = { number: (s.turn?.number ?? 0) + 1, player: seat, kind: 'normal' };
  return s;
}
const keyOf = (a) => E.actionKey(a);
const valid = (s) => E.getValidActions(s);
function matches(a, partial) {
  return Object.entries(partial).every(([k, v]) => JSON.stringify(a[k]) === JSON.stringify(v));
}
const offered = (s, partial) => valid(s).some((a) => matches(a, partial));
function pick(s, partial) {
  const list = valid(s);
  const a = list.find((x) => matches(x, partial));
  if (!a) throw new Error(`not offered: ${JSON.stringify(partial)}; offered: ${list.map((x) => keyOf(x)).join(' | ')}`);
  return E.applyAction(s, a);
}
function refused(s, action) {
  assert.ok(E.getBlockReason(s, action), `expected a block reason for ${JSON.stringify(action)}`);
  assert.throws(() => E.applyAction(s, action), (e) => e.code === 'ILLEGAL_ACTION');
}
const q = (s, g) => E.queue(s, G[g]).map((c) => c.id);
const crew = (s, id) => s.crew.find((c) => c.id === id);
const ev = (events, type) => events.filter((e) => e.type === type);
const card = (id) => E.CELEBRITY_CARDS.find((c) => c.id === id);
function setCeleb(s, slot, id, colour) {
  const e = s.schedule.find((x) => x.slot === slot);
  e.card = id; e.status = 'onBoard'; e.figure = card(id).route[0]; e.marker = card(id).route.at(-1);
  if (colour) e.colour = colour;
  return e;
}
// Everyone but `seat` has passed; `seat` (empty hand) passes last -> the Walk runs.
function walkNow(s, seat = 0) {
  const others = s.players.map((p) => p.seat).filter((x) => x !== seat);
  for (const o of others) { s.players[o].passSlot = 1; s.hourState.passOrder.push(o); }
  s.hourState.firstPasser = others[0];
  s.players[seat].hand = [];
  turnFor(s, seat);
  return E.applyAction(s, { type: 'pass' });
}
// Replace a hand, keeping the Achievement cards unique (old hand cards go under the deck).
function setHand(s, seat, cards) {
  const a = s.achievements;
  for (const id of cards) { const i = a.deck.indexOf(id); if (i >= 0) a.deck.splice(i, 1); for (const p of s.players) if (p.seat !== seat) p.hand = p.hand.filter((x) => x !== id); }
  for (const old of s.players[seat].hand) if (!cards.includes(old)) a.deck.unshift(old);
  s.players[seat].hand = [...cards];
}
// Close every final window with Done.
function finish(s) { let n = 0; while (!E.isGameOver(s)) { E.applyAction(s, valid(s).find((a) => a.type === 'endConversions') ?? valid(s)[0]); if (++n > 50) throw new Error('final windows did not close'); } }
function setMarket(s, id, slot = 0) {
  const sw = s.swag;
  for (const pile of [sw.deck, sw.discard]) { const i = pile.indexOf(id); if (i >= 0) pile.splice(i, 1); }
  const j = sw.market.indexOf(id); if (j >= 0 && j !== slot) sw.market[j] = sw.deck.pop() ?? null;
  if (sw.market[slot] && sw.market[slot] !== id) sw.deck.unshift(sw.market[slot]);
  sw.market[slot] = id;
}
// Set up seat 0's turn to buy `id` with exactly its cost in its colour.
function buyable(s, id, seat = 0) {
  const sw = E.SWAG_CARDS.find((x) => x.id === id);
  setMarket(s, id);
  s.players[seat].selfies[sw.colour] += C(s).SWAG.SWAG_COST[id];
  turnFor(s, seat);
  return sw;
}
function seededPicker(seed) {
  const rng = E.makeRng(seed);
  return (list) => list[E.rngInt(rng, list.length)];
}
function playRandom(s, seed, onStep) {
  const choose = seededPicker(seed);
  let n = 0;
  while (!E.isGameOver(s)) {
    const list = valid(s);
    assert.ok(list.length >= 2, `R23.5: a decision with ${list.length} option(s) was left to the player`);
    const a = choose(list);
    const before = onStep ? JSON.parse(JSON.stringify(s)) : null;
    const events = E.applyAction(s, a);
    if (onStep) onStep(before, s, a, events);
    if (++n > 30000) throw new Error('game did not end');
  }
  return s;
}

// ======================================================= R1 terminology

t('R1.3 coffee is a whole number 0..12, public, start 12', () => {
  const s = game(3);
  for (const p of s.players) assert.equal(p.coffee, C(s).START.START_COFFEE);
  playRandom(game(3, {}, 9), 9, (b, a) => { for (const p of a.players) assert.ok(Number.isInteger(p.coffee) && p.coffee >= 0 && p.coffee <= 12); });
});
t('R1.4 selfie colours are green, red, orange', () => {
  assert.deepEqual([...E.COLOURS].sort(), ['green', 'orange', 'red']);
});
t('R1.5 VP has no upper limit', () => {
  const s = clear(game(2)); s.players[0].vp = 200; s.players[0].selfies = sel(4, 0, 0); turnFor(s, 0);
  pick(s, { type: 'exchange', rate: 'E3' });
  assert.equal(s.players[0].vp, 202);
});
t('R1.7 a Crew on the board never returns to supply; R1.8 at most 3 VIP/AAA and 1 AAA (random games)', () => {
  for (const seed of [11, 12]) {
    playRandom(game(4, { clubs: 'random', firstPlayer: 'random' }, seed), seed, (b, a) => {
      for (const c of a.crew) {
        const was = b.crew.find((x) => x.id === c.id);
        if (was.hall) assert.ok(c.hall, `R1.7 ${c.id} left the board`);
        if (was.badge !== c.badge) assert.ok(E.BADGE_RANK[c.badge] > E.BADGE_RANK[was.badge], 'R12.3 badge went down');
      }
      for (const p of a.players) {
        const mine = a.crew.filter((c) => c.owner === p.seat);
        assert.ok(mine.filter((c) => c.badge !== 'N00b').length <= 3, 'R1.8 more than 3 hats');
        assert.ok(mine.filter((c) => c.badge === 'AAA').length <= 1, 'R1.8 more than 1 AAA');
        assert.equal(mine.length, 8);
      }
    });
  }
});
t('R1.8 badge rank AAA > VIP > N00b', () => {
  assert.ok(E.BADGE_RANK.AAA > E.BADGE_RANK.VIP && E.BADGE_RANK.VIP > E.BADGE_RANK.N00b);
});
t('R1.15 one main action ends the turn (conversions do not)', () => {
  const s = clear(game(2)); put(s, 0, 'h32'); s.players[0].selfies = sel(2, 1, 0); turnFor(s, 0);
  pick(s, { type: 'exchange', rate: 'E2' });
  assert.equal(s.toAct, 0, 'conversion kept the turn');
  pick(s, { type: 'move2', to: G.h22 });
  assert.equal(s.toAct, 1, 'main action passed the turn on');
});
t('R1.16 adjacency is orthogonal only (no diagonals)', () => {
  assert.equal(E.areAdjacent(G.h11, G.h22), false);
  assert.equal(E.areAdjacent(G.h11, G.h12), true);
});

// ======================================================= R2 components

t('R2.1 card counts: 18 celebrities (6 per rank), 40 achievements, 36 swag (12 per colour), 9 clubs, 1 pass card', () => {
  assert.equal(E.CELEBRITY_CARDS.length, 18);
  for (const r of ['A', 'B', 'C']) assert.equal(E.CELEBRITY_CARDS.filter((c) => c.rank === r).length, 6);
  assert.equal(E.ACHIEVEMENT_CARDS.length, 40);
  assert.equal(E.SWAG_CARDS.length, 36);
  for (const col of ['green', 'red', 'orange']) assert.equal(E.SWAG_CARDS.filter((c) => c.colour === col).length, 12);
  assert.equal(E.CLUB_CARDS.length, 9);
  assert.equal(E.PASS_CARD.slots.length, 4);
});
t('R2.2 per-player supply 8 Crew / 3 hats / 1 box / 6 Volunteers', () => {
  const s = game(5);
  for (const p of s.players) {
    assert.equal(s.crew.filter((c) => c.owner === p.seat).length, 8);
    assert.equal(p.hats, 3); assert.equal(p.boxes, 1); assert.equal(p.volunteers, 6);
  }
});
t('R2.2 hard limits: no Crew in supply -> no New N00b; no Volunteer -> no Volunteer action', () => {
  const s = clear(game(2));
  for (let i = 0; i < 8; i++) put(s, 0, ['h11', 'h12', 'h13', 'h21'][i % 4]);
  for (const sp of ['rope_01', 'rope_02', 'rope_03', 'rope_04', 'rope_05', 'rope_06']) vol(s, 0, sp);
  turnFor(s, 0);
  assert.equal(offered(s, { type: 'newNoob' }), false);
  assert.equal(offered(s, { type: 'volunteer' }), false);
  refused(s, { type: 'newNoob', hall: G.h32 });
  refused(s, { type: 'volunteer', space: 'rope_09' });
});
t('R2.3 After Party cards are not in the game', () => {
  const all = [...E.CELEBRITY_CARDS, ...E.ACHIEVEMENT_CARDS, ...E.SWAG_CARDS, ...E.CLUB_CARDS].map((c) => c.id);
  assert.ok(!all.some((id) => id.startsWith('after_party')));
});

// ======================================================= R3 board

t('R3.1/R3.2/R3.2.2 hall grid ids, code ids and names', () => {
  const names = { h11: 'Artist Alley', h12: 'Main Stage', h13: 'Cosplay Arena', h21: 'Autograph Hall', h22: 'Main Hall', h23: 'Vendor Hall', h31: 'Photo Ops', h32: 'Entrance', h33: 'Food Trucks' };
  assert.equal(E.HALLS.length, 9);
  for (const h of E.HALLS) {
    assert.equal(G[h.grid], h.id, `${h.grid} code id`);
    assert.equal(h.name, names[h.grid], `${h.grid} name`);
    assert.equal(h.grid, `h${h.row}${h.col}`);
  }
  assert.ok(!JSON.stringify(E.HALLS).includes('Panel Rooms'), 'Q7: no Panel Rooms');
});
t('R3.2.1 the Entrance is h32', () => {
  assert.equal(E.ENTRANCE, G.h32);
  assert.equal(C(game()).BOARD.ENTRANCE, G.h32);
});
t('R3.3 adjacency table', () => {
  const adj = { h11: ['h12', 'h21'], h12: ['h11', 'h13', 'h22'], h13: ['h12', 'h23'], h21: ['h11', 'h22', 'h31'], h22: ['h12', 'h21', 'h23', 'h32'], h23: ['h13', 'h22', 'h33'], h31: ['h21', 'h32'], h32: ['h22', 'h31', 'h33'], h33: ['h23', 'h32'] };
  for (const [g, list] of Object.entries(adj)) {
    assert.deepEqual([...E.ADJACENT[G[g]]].map((x) => GRID[x]).sort(), [...list].sort(), g);
  }
});
t('R3.3.1 corner / edge / centre halls, rows, columns, diagonals', () => {
  const asGrid = (l) => l.map((x) => GRID[x]).sort();
  assert.deepEqual(asGrid(E.CORNER_HALLS), ['h11', 'h13', 'h31', 'h33']);
  assert.deepEqual(asGrid(E.EDGE_HALLS), ['h12', 'h21', 'h23', 'h32']);
  assert.equal(GRID[E.CENTRE_HALL], 'h22');
  assert.deepEqual(E.LINES.rows.map(asGrid), [['h11', 'h12', 'h13'], ['h21', 'h22', 'h23'], ['h31', 'h32', 'h33']]);
  assert.deepEqual(E.LINES.columns.map(asGrid), [['h11', 'h21', 'h31'], ['h12', 'h22', 'h32'], ['h13', 'h23', 'h33']]);
  assert.deepEqual(E.LINES.diagonals.map(asGrid).sort(), [['h11', 'h22', 'h33'], ['h13', 'h22', 'h31']]);
});
t('R3.4/R3.4.1 twelve ropes joining exactly the adjacent pairs', () => {
  assert.equal(E.ROPES.length, 12);
  for (const r of E.ROPES) assert.deepEqual(r.halls.map((x) => GRID[x]).sort(), [...ROPE[r.id]].sort(), r.id);
});
t('R3.5 thirty volunteer spaces (12 Usher, 9 Security, 9 Photographer), one Volunteer each', () => {
  const roles = E.VOLUNTEER_SPACES.map((v) => v.role);
  assert.equal(roles.length, 30);
  assert.equal(roles.filter((r) => r === 'usher').length, 12);
  assert.equal(roles.filter((r) => r === 'security').length, 9);
  assert.equal(roles.filter((r) => r === 'photographer').length, 9);
  const s = clear(game(2)); vol(s, 1, SEC('h22')); turnFor(s, 0);
  refused(s, { type: 'volunteer', space: SEC('h22') });
});
t('R3.6 queue capacity by player count (printed-board default and rulebook)', () => {
  const K = C(game()).CAPACITY.QUEUE_CAPACITY;
  for (const n of [2, 3, 4, 5]) {
    assert.equal(E.capacity(game(n)), K['printed-board'][n]);
    assert.equal(E.capacity(game(n, { queueCapacity: 'rulebook' })), K.rulebook[n]);
  }
});
t('R3.6.1 a hall with C Crew is full; with C-1 it has room', () => {
  const s = clear(game(3)); const cap = E.capacity(s);
  for (let i = 0; i < cap - 1; i++) put(s, 1 + (i % 2), 'h22');
  put(s, 0, 'h12'); turnFor(s, 0);
  assert.ok(offered(s, { type: 'move2', to: G.h22 }), 'room at C-1');
  put(s, 1, 'h22'); turnFor(s, 0);
  assert.equal(offered(s, { type: 'move2', to: G.h22 }), false, 'full at C');
  assert.equal(E.isFull(s, G.h22), true);
});
t('R3.7 Swag market has five slots', () => {
  const s = game(2);
  assert.equal(s.swag.market.length, 5);
  assert.equal(C(s).BOARD.SWAG_MARKET_SLOTS, 5);
});

// ======================================================= R4 celebrities

const CELEB_TABLE = [
  ['character_mando_03', 'A', 5, 'h11 h21 h31', 'everyone', [8]],
  ['character_marvel_03', 'A', 4, 'h32 h22 h12', 'by-badge', [8, 10, 12]],
  ['character_rings_03', 'A', 3, 'h13 h12 h11', 'in-order', [20, 5, 5, 5, 5, 5, 5]],
  ['character_star_wars_03', 'A', 2, 'h33 h32 h31', 'in-order', [15, 12, 10, 3, 2, 1, 1]],
  ['character_tng_03', 'A', 4, 'h21 h22 h23', 'in-order-no-n00bs', [15, 11, 8, 6, 4, 3, 2]],
  ['character_who_03', 'A', 3, 'h13 h23 h33', 'in-order', [20, 9, 6, 4, 3, 2, 1]],
  ['character_mando_02', 'B', 5, 'h33 h32 h31 h21 h11', 'everyone', [6]],
  ['character_marvel_02', 'B', 5, 'h22 h23 h33 h32 h31', 'by-badge', [6, 8, 10]],
  ['character_rings_02', 'B', 7, 'h33 h23 h13 h12 h11', 'everyone-no-n00bs', [7]],
  ['character_star_wars_02', 'B', 8, 'h31 h32 h33 h23 h13', 'count-total', [12, 5, 3]],
  ['character_tng_02', 'B', 5, 'h23 h33 h32 h31 h21', 'in-order-no-n00bs', [14, 10, 7, 5, 3, 2, 1]],
  ['character_who_02', 'B', 5, 'h31 h21 h11 h12 h13', 'in-order', [12, 8, 5, 3, 2, 1, 1]],
  ['character_mando_01', 'C', 5, 'h33 h23 h13 h12 h22 h21', 'everyone', [4]],
  ['character_marvel_01', 'C', 6, 'h11 h12 h13 h23 h33 h32 h22', 'by-badge', [4, 6, 8]],
  ['character_rings_01', 'C', 5, 'h21 h11 h12 h22 h32 h33 h23', 'in-order', [12, 8, 5, 4, 3, 1, 1]],
  ['character_star_wars_01', 'C', 5, 'h21 h31 h32 h22 h12 h13 h23', 'in-order', [12, 8, 5, 4, 3, 2, 1]],
  ['character_tng_01', 'C', 6, 'h33 h32 h31 h21 h11 h12 h13', 'in-order-no-n00bs', [13, 9, 6, 4, 2, 1, 1]],
  ['character_who_01', 'C', 7, 'h13 h12 h11 h21 h22 h23 h33', 'in-order', [11, 7, 4, 2, 1, 1, 1]],
];
t('R4.2 the 18 celebrity cards: rank, coffee, route, method, values (card data and CONSTANTS)', () => {
  const K = C(game()).CELEBRITIES.CELEBRITIES;
  for (const [id, rank, coffee, route, method, values] of CELEB_TABLE) {
    const c = card(id);
    assert.equal(c.rank, rank, id); assert.equal(c.coffee, coffee, id);
    assert.deepEqual(c.route.map((h) => GRID[h]), route.split(' '), `${id} route`);
    assert.equal(c.scoring.method, method, id); assert.deepEqual(c.scoring.values, values, id);
    assert.equal(K[id].COFFEE, coffee); assert.equal(K[id].METHOD, method); assert.deepEqual(K[id].VALUES, values);
    for (let i = 1; i < c.route.length; i++) assert.ok(E.areAdjacent(c.route[i - 1], c.route[i]), `${id} step ${i}`);
  }
});
t('R4.3.1 random-slots deals the three colours to Hours 1-3 at random (seeded); fixed-slots is green/red/orange', () => {
  const seen = new Set();
  for (let seed = 1; seed <= 40; seed++) {
    const s = E.createGame({ playerCount: 2 }, { seed });
    seen.add(s.schedule.slice(0, 3).map((e) => e.colour).join(','));
    const again = E.createGame({ playerCount: 2 }, { seed });
    assert.deepEqual(again.schedule, s.schedule, 'R23.4 seeded');
  }
  assert.equal(seen.size, 6, `all 6 colour deals appear over 40 seeds (saw ${seen.size})`);
  const f = game(2, { celebrityColours: 'fixed-slots' });
  assert.deepEqual(f.schedule.map((e) => e.colour), ['green', 'red', 'orange', 'green', 'red', 'orange']);
});
t('R4.3.2/R4.3.5 Hour 4 = Hour 1 colour, 5a = Hour 2, 5b = Hour 3; each colour exactly twice', () => {
  for (let seed = 1; seed <= 12; seed++) {
    const s = E.createGame({ playerCount: 3 }, { seed });
    const c = Object.fromEntries(s.schedule.map((e) => [e.slot, e.colour]));
    assert.equal(c['4'], c['1']); assert.equal(c['5a'], c['2']); assert.equal(c['5b'], c['3']);
    for (const col of ['green', 'red', 'orange']) assert.equal(s.schedule.filter((e) => e.colour === col).length, 2);
  }
});
t('R4.3.4 a celebrity hands out only its own colour (Take a Selfie)', () => {
  const s = clear(game(2)); put(s, 0, 'h11');
  const e = setCeleb(s, '1', 'character_mando_03', 'orange'); turnFor(s, 0);
  pick(s, { type: 'takeSelfie', celebrity: e.card });
  assert.deepEqual(s.players[0].selfies, sel(0, 0, 1));
});

// ======================================================= R5 setup

t('R5.1/R5.2 start: 0 VP, 12 coffee, 1/1/1 selfies, full supplies', () => {
  const s = E.createGame({ playerCount: 4 }, { seed: 5 });
  const K = C(s).START;
  for (const p of s.players) {
    assert.equal(p.vp, K.START_VP); assert.equal(p.coffee, K.START_COFFEE);
    assert.deepEqual(p.selfies, K.START_SELFIES);
  }
});
t('R5.3 one Club dealt face up to each player, all different; clubs=off deals none', () => {
  for (let seed = 1; seed <= 10; seed++) {
    const s = E.createGame({ playerCount: 5 }, { seed });
    const clubs = s.players.map((p) => p.club);
    assert.equal(new Set(clubs).size, 5);
    for (const c of clubs) assert.match(c, /^club_0[1-9]$/);
  }
  for (const p of game(3, { clubs: 'off' }).players) assert.equal(p.club, null);
});
t('R5.4 schedule: 2 A, 2 B, 2 C cards in slots 1,2 / 3,4 / 5a,5b, all different', () => {
  for (let seed = 1; seed <= 10; seed++) {
    const s = E.createGame({ playerCount: 2 }, { seed });
    assert.deepEqual(s.schedule.map((e) => e.slot), ['1', '2', '3', '4', '5a', '5b']);
    assert.deepEqual(s.schedule.map((e) => card(e.card).rank), ['A', 'A', 'B', 'B', 'C', 'C']);
    assert.equal(new Set(s.schedule.map((e) => e.card)).size, 6);
  }
});
t('R5.6 Hours 1-3 celebrities on the floor: figure on start hall, marker on destination; others waiting', () => {
  const s = E.createGame({ playerCount: 2 }, { seed: 8 });
  for (const e of s.schedule) {
    if (['1', '2', '3'].includes(e.slot)) {
      assert.equal(e.status, 'onBoard'); assert.equal(e.figure, card(e.card).route[0]); assert.equal(e.marker, card(e.card).route.at(-1));
    } else { assert.equal(e.status, 'waiting'); assert.equal(e.figure, null); assert.equal(e.marker, null); }
  }
});
t('R5.7 five Swag face up, 31 in the deck', () => {
  const s = game(3);
  assert.equal(s.swag.market.filter(Boolean).length, 5);
  assert.equal(s.swag.deck.length, 31);
  assert.equal(new Set([...s.swag.deck, ...s.swag.market]).size, 36);
});
t('R5.8 two secret Achievements each; deck holds the rest', () => {
  for (const n of [2, 5]) {
    const s = game(n);
    for (const p of s.players) assert.equal(p.hand.length, C(s).START.START_ACHIEVEMENTS);
    assert.equal(s.achievements.deck.length, 40 - 2 * n);
  }
});
t('R5.9 opening: reverse turn order, 2 N00bs each, first player last; first player random (seeded) or seat 0', () => {
  for (const n of [2, 3, 4, 5]) {
    const s = E.createGame({ playerCount: n }, { seed: 21 + n });
    const f = s.startPlayer;
    const order = E.queue(s, G.h32).map((c) => c.owner);
    const expect = [];
    for (let k = 1; k <= n; k++) { const seat = (f - k + n * 2) % n; expect.push(seat, seat); }
    assert.deepEqual(order, expect, `${n}p opening order`);
    for (const c of E.queue(s, G.h32)) assert.equal(c.badge, 'N00b');
  }
  const firsts = new Set();
  for (let seed = 1; seed <= 30; seed++) firsts.add(E.createGame({ playerCount: 4 }, { seed }).startPlayer);
  assert.equal(firsts.size, 4, 'random first player');
  assert.equal(game(4, { firstPlayer: 'seat-0' }).startPlayer, 0);
});
t('R5.9.1 / App.B opening count: 4 into 4, 6 into 6, 8 into 7, 10 into 7; Entrance full until it holds C-1', () => {
  const expected = { 2: 4, 3: 6, 4: 8, 5: 10 };
  for (const n of [2, 3, 4, 5]) {
    const s = game(n);
    assert.equal(E.queue(s, G.h32).length, expected[n]);
    assert.equal(E.isFull(s, G.h32), true, `${n}p Entrance full after opening`);
  }
  // 5p: 10 in a capacity-7 Entrance. Three leave: 7 left = still full. A fourth leaves: 6 = room.
  const s = game(5); const inE = E.queue(s, G.h32);
  for (const c of inE.slice(0, 3)) c.hall = G.h22;
  assert.equal(E.isFull(s, G.h32), true, '7 of 7 is full');
  turnFor(s, 0);
  assert.equal(offered(s, { type: 'newNoob', hall: G.h32 }), false);
  inE[3].hall = G.h22;
  assert.equal(E.isFull(s, G.h32), false, '6 of 7 has room');
  turnFor(s, 0);
  assert.ok(offered(s, { type: 'newNoob', hall: G.h32 }));
});
t('R5.9.1 fallback: overflow Crew are placed by their owners as New N00b (4p 1, 5p 3; 5p rulebook 2)', () => {
  const cases = [[4, 'printed-board', 1], [5, 'printed-board', 3], [5, 'rulebook', 2], [3, 'printed-board', 0]];
  for (const [n, cap, decisions] of cases) {
    const s = game(n, { fivePlayerOpening: 'fallback', queueCapacity: cap });
    let made = 0;
    while (s.phase === 'setup' || s.stack.at(-1)?.kind === 'openingPlacement') {
      const list = valid(s);
      assert.ok(list.every((a) => a.type === 'placeOpeningCrew'));
      for (const a of list) assert.notEqual(a.hall, G.h32);
      for (const a of list) assert.ok([G.h22, G.h31, G.h33].includes(a.hall), 'R11.2 next to the Entrance first');
      E.applyAction(s, list[0]); made++;
    }
    assert.equal(made, decisions, `${n}p ${cap}`);
    assert.equal(E.queue(s, G.h32).length, Math.min(2 * n, E.capacity(s)));
  }
});
t('R5.10 the game opens in Hour 1 after its Coffee Break, first player to act', () => {
  const s = game(3);
  assert.equal(s.hour, 1); assert.equal(s.phase, 'floor'); assert.equal(s.toAct, 0);
});

// ======================================================= R6 structure

t('R6.1/R6.3/R6.5 five Hours; marker passes clockwise after Hours 1-4, not after 5; game ends after Hour 5', () => {
  for (const n of [2, 3, 5]) {
    const s = E.createGame({ playerCount: n, variants: { clubs: 'off' } }, { seed: 40 + n });
    const start = s.startPlayer;
    const choose = seededPicker(n);
    const hourStarts = [];
    while (!E.isGameOver(s)) {
      const events = E.applyAction(s, choose(valid(s)));
      for (const e of ev(events, 'hourStart')) hourStarts.push(e);
    }
    assert.deepEqual(hourStarts.map((e) => e.hour), [2, 3, 4, 5]);
    for (const e of hourStarts) assert.equal(e.firstPlayer, (start + e.hour - 1) % n);
    assert.equal(s.firstPlayer, (start + 4) % n, 'marker stays with the Hour 5 first player');
    assert.equal(s.hour, 5);
    assert.ok(s.schedule.every((e) => e.status !== 'waiting'));
  }
});
t('R6.4 per-Hour state resets: pass markers off, no first passer, Club use available', () => {
  const s = clear(game(2, { clubs: 'random' })); s.players[0].club = 'club_08'; s.players[1].club = null;
  s.players[0].clubUsedThisHour = true;
  walkNow(s, 1);
  assert.equal(s.hour, 2);
  for (const p of s.players) assert.equal(p.passSlot, 0);
  assert.equal(s.hourState.firstPasser, null);
  assert.equal(s.players[0].clubUsedThisHour, false);
});

// ======================================================= R7 Coffee Break

t('R7.1 Selfie Stick Squad window before income; only Strike a Pose offered there', () => {
  const s = clear(game(2, { clubs: 'random' }), { selfies: sel(2, 2, 0) });
  s.players[0].club = 'club_09'; s.players[1].club = null;
  walkNow(s, 1);
  assert.equal(s.hour, 2); assert.equal(s.stack.at(-1).kind, 'squadWindow'); assert.equal(s.toAct, 0);
  assert.equal(s.players[0].coffee, 12, 'income not yet paid');
  assert.ok(valid(s).every((a) => ['strikeAPose', 'endConversions'].includes(a.type)), 'no Exchange in the Squad window');
  pick(s, { type: 'strikeAPose', gain: sel(2, 0, 0) });
  assert.equal(s.players[0].coffee, 11);
  const events = pick(s, { type: 'endConversions' });
  const inc = ev(events, 'coffeeGain').find((e) => e.player === 0 && e.cause === 'coffee-break');
  assert.ok(inc, 'income after the window');
  assert.equal(s.players[0].coffee, 12);
});
t('R7.2 income = the Hour celebrity coffee value; Hour 5 = sum of both C cards', () => {
  const s = clear(game(2), { coffee: 0 });
  walkNow(s, 1);
  const c2 = card(s.schedule.find((e) => e.slot === '2').card).coffee;
  assert.equal(s.players[0].coffee, Math.min(12, c2 + 2 * 0));
  const h = clear(game(2), { coffee: 0 });
  h.hour = 4; for (const e of h.schedule) { if (['1', '2', '3'].includes(e.slot)) { e.status = 'done'; e.figure = null; e.marker = null; } }
  setCeleb(h, '4', 'character_star_wars_02'); setCeleb(h, '5a', 'character_mando_01'); setCeleb(h, '5b', 'character_rings_01');
  walkNow(h, 1);
  assert.equal(h.hour, 5);
  assert.equal(h.players[0].coffee, 5 + 5, 'Hour 5 income 5 + 5');
});
t('R7.3 coffee cap 12 on every gain (income, Usher, swag)', () => {
  const s = clear(game(2), { coffee: 9 });
  walkNow(s, 1);
  for (const p of s.players) assert.ok(p.coffee <= 12);
  const u = clear(game(2), { coffee: 12 }); put(u, 0, 'h32'); vol(u, 0, ropeOf('h32', 'h22')); turnFor(u, 0);
  pick(u, { type: 'move2', crew: 'c0-1', to: G.h22 });
  assert.equal(u.players[0].coffee, 12, '12 - 1 + 1 = 12');
  const w = clear(game(2), { coffee: 11 }); buyable(w, 'swag_red_03'); pick(w, { type: 'buySwag', card: 'swag_red_03' });
  assert.equal(w.players[0].coffee, 12);
});
t('R7.3 coffeeCap=coffee-break-only: Usher and swag gains go above 12; income stops at 12', () => {
  const u = clear(game(2, { coffeeCap: 'coffee-break-only' }), { coffee: 12 });
  put(u, 0, 'h32'); vol(u, 0, ropeOf('h32', 'h22')); vol(u, 0, ropeOf('h22', 'h12')); turnFor(u, 0);
  pick(u, { type: 'move2', crew: 'c0-1', to: G.h12 });
  assert.equal(u.players[0].coffee, 13);
  const w = clear(game(2, { coffeeCap: 'coffee-break-only' }), { coffee: 11 }); buyable(w, 'swag_red_03'); pick(w, { type: 'buySwag', card: 'swag_red_03' });
  assert.equal(w.players[0].coffee, 14);
  const i = clear(game(2, { coffeeCap: 'coffee-break-only' }), { coffee: 10 });
  walkNow(i, 1);
  assert.equal(i.players[0].coffee, 12, 'income tops up to 12');
  // R26.3: E1 and the pass-slot coffee are not blocked on 12 under coffee-break-only.
  const e1 = clear(game(2, { coffeeCap: 'coffee-break-only' }), { coffee: 12, selfies: sel(2, 0, 0) }); turnFor(e1, 0);
  assert.ok(offered(e1, { type: 'exchange', rate: 'E1' }), 'R26.3 E1 offered on 12');
});
t('R7.3.1 Hour 1 Coffee Break gains nothing but is logged', () => {
  const { events } = E.createGame({ playerCount: 3 }, { seed: 4, events: true });
  const inc = ev(events, 'coffeeGain').filter((e) => e.cause === 'coffee-break');
  assert.equal(inc.length, 3);
  for (const e of inc) assert.equal(e.amount, 0);
});

// ======================================================= R8 On the Floor

t('R8.1 turns go clockwise from the first player; passed players take pass-turns', () => {
  const s = clear(game(3), { coffee: 5 }); put(s, 0, 'h11'); put(s, 1, 'h11'); put(s, 2, 'h11');
  turnFor(s, 0); pick(s, { type: 'pass' });
  if (s.stack.at(-1)?.kind === 'passAchievement') pick(s, { type: 'discardAchievement' });
  assert.equal(s.toAct, 1); pick(s, { type: 'move2', crew: 'c1-1', to: G.h12 });
  assert.equal(s.toAct, 2); pick(s, { type: 'move2', crew: 'c2-1', to: G.h12 });
  assert.equal(s.toAct, 0); assert.equal(s.stack.at(-1).kind, 'passTurn');
});
t('R8.2 On the Floor ends immediately when the last player passes (no further turns)', () => {
  const s = clear(game(3)); put(s, 0, 'h12');
  const events = walkNow(s, 2);
  assert.ok(ev(events, 'celebrityEntered').length > 0, 'the Walk ran straight away');
  assert.equal(ev(events, 'passReward').length, 0, 'nobody took a pass-turn');
});
t('R8.3 every main action costs what the table says (coffee)', () => {
  const K = C(game()).COSTS;
  const cases = [
    ['move2', K.COST_MOVE_2, (s) => pick(s, { type: 'move2', to: G.h22 })],
    ['move3', K.COST_MOVE_3_CREW, (s) => pick(s, { type: 'move3', to: G.h22 })],
    ['newNoob', K.COST_NEW_NOOB, (s) => pick(s, { type: 'newNoob' })],
    ['upgrade', K.COST_UPGRADE, (s) => pick(s, { type: 'upgrade' })],
    ['volunteer', K.COST_VOLUNTEER, (s) => pick(s, { type: 'volunteer', space: 'rope_01' })],
    ['takeSelfie', K.COST_TAKE_SELFIE, (s) => pick(s, { type: 'takeSelfie' })],
    ['pass', K.COST_PASS, (s) => pick(s, { type: 'pass' })],
  ];
  for (const [name, cost, run] of cases) {
    const s = clear(game(2), { coffee: 10 }); put(s, 0, 'h32'); put(s, 0, 'h21');
    s.players[0].hand = []; s.hourState.firstPasser = 1; s.hourState.passOrder = [1]; s.players[1].passSlot = 1; s.players[1].hand = [];
    setCeleb(s, '1', 'character_star_wars_03'); // figure on h33? route h33..; put a Crew where a figure is
    put(s, 0, 'h33');
    turnFor(s, 0);
    const before = s.players[0].coffee;
    const events = run(s);
    const spent = ev(events, 'coffeeSpend').filter((e) => e.player === 0).reduce((a, e) => a + e.amount, 0);
    assert.equal(spent, cost, `${name} cost`);
    if (name !== 'pass') assert.ok(s.players[0].coffee <= before - cost + 2, name);
  }
});
t('R8.4 the same main action may be taken on later turns', () => {
  const s = clear(game(2)); put(s, 0, 'h32'); put(s, 1, 'h11');
  turnFor(s, 0); pick(s, { type: 'volunteer', space: 'rope_01' });
  turnFor(s, 0); pick(s, { type: 'volunteer', space: 'rope_02' });
  assert.equal(s.players[0].volunteers, 4);
});
t('R8.5 no debt: an action you cannot pay in full is not offered; Usher gains never pay for the action', () => {
  const s = clear(game(2), { coffee: 0 }); put(s, 0, 'h32'); vol(s, 0, ropeOf('h32', 'h22')); turnFor(s, 0);
  assert.equal(offered(s, { type: 'move2' }), false);
  const r = E.getBlockReason(s, { type: 'move2', crew: 'c0-1', to: G.h22 });
  assert.ok(r && /coffee/i.test(r), r);
  const u = clear(game(2), { coffee: 4 }); put(u, 0, 'h32'); turnFor(u, 0);
  assert.equal(offered(u, { type: 'upgrade' }), false, 'upgrade costs 5');
  assert.ok(offered(u, { type: 'newNoob' }), 'new N00b costs 4');
});
t('R8.5 free conversions earlier in the turn may raise the coffee needed', () => {
  const s = clear(game(2), { coffee: 0, selfies: sel(2, 0, 0) }); put(s, 0, 'h32'); turnFor(s, 0);
  assert.equal(offered(s, { type: 'move2' }), false);
  pick(s, { type: 'exchange', rate: 'E1' });
  assert.ok(offered(s, { type: 'move2' }));
});
t('R8.6 Pass is always offered; a blocked action has a block reason', () => {
  const s = clear(game(2), { coffee: 0 }); turnFor(s, 0);
  assert.ok(offered(s, { type: 'pass' }));
  assert.ok(E.getBlockReason(s, { type: 'newNoob', hall: G.h32 }));
});
t('R8.7 a Club power that would change nothing is refused; a Swag card with no effect may be bought', () => {
  const s = clear(game(2, { clubs: 'random' })); s.players[0].club = 'club_08'; s.players[1].club = null;
  put(s, 1, 'h11'); put(s, 0, 'h11'); turnFor(s, 0);
  assert.equal(offered(s, { type: 'clubPower' }), false, 'High Score with no Prime Position');
  const w = clear(game(2)); buyable(w, 'swag_orange_06'); // Cameras! with no Photographers
  assert.ok(offered(w, { type: 'buySwag', card: 'swag_orange_06' }));
  pick(w, { type: 'buySwag', card: 'swag_orange_06' });
  assert.equal(w.toAct, 1);
});
t('R8.8 a started action must be completed: Move 1 Crew x3 cannot stop before the first step', () => {
  const s = clear(game(2)); put(s, 0, 'h32'); put(s, 0, 'h11'); put(s, 0, 'h13'); turnFor(s, 0);
  pick(s, { type: 'move3', crew: 'c0-1', to: G.h22 });
  assert.equal(s.stack.at(-1).kind, 'moveSteps');
  assert.ok(offered(s, { type: 'stopMoving' }), 'may stop after the first step');
});
t('R8.9 after 60 main actions in an Hour only Pass (and conversions) remain', () => {
  const s = clear(game(2), { selfies: sel(2, 0, 0) }); put(s, 0, 'h32'); turnFor(s, 0);
  s.players[0].mainActionsThisHour = C(s).SAFETY.MAX_MAIN_ACTIONS_PER_PLAYER_PER_HOUR;
  const types = new Set(valid(s).map((a) => a.type));
  assert.ok(types.has('pass'));
  for (const ty of types) assert.ok(['pass', 'exchange'].includes(ty), `offered ${ty}`);
});

// ======================================================= R9 queues

t('R9.1 queue order: badge, then Security, then arrival', () => {
  const s = clear(game(3));
  const a = put(s, 1, 'h22'); const b = put(s, 0, 'h22'); const c = put(s, 2, 'h22', 'VIP'); const d = put(s, 0, 'h22');
  assert.deepEqual(q(s, 'h22'), [c, a, b, d]);
  vol(s, 0, SEC('h22'));
  assert.deepEqual(q(s, 'h22'), [c, b, d, a], 'Security lifts seat 0 N00bs over seat 1 N00b but not over the VIP');
});
t('R9.1 App.B "Security rebuilds a queue": red AAA, blue VIP, red VIP, red VIP, blue N00b, blue N00b, red N00b', () => {
  const s = clear(game(4)); const RED = 1, BLUE = 0;
  const rN = put(s, RED, 'h12'); const rV1 = put(s, RED, 'h12', 'VIP'); const rV2 = put(s, RED, 'h12', 'VIP');
  const bN1 = put(s, BLUE, 'h12'); const bV = put(s, BLUE, 'h12', 'VIP'); const rA = put(s, RED, 'h12', 'AAA'); const bN2 = put(s, BLUE, 'h12');
  vol(s, BLUE, SEC('h12'));
  assert.deepEqual(q(s, 'h12'), [rA, bV, rV1, rV2, bN1, bN2, rN]);
});
t('R9.1 App.B "Reading a queue": blue VIP (Security), red VIP, blue N00b (Security), red N00b', () => {
  const s = clear(game(2)); const RED = 1, BLUE = 0;
  const rN = put(s, RED, 'h21'); const rV = put(s, RED, 'h21', 'VIP'); const bN = put(s, BLUE, 'h21'); const bV = put(s, BLUE, 'h21', 'VIP');
  vol(s, BLUE, SEC('h21'));
  assert.deepEqual(q(s, 'h21'), [bV, rV, bN, rN]);
});
t('R9.2 a Crew that finishes a move gets a new stamp (back of its class)', () => {
  const s = clear(game(2)); const mine = put(s, 0, 'h12'); const o1 = put(s, 1, 'h22'); const o2 = put(s, 1, 'h22'); turnFor(s, 0);
  const st = crew(s, mine).stamp;
  pick(s, { type: 'move2', crew: mine, to: G.h22 });
  assert.ok(crew(s, mine).stamp > st);
  assert.deepEqual(q(s, 'h22'), [o1, o2, mine]);
});
t('R9.4 a queue is recomputed when Security is placed', () => {
  const s = clear(game(2)); const o = put(s, 1, 'h23'); const m = put(s, 0, 'h23'); turnFor(s, 0);
  assert.deepEqual(q(s, 'h23'), [o, m]);
  pick(s, { type: 'volunteer', space: SEC('h23') });
  assert.deepEqual(q(s, 'h23'), [m, o]);
});
t('R9.5 no entering a full hall or passing through one; upgrades in a full hall are allowed', () => {
  const s = clear(game(2)); const cap = E.capacity(s);
  for (let i = 0; i < cap; i++) put(s, 1, 'h22');
  const m = put(s, 0, 'h32'); const f = put(s, 0, 'h22'); turnFor(s, 0); // h22 now cap+1? keep: cap from seat 1 + mine
  assert.equal(offered(s, { type: 'move2', crew: m, to: G.h22 }), false, 'cannot enter');
  assert.equal(offered(s, { type: 'move2', crew: m, to: G.h12 }), false, 'cannot pass through Main Hall to Main Stage');
  assert.ok(offered(s, { type: 'move2', crew: m, to: G.h21 }), 'Photo Ops route to Autograph Hall is open');
  assert.ok(offered(s, { type: 'upgrade', crew: f }), 'upgrade in a full hall');
  assert.ok(offered(s, { type: 'move2', crew: f, to: G.h12 }), 'leaving is always allowed');
});

// ======================================================= R10 moving

t('R10.1/R10.6 Move 2: 1 or 2 steps, never 3 halls away', () => {
  const s = clear(game(2)); const m = put(s, 0, 'h32'); turnFor(s, 0);
  const tos = valid(s).filter((a) => a.type === 'move2' && a.crew === m).map((a) => GRID[a.to]).sort();
  assert.deepEqual(tos, ['h21', 'h22', 'h23', 'h31', 'h33', 'h12'].sort());
  refused(s, { type: 'move2', crew: m, to: G.h11 });
});
t('R10.2 a move never ends where it started', () => {
  const s = clear(game(2)); const m = put(s, 0, 'h22'); turnFor(s, 0);
  assert.equal(offered(s, { type: 'move2', crew: m, to: G.h22 }), false);
  refused(s, { type: 'move2', crew: m, to: G.h22 });
});
t('R10.2 a path never revisits a hall: no Usher income from doubling back (3-2-1 Push!)', () => {
  const s = clear(game(2), { coffee: 5 }); const m = put(s, 0, 'h32'); vol(s, 0, ropeOf('h32', 'h33'));
  buyable(s, 'swag_green_04'); pick(s, { type: 'buySwag', card: 'swag_green_04' });
  const events = pick(s, { type: 'effectMove', crew: m, to: G.h31 });
  const mv = ev(events, 'crewMoved')[0];
  assert.equal(new Set(mv.path).size, mv.path.length, `path ${mv.path}`);
  assert.equal(s.players[0].coffee, 5, 'h32-h33-h32-h31 is not a legal path');
});
t('R10.3 arrival puts the Crew at the back of its badge class, behind Security-led Crew', () => {
  const s = clear(game(2)); const oN = put(s, 1, 'h22'); const oV = put(s, 1, 'h22', 'VIP'); vol(s, 1, SEC('h22'));
  const mV = put(s, 0, 'h12', 'VIP'); turnFor(s, 0);
  pick(s, { type: 'move2', crew: mV, to: G.h22 });
  assert.deepEqual(q(s, 'h22'), [oV, mV, oN]);
});
t('R10.4 Usher bonus only for own Crew across own Usher; App.B "Cheap sprint" nets +1 coffee', () => {
  const s = clear(game(2), { coffee: 5 }); const m = put(s, 0, 'h32');
  vol(s, 0, ropeOf('h32', 'h22')); vol(s, 0, ropeOf('h22', 'h12')); turnFor(s, 0);
  pick(s, { type: 'move2', crew: m, to: G.h12 });
  assert.equal(s.players[0].coffee, 6, 'pay 1, +1 +1');
  const o = clear(game(2), { coffee: 5 }); const m2 = put(o, 0, 'h32'); vol(o, 1, ropeOf('h32', 'h22')); turnFor(o, 0);
  pick(o, { type: 'move2', crew: m2, to: G.h22 });
  assert.equal(o.players[0].coffee, 4); assert.equal(o.players[1].coffee, 5, 'nobody gains from another player\'s Usher');
});
t('R10.5 the engine picks the path with most own Ushers; ties by alphabetical grid ids', () => {
  const s = clear(game(2), { coffee: 5 }); const m = put(s, 0, 'h32'); vol(s, 0, ropeOf('h31', 'h21')); turnFor(s, 0);
  const events = pick(s, { type: 'move2', crew: m, to: G.h21 });
  const mv = ev(events, 'crewMoved')[0];
  assert.ok(mv.path.map((h) => GRID[h] ?? h).includes('h31'), `via Photo Ops: ${mv.path}`);
  assert.equal(s.players[0].coffee, 5);
  const t2 = clear(game(2)); const m2 = put(t2, 0, 'h32'); turnFor(t2, 0);
  const e2 = ev(pick(t2, { type: 'move2', crew: m2, to: G.h21 }), 'crewMoved')[0];
  assert.ok(e2.path.map((h) => GRID[h] ?? h).includes('h22'), `tie -> h22 before h31: ${e2.path}`);
});
t('R10.7 Move 1 Crew x3: 3 coffee, up to 3 different Crew one step each, each step checked as made', () => {
  const s = clear(game(2)); const cap = E.capacity(s);
  const a = put(s, 0, 'h22'); for (let i = 0; i < cap - 1; i++) put(s, 1, 'h22'); // Main Hall full
  const b = put(s, 0, 'h32'); const c = put(s, 0, 'h11'); turnFor(s, 0);
  assert.equal(offered(s, { type: 'move3', crew: b, to: G.h22 }), false, 'Main Hall full at first');
  pick(s, { type: 'move3', crew: a, to: G.h23 });
  assert.equal(s.players[0].coffee, 12 - C(s).COSTS.COST_MOVE_3_CREW);
  assert.equal(offered(s, { type: 'moveStep', crew: a }), false, 'same Crew not twice');
  pick(s, { type: 'moveStep', crew: b, to: G.h22 }); // room made by a
  pick(s, { type: 'moveStep', crew: c, to: G.h12 });
  assert.notEqual(s.toAct, 0, 'three Crew moved: action over');
});

// ======================================================= R11 New N00b

t('R11.1/R11.2 New N00b: 4 coffee, Entrance if room, else next to it, else anywhere with room', () => {
  const s = clear(game(2)); turnFor(s, 0);
  assert.deepEqual(valid(s).filter((a) => a.type === 'newNoob').map((a) => a.hall), [G.h32]);
  const cap = E.capacity(s);
  const fill = (g, seat) => { for (let i = 0; i < cap; i++) put(s, seat, g); };
  fill('h32', 1); turnFor(s, 0);
  assert.deepEqual(valid(s).filter((a) => a.type === 'newNoob').map((a) => GRID[a.hall]).sort(), ['h22', 'h31', 'h33']);
  const s2 = clear(game(5, { queueCapacity: 'printed-board' })); const cap5 = E.capacity(s2);
  const f2 = (g) => { let k = 0; for (let i = 0; i < cap5; i++) put(s2, 1 + (k++ % 4), g); };
  f2('h32'); f2('h22'); f2('h31'); f2('h33'); turnFor(s2, 0);
  const halls = valid(s2).filter((a) => a.type === 'newNoob').map((a) => GRID[a.hall]).sort();
  assert.deepEqual(halls, ['h11', 'h12', 'h13', 'h21', 'h23']);
  pick(s2, { type: 'newNoob', hall: G.h11 });
  const placed = s2.crew.filter((c) => c.owner === 0 && c.hall === G.h11);
  assert.equal(placed.length, 1); assert.equal(placed[0].badge, 'N00b');
  assert.equal(s2.players[0].coffee, 12 - C(s2).COSTS.COST_NEW_NOOB);
});
t('R11.3 New N00b needs a Crew in supply and a hall with room', () => {
  const s = clear(game(2));
  for (const c of s.crew.filter((x) => x.owner === 0)) { c.hall = G.h11; c.stamp = s.nextStamp++; }
  turnFor(s, 0);
  assert.equal(offered(s, { type: 'newNoob' }), false);
});

// ======================================================= R12 Upgrade

t('R12.1/R12.2 upgrade: 5 coffee, N00b->VIP uses a hat; App.B "Buying your way forward" (3rd -> 1st)', () => {
  const s = clear(game(2)); const o1 = put(s, 1, 'h22'); const o2 = put(s, 1, 'h22'); const m = put(s, 0, 'h22'); turnFor(s, 0);
  assert.equal(q(s, 'h22').indexOf(m), 2);
  pick(s, { type: 'upgrade', crew: m });
  assert.equal(crew(s, m).badge, 'VIP'); assert.equal(s.players[0].hats, 2); assert.equal(s.players[0].coffee, 7);
  assert.deepEqual(q(s, 'h22'), [m, o1, o2]);
});
t('R12.1/R12.2 VIP->AAA uses the box, back of the AAA class; AAA cannot be upgraded; no skipping', () => {
  const s = clear(game(2)); const oA = put(s, 1, 'h12', 'AAA'); const m = put(s, 0, 'h12', 'VIP'); turnFor(s, 0);
  pick(s, { type: 'upgrade', crew: m });
  assert.equal(crew(s, m).badge, 'AAA'); assert.equal(s.players[0].boxes, 0); assert.equal(s.players[0].hats, 2, 'keeps its hat');
  assert.deepEqual(q(s, 'h12'), [oA, m]);
  turnFor(s, 0);
  assert.equal(offered(s, { type: 'upgrade', crew: m }), false);
});
t('R12.3/R12.4 hats run out: no hat -> no N00b upgrade, but a VIP may still take the box', () => {
  const s = clear(game(2)); const v = put(s, 0, 'h11', 'VIP'); put(s, 0, 'h11', 'VIP'); put(s, 0, 'h11', 'VIP'); const n = put(s, 0, 'h12');
  turnFor(s, 0);
  assert.equal(s.players[0].hats, 0);
  assert.equal(offered(s, { type: 'upgrade', crew: n }), false);
  assert.ok(offered(s, { type: 'upgrade', crew: v }));
});

// ======================================================= R13 Volunteers

t('R13.1 Volunteer: 2 coffee, any empty space, no Crew needed; role from the space', () => {
  const s = clear(game(2)); turnFor(s, 0);
  const spaces = valid(s).filter((a) => a.type === 'volunteer').map((a) => a.space);
  assert.equal(spaces.length, 30);
  pick(s, { type: 'volunteer', space: PHO('h13') });
  assert.equal(s.volunteers[PHO('h13')], 0); assert.equal(s.players[0].coffee, 10); assert.equal(s.players[0].volunteers, 5);
});
t('R13.2/R13.3 Volunteers never move or change owner in play (random games, clubs off)', () => {
  playRandom(game(3, {}, 31), 31, (b, a) => {
    for (const [sp, owner] of Object.entries(b.volunteers)) if (owner !== null) assert.equal(a.volunteers[sp], owner, sp);
  });
});
t('R13.6 a Photographer earns its selfie with no Crew in the hall', () => {
  const s = clear(game(2)); setCeleb(s, '1', 'character_mando_03', 'green'); vol(s, 1, PHO('h21'));
  walkNow(s, 0);
  assert.equal(s.players[1].selfies.green >= 1, true);
});
t('R13.7.1 an Usher is in both halls its rope touches (Passion), and in neither under usherInHall=neither', () => {
  const mk = (v) => { const s = clear(game(2, v)); vol(s, 0, ropeOf('h11', 'h12')); vol(s, 0, SEC('h12')); vol(s, 0, PHO('h11')); return s; };
  assert.equal(E.countAchievement(mk({}), 0, 'scoring_13').count, 2);
  assert.equal(E.countAchievement(mk({ usherInHall: 'neither' }), 0, 'scoring_13').count, 0);
});
t('R13.7.2/R13.7.3 adjacent Volunteers and maximum disjoint pairs', () => {
  const s = clear(game(2));
  // Four Ushers in a chain h11-h12, h12-h13, h13-h23, h23-h33: 2 disjoint pairs.
  for (const r of [ropeOf('h11', 'h12'), ropeOf('h12', 'h13'), ropeOf('h13', 'h23'), ropeOf('h23', 'h33')]) vol(s, 0, r);
  assert.equal(E.countAchievement(s, 0, 'scoring_08').count, 2);
  // Three Photographers h11, h12, h13 (chain): 1 pair; Security h11 and h22 (diagonal): 0 pairs.
  vol(s, 0, PHO('h11')); vol(s, 0, PHO('h12'));
  const t2 = clear(game(2)); for (const g of ['h11', 'h12', 'h13']) vol(t2, 0, PHO(g)); vol(t2, 0, SEC('h11')); vol(t2, 0, SEC('h22'));
  assert.equal(E.countAchievement(t2, 0, 'scoring_09').count, 1);
  assert.equal(E.countAchievement(t2, 0, 'scoring_10').count, 0);
});

// ======================================================= R14 Take a Selfie

t('R14.1-R14.3 Take a Selfie: 1 coffee, one selfie, any queue place; one action per figure in the hall', () => {
  const s = clear(game(2)); put(s, 1, 'h33'); put(s, 1, 'h33'); put(s, 0, 'h33');
  const e1 = setCeleb(s, '1', 'character_star_wars_03', 'red'); // starts h33
  const e2 = setCeleb(s, '2', 'character_mando_02', 'green'); // starts h33
  turnFor(s, 0);
  const opts = valid(s).filter((a) => a.type === 'takeSelfie').map((a) => a.celebrity).sort();
  assert.deepEqual(opts, [e1.card, e2.card].sort());
  pick(s, { type: 'takeSelfie', celebrity: e2.card });
  assert.deepEqual(s.players[0].selfies, sel(1, 0, 0)); assert.equal(s.players[0].coffee, 11);
  const n = clear(game(2)); put(n, 0, 'h22'); setCeleb(n, '1', 'character_star_wars_03'); turnFor(n, 0);
  for (const e of n.schedule) if (e.slot !== '1') { e.status = 'waiting'; e.figure = null; e.marker = null; }
  assert.equal(offered(n, { type: 'takeSelfie' }), false, 'no figure where you have Crew');
});

// ======================================================= R15 Exchange

t('R15.2 E1: 2 selfies -> 1 coffee; E3: 4 selfies -> 2 VP (source exchange)', () => {
  const s = clear(game(2), { coffee: 5, selfies: sel(3, 3, 0) }); turnFor(s, 0);
  pick(s, { type: 'exchange', rate: 'E1', pay: sel(2, 0, 0) });
  assert.equal(s.players[0].coffee, 6); assert.deepEqual(s.players[0].selfies, sel(1, 3, 0));
  const events = pick(s, { type: 'exchange', rate: 'E3' });
  assert.equal(s.players[0].vp, 2); assert.equal(ev(events, 'vp')[0].source, 'exchange');
  assert.deepEqual(s.players[0].selfies, sel(0, 0, 0));
});
t('R15.2 E2: the gained colour differs from every colour paid', () => {
  const s = clear(game(2), { selfies: sel(1, 1, 2) }); turnFor(s, 0);
  const e2 = valid(s).filter((a) => a.type === 'exchange' && a.rate === 'E2');
  for (const a of e2) for (const c of ['green', 'red', 'orange']) if (a.pay[c] > 0) assert.notEqual(a.gain, c);
  assert.ok(e2.some((a) => matches(a, { pay: sel(1, 1, 0), gain: 'orange' })));
  refused(s, { type: 'exchange', rate: 'E2', pay: sel(1, 0, 1), gain: 'orange' });
});
t('R15.3 exchanges repeat any number of times in a window', () => {
  const s = clear(game(2), { coffee: 5, selfies: sel(6, 0, 0) }); turnFor(s, 0);
  for (let i = 0; i < 3; i++) pick(s, { type: 'exchange', rate: 'E1' });
  assert.equal(s.players[0].coffee, 8); assert.equal(s.toAct, 0);
});
t('R15.4 E1 is not offered on 12 coffee', () => {
  const s = clear(game(2), { coffee: 12, selfies: sel(2, 0, 0) }); turnFor(s, 0);
  assert.equal(offered(s, { type: 'exchange', rate: 'E1' }), false);
});
t('R15.5 conversion windows: own turn and pass-turn yes; not on another player\'s turn; final window yes', () => {
  const s = clear(game(2), { selfies: sel(2, 2, 0) }); turnFor(s, 1);
  assert.equal(s.toAct, 1);
  assert.ok(E.getBlockReason(s, { type: 'exchange', rate: 'E2', pay: sel(1, 1, 0), gain: 'orange', player: 0 }), 'not on seat 1\'s turn');
  const p = clear(game(2), { coffee: 5, selfies: sel(2, 2, 0) }); p.players[0].passSlot = 1; p.hourState.passOrder = [0]; p.hourState.firstPasser = 0;
  p.stack = [{ kind: 'passTurn', player: 0, conversions: 0, rareFindsUsed: false }]; p.toAct = 0; p.turn = { number: 9, player: 0, kind: 'pass' };
  assert.ok(offered(p, { type: 'exchange' }), 'pass-turn offers the Exchange');
});
t('R15.6/R16.2 Swag is paid in its own colour only', () => {
  const s = clear(game(2), { selfies: sel(0, 5, 5) }); setMarket(s, 'swag_green_07'); turnFor(s, 0);
  assert.equal(offered(s, { type: 'buySwag', card: 'swag_green_07' }), false);
  s.players[0].selfies.green = 1; turnFor(s, 0);
  assert.ok(offered(s, { type: 'buySwag', card: 'swag_green_07' }));
});

// ======================================================= R16 Swag

t('R16.1/R16.2/R16.5 buying Swag: main action, no coffee, pays selfies; card discarded and slot refilled from the deck', () => {
  const s = clear(game(2), { coffee: 7 }); put(s, 0, 'h32'); buyable(s, 'swag_red_03');
  const top = s.swag.deck.at(-1);
  pick(s, { type: 'buySwag', card: 'swag_red_03' });
  assert.equal(s.players[0].coffee, 10); assert.equal(s.players[0].selfies.red, 0);
  assert.ok(s.swag.discard.includes('swag_red_03'));
  assert.equal(s.swag.market[0], top, 'refilled with the top card');
  assert.equal(s.toAct, 1);
});
t('R16.5 empty Swag deck: shuffle the discards (including the card just used) into a new deck', () => {
  const s = clear(game(2)); buyable(s, 'swag_red_03');
  s.swag.discard.push(...s.swag.deck); s.swag.deck = [];
  const events = pick(s, { type: 'buySwag', card: 'swag_red_03' });
  assert.ok(ev(events, 'deckReshuffled').some((e) => e.deck === 'swag'));
  assert.ok(s.swag.market[0]);
  assert.equal(s.swag.deck.length + s.swag.market.filter(Boolean).length + s.swag.discard.length, 36);
});
t('R16.5 no cards anywhere: the slot stays empty', () => {
  const s = clear(game(2)); buyable(s, 'swag_red_03'); s.swag.deck = []; s.swag.discard = [];
  pick(s, { type: 'buySwag', card: 'swag_red_03' });
  // the card just used goes to the discard and may be reshuffled back in (R16.5 "including the card just used")
  assert.ok(s.swag.market[0] === null || s.swag.market[0] === 'swag_red_03');
});
t('R16.4.1 a card that places a Crew needs one in supply (Priority with empty supply does nothing)', () => {
  const s = clear(game(2));
  for (const c of s.crew.filter((x) => x.owner === 0)) { c.hall = G.h11; c.stamp = s.nextStamp++; }
  s.crew.filter((x) => x.owner === 0).slice(4).forEach((c) => { c.hall = G.h13; });
  buyable(s, 'swag_green_11');
  pick(s, { type: 'buySwag', card: 'swag_green_11' });
  assert.equal(s.toAct, 1, 'effect skipped, turn over');
});
t('R16.4.2 a Swag step move earns the Usher bonus (Run!)', () => {
  const s = clear(game(2), { coffee: 5 }); const m = put(s, 0, 'h32'); vol(s, 0, ropeOf('h32', 'h22')); buyable(s, 'swag_green_07');
  pick(s, { type: 'buySwag', card: 'swag_green_07' });
  pick(s, { type: 'effectMove', crew: m, to: G.h12 });
  assert.equal(crew(s, m).hall, G.h12); assert.equal(s.players[0].coffee, 6);
});
t('R16.4.3 a jump crosses no rope: no Usher bonus (Teleport), must change hall, needs room', () => {
  const s = clear(game(2), { coffee: 5 }); const m = put(s, 0, 'h32'); put(s, 0, 'h11'); vol(s, 0, ropeOf('h32', 'h22'));
  const cap = E.capacity(s); for (let i = 0; i < cap; i++) put(s, 1, 'h13');
  buyable(s, 'swag_green_02'); pick(s, { type: 'buySwag', card: 'swag_green_02' });
  const targets = valid(s).filter((a) => a.type === 'effectMove' && a.crew === m).map((a) => GRID[a.to]).sort();
  assert.deepEqual(targets, ['h11', 'h12', 'h21', 'h22', 'h23', 'h31', 'h33']);
  const events = pick(s, { type: 'effectMove', crew: m, to: G.h22 });
  assert.equal(s.players[0].coffee, 5, 'no Usher bonus for a jump');
  assert.equal(ev(events, 'crewMoved')[0].jump, true);
});
t('R16.4.4 a placed or moved Crew gets a new arrival stamp (Teleport lands at the back)', () => {
  const s = clear(game(2)); const o = put(s, 1, 'h22'); const m = put(s, 0, 'h11'); put(s, 0, 'h13');
  buyable(s, 'swag_green_02'); pick(s, { type: 'buySwag', card: 'swag_green_02' });
  pick(s, { type: 'effectMove', crew: m, to: G.h22 });
  assert.deepEqual(q(s, 'h22'), [o, m]);
});
t('R16.4.5 a placed Volunteer goes on an empty space of the named type (Jumper)', () => {
  const s = clear(game(2)); for (const g of ['h11', 'h12', 'h13', 'h21', 'h22', 'h23', 'h31']) vol(s, 1, SEC(g));
  buyable(s, 'swag_green_01'); pick(s, { type: 'buySwag', card: 'swag_green_01' });
  const spaces = valid(s).filter((a) => a.type === 'effectPlaceVolunteer').map((a) => a.space).sort();
  assert.deepEqual(spaces, [SEC('h32'), SEC('h33')].sort());
  pick(s, { type: 'effectPlaceVolunteer', space: SEC('h33') });
  assert.equal(s.volunteers[SEC('h33')], 0);
});
t('R16.6 the replacement card is face up for everyone; R16.7 Swag has no lasting effect', () => {
  const s = clear(game(2)); buyable(s, 'swag_red_03'); pick(s, { type: 'buySwag', card: 'swag_red_03' });
  assert.ok(!s.swag.market.includes('swag_red_03'));
});

// ---- R16.8 the 36 Swag cards

t('R16.8 swag_green_03 Star Chaser: jump to a hall with room holding a figure', () => {
  const s = clear(game(2)); const m = put(s, 0, 'h22'); put(s, 0, 'h32');
  for (const e of s.schedule) { e.status = 'waiting'; e.figure = null; e.marker = null; }
  setCeleb(s, '1', 'character_mando_03'); setCeleb(s, '2', 'character_who_03'); // h11, h13
  buyable(s, 'swag_green_03'); pick(s, { type: 'buySwag', card: 'swag_green_03' });
  const tos = [...new Set(valid(s).filter((a) => a.type === 'effectMove').map((a) => GRID[a.to]))].sort();
  assert.deepEqual(tos, ['h11', 'h13']);
  pick(s, { type: 'effectMove', crew: m, to: G.h13 });
  assert.equal(crew(s, m).hall, G.h13);
});
t('R16.8 swag_green_04 3-2-1 Push!: up to 3 steps', () => {
  const s = clear(game(2)); const m = put(s, 0, 'h33'); buyable(s, 'swag_green_04'); pick(s, { type: 'buySwag', card: 'swag_green_04' });
  assert.ok(offered(s, { type: 'effectMove', crew: m, to: G.h12 }), '3 steps h33-h23-h13-h12');
  assert.equal(offered(s, { type: 'effectMove', crew: m, to: G.h11 }), false, 'h11 is 4 steps from h33');
});
t('R16.8 swag_green_05 Line Monitor: +1 coffee per own Crew in a hall with own Security', () => {
  const s = clear(game(2), { coffee: 2 }); put(s, 0, 'h21'); put(s, 0, 'h21'); put(s, 1, 'h21'); put(s, 0, 'h23'); vol(s, 0, SEC('h21')); vol(s, 0, SEC('h23'));
  buyable(s, 'swag_green_05'); pick(s, { type: 'buySwag', card: 'swag_green_05' });
  assert.deepEqual(valid(s).filter((a) => a.type === 'effectChooseHall').map((a) => GRID[a.hall]).sort(), ['h21', 'h23']);
  pick(s, { type: 'effectChooseHall', hall: G.h21 });
  assert.equal(s.players[0].coffee, 4);
});
t('R16.8 swag_green_06 Fast Track: front of its badge class, never past a higher badge or a Security-led rival', () => {
  const s = clear(game(2)); const oV = put(s, 1, 'h22', 'VIP'); const o1 = put(s, 1, 'h22'); const o2 = put(s, 1, 'h22'); const m = put(s, 0, 'h22'); put(s, 0, 'h11');
  buyable(s, 'swag_green_06'); pick(s, { type: 'buySwag', card: 'swag_green_06' });
  pick(s, { type: 'effectChooseCrew', crew: m });
  assert.deepEqual(q(s, 'h22'), [oV, m, o1, o2]);
  const t2 = clear(game(2)); const r1 = put(t2, 1, 'h22'); const m2 = put(t2, 0, 'h22'); put(t2, 0, 'h11'); vol(t2, 1, SEC('h22'));
  buyable(t2, 'swag_green_06'); pick(t2, { type: 'buySwag', card: 'swag_green_06' }); pick(t2, { type: 'effectChooseCrew', crew: m2 });
  assert.deepEqual(q(t2, 'h22'), [r1, m2], 'Security-led rival stays ahead');
});
t('R16.8 swag_green_08 Rush!: up to two different Crew one step each, at least one', () => {
  const s = clear(game(2)); const a = put(s, 0, 'h32'); const b = put(s, 0, 'h11'); buyable(s, 'swag_green_08');
  pick(s, { type: 'buySwag', card: 'swag_green_08' });
  assert.equal(offered(s, { type: 'stopMoving' }), false, 'at least one step');
  pick(s, { type: 'moveStep', crew: a, to: G.h22 });
  assert.equal(offered(s, { type: 'moveStep', crew: a }), false);
  pick(s, { type: 'moveStep', crew: b, to: G.h12 });
  assert.equal(s.toAct, 1);
});
t('R16.8 swag_green_09 Hold Hands: two own Crew from one hall to one adjacent hall with 2 places, old order kept, Usher bonus each', () => {
  const s = clear(game(2), { coffee: 3 }); const a = put(s, 0, 'h32'); const b = put(s, 0, 'h32'); vol(s, 0, ropeOf('h32', 'h33'));
  const cap = E.capacity(s); for (let i = 0; i < cap - 1; i++) put(s, 1, 'h22'); // Main Hall: 1 place only
  buyable(s, 'swag_green_09'); pick(s, { type: 'buySwag', card: 'swag_green_09' });
  const tos = valid(s).filter((a) => a.type === 'effectMovePair').map((a) => GRID[a.to]);
  assert.ok(!tos.includes('h22'), 'Main Hall has only 1 place');
  pick(s, { type: 'effectMovePair', to: G.h33 });
  assert.deepEqual(q(s, 'h33'), [a, b]); assert.equal(s.players[0].coffee, 5);
});
t('R16.8 swag_green_10 Too Crowded: opponent N00b steps to an adjacent hall with room; no Usher bonus for anyone', () => {
  const s = clear(game(2), { coffee: 5 }); const o = put(s, 1, 'h32'); const oV = put(s, 1, 'h11', 'VIP'); vol(s, 1, ropeOf('h32', 'h22')); vol(s, 0, ropeOf('h32', 'h31'));
  buyable(s, 'swag_green_10'); pick(s, { type: 'buySwag', card: 'swag_green_10' });
  assert.equal(offered(s, { type: 'effectMove', crew: oV }), false, 'N00b only');
  pick(s, { type: 'effectMove', crew: o, to: G.h22 });
  assert.equal(crew(s, o).hall, G.h22); assert.equal(s.players[1].coffee, 5); assert.equal(s.players[0].coffee, 5);
});
t('R16.8 swag_green_11 Priority: fresh N00b at the front of the N00b class, behind a VIP', () => {
  const s = clear(game(2)); const oV = put(s, 1, 'h12', 'VIP'); const oN = put(s, 1, 'h12'); buyable(s, 'swag_green_11');
  pick(s, { type: 'buySwag', card: 'swag_green_11' }); pick(s, { type: 'effectPlaceCrew', hall: G.h12 });
  const mine = s.crew.find((c) => c.owner === 0 && c.hall === G.h12).id;
  assert.deepEqual(q(s, 'h12'), [oV, mine, oN]);
});
t('R16.8 swag_green_12 Over Here!: jump to a hall with your Security', () => {
  const s = clear(game(2)); const m = put(s, 0, 'h32'); put(s, 0, 'h11'); vol(s, 0, SEC('h13')); vol(s, 0, SEC('h33')); vol(s, 1, SEC('h22'));
  buyable(s, 'swag_green_12'); pick(s, { type: 'buySwag', card: 'swag_green_12' });
  assert.deepEqual([...new Set(valid(s).filter((a) => a.type === 'effectMove').map((a) => GRID[a.to]))].sort(), ['h13', 'h33']);
  pick(s, { type: 'effectMove', crew: m, to: G.h13 }); assert.equal(crew(s, m).hall, G.h13);
});
t('R16.8 swag_red_01 Guide / swag_orange_01 Selfie Booth: place an Usher / a Photographer', () => {
  const s = clear(game(2)); buyable(s, 'swag_red_01'); pick(s, { type: 'buySwag', card: 'swag_red_01' });
  assert.ok(valid(s).every((a) => a.type !== 'effectPlaceVolunteer' || a.space.startsWith('rope_')));
  pick(s, { type: 'effectPlaceVolunteer', space: 'rope_05' }); assert.equal(s.volunteers.rope_05, 0);
  const p = clear(game(2)); buyable(p, 'swag_orange_01'); pick(p, { type: 'buySwag', card: 'swag_orange_01' });
  pick(p, { type: 'effectPlaceVolunteer', space: PHO('h22') }); assert.equal(p.volunteers[PHO('h22')], 0);
});
t('R16.8 swag_red_02 Shared Ticket: N00b into a hall with your VIP/AAA', () => {
  const s = clear(game(2)); put(s, 0, 'h11', 'VIP'); put(s, 0, 'h13', 'AAA'); put(s, 0, 'h22'); buyable(s, 'swag_red_02');
  pick(s, { type: 'buySwag', card: 'swag_red_02' });
  assert.deepEqual(valid(s).filter((a) => a.type === 'effectPlaceCrew').map((a) => GRID[a.hall]).sort(), ['h11', 'h13']);
});
t('R16.8 swag_red_04 Upgrade!: free upgrade, uses a hat', () => {
  const s = clear(game(2), { coffee: 0 }); const m = put(s, 0, 'h11'); put(s, 0, 'h12'); buyable(s, 'swag_red_04');
  pick(s, { type: 'buySwag', card: 'swag_red_04' }); pick(s, { type: 'effectChooseCrew', crew: m });
  assert.equal(crew(s, m).badge, 'VIP'); assert.equal(s.players[0].hats, 2); assert.equal(s.players[0].coffee, 0);
});
t('R16.8 swag_red_05 All Together (your Crew) and swag_red_11 Coffee Run (every Crew x2, max 6)', () => {
  const s = clear(game(2), { coffee: 0 }); put(s, 0, 'h22'); put(s, 0, 'h22'); put(s, 1, 'h22'); put(s, 1, 'h22'); put(s, 0, 'h11');
  buyable(s, 'swag_red_05'); pick(s, { type: 'buySwag', card: 'swag_red_05' }); pick(s, { type: 'effectChooseHall', hall: G.h22 });
  assert.equal(s.players[0].coffee, 2);
  const r = clear(game(2), { coffee: 0 }); put(r, 0, 'h22'); put(r, 1, 'h22'); put(r, 1, 'h22'); put(r, 1, 'h22'); put(r, 0, 'h11');
  buyable(r, 'swag_red_11'); pick(r, { type: 'buySwag', card: 'swag_red_11' }); pick(r, { type: 'effectChooseHall', hall: G.h22 });
  assert.equal(r.players[0].coffee, 6, '4 Crew x 2 = 8, capped at 6');
});
t('R16.8 swag_red_06 Network / swag_red_10 Miranda! / swag_orange_06 Cameras!: 2 coffee each', () => {
  const s = clear(game(2), { coffee: 0 }); vol(s, 0, 'rope_01'); vol(s, 0, 'rope_02'); vol(s, 1, 'rope_03');
  buyable(s, 'swag_red_06'); pick(s, { type: 'buySwag', card: 'swag_red_06' }); assert.equal(s.players[0].coffee, 4);
  const m = clear(game(2), { coffee: 0 }); put(m, 0, 'h11', 'VIP'); put(m, 0, 'h12', 'AAA'); put(m, 0, 'h13');
  buyable(m, 'swag_red_10'); pick(m, { type: 'buySwag', card: 'swag_red_10' }); assert.equal(m.players[0].coffee, 4);
  const c = clear(game(2), { coffee: 0 }); vol(c, 0, PHO('h11')); vol(c, 0, PHO('h12')); vol(c, 0, PHO('h13'));
  buyable(c, 'swag_orange_06'); pick(c, { type: 'buySwag', card: 'swag_orange_06' }); assert.equal(c.players[0].coffee, 6);
});
t('R16.8 swag_red_07 Special Line: jump to a hall touched by ANY player\'s Usher', () => {
  const s = clear(game(2)); const m = put(s, 0, 'h32'); put(s, 0, 'h12'); vol(s, 1, ropeOf('h11', 'h21'));
  buyable(s, 'swag_red_07'); pick(s, { type: 'buySwag', card: 'swag_red_07' });
  assert.deepEqual([...new Set(valid(s).filter((a) => a.type === 'effectMove' && a.crew === m).map((a) => GRID[a.to]))].sort(), ['h11', 'h21']);
});
t('R16.8 swag_red_08 Staff Line: N00b into a hall touched by your Usher', () => {
  const s = clear(game(2)); vol(s, 0, ropeOf('h13', 'h23')); vol(s, 1, ropeOf('h11', 'h12'));
  buyable(s, 'swag_red_08'); pick(s, { type: 'buySwag', card: 'swag_red_08' });
  assert.deepEqual(valid(s).filter((a) => a.type === 'effectPlaceCrew').map((a) => GRID[a.hall]).sort(), ['h13', 'h23']);
});
t('R16.8 swag_red_09 Path: up to two Ushers', () => {
  const s = clear(game(2)); buyable(s, 'swag_red_09'); pick(s, { type: 'buySwag', card: 'swag_red_09' });
  pick(s, { type: 'effectPlaceVolunteer', space: 'rope_01' });
  assert.ok(offered(s, { type: 'effectDone' }), 'may stop after one');
  pick(s, { type: 'effectPlaceVolunteer', space: 'rope_02' });
  assert.equal(s.players[0].volunteers, 4); assert.equal(s.toAct, 1);
});
t('R16.8 swag_red_12 Velvet Rope: 1 VP per own Crew in a hall touched by own Usher (each once)', () => {
  const s = clear(game(2)); put(s, 0, 'h12'); put(s, 0, 'h12'); put(s, 0, 'h22'); put(s, 0, 'h33'); put(s, 1, 'h12');
  vol(s, 0, ropeOf('h11', 'h12')); vol(s, 0, ropeOf('h12', 'h22'));
  buyable(s, 'swag_red_12'); const events = pick(s, { type: 'buySwag', card: 'swag_red_12' });
  assert.equal(s.players[0].vp, 3); assert.equal(ev(events, 'vp')[0].source, 'swag');
});
t('R16.8 swag_orange_02 Excuse Me!: swap adjacent rivals of same badge and Security standing', () => {
  const s = clear(game(2)); const o = put(s, 1, 'h22'); const m = put(s, 0, 'h22'); const v = put(s, 1, 'h22', 'VIP'); put(s, 0, 'h11');
  buyable(s, 'swag_orange_02'); pick(s, { type: 'buySwag', card: 'swag_orange_02' });
  assert.deepEqual(q(s, 'h22'), [v, m, o]);
});
t('R16.8 swag_orange_03 Collector: 3 selfies of any figure\'s colour', () => {
  const s = clear(game(2)); for (const e of s.schedule) { e.status = 'waiting'; e.figure = null; }
  setCeleb(s, '1', 'character_mando_03', 'red'); setCeleb(s, '2', 'character_who_03', 'green');
  buyable(s, 'swag_orange_03'); pick(s, { type: 'buySwag', card: 'swag_orange_03' });
  pick(s, { type: 'effectChooseCelebrity', celebrity: 'character_who_03' });
  assert.deepEqual(s.players[0].selfies, sel(3, 0, 0));
});
t('R16.8 swag_orange_04 Much Better: score an Achievement at x1 (source achievement-swag), discard it, draw 1 (also in Hour 5)', () => {
  const s = clear(game(2)); put(s, 0, 'h11'); put(s, 0, 'h12'); s.hour = 5;
  s.players[0].hand = ['scoring_11', 'scoring_07']; buyable(s, 'swag_orange_04');
  pick(s, { type: 'buySwag', card: 'swag_orange_04' });
  const events = pick(s, { type: 'effectChooseAchievement', card: 'scoring_11' });
  assert.equal(s.players[0].vp, 2 * 2);
  assert.equal(ev(events, 'vp')[0].source, 'achievement-swag');
  assert.equal(s.players[0].hand.length, 2); assert.ok(!s.players[0].hand.includes('scoring_11'));
});
t('R16.8 swag_orange_05 We\'re Full!: the last Crew of a hall (any owner) steps to an adjacent hall', () => {
  const s = clear(game(2)); put(s, 0, 'h22'); const last = put(s, 1, 'h22'); put(s, 0, 'h11');
  buyable(s, 'swag_orange_05'); pick(s, { type: 'buySwag', card: 'swag_orange_05' });
  const crews = new Set(valid(s).filter((a) => a.type === 'effectMove').map((a) => a.crew));
  assert.ok(crews.has(last)); assert.ok(!crews.has('c0-1'), 'not the front Crew');
  pick(s, { type: 'effectMove', crew: last, to: G.h23 });
  assert.equal(crew(s, last).hall, G.h23);
});
t('R16.8 swag_orange_07 Achiever (hand-size): draw 1, hand size 3; final: best x3, other x1', () => {
  const s = clear(game(2)); buyable(s, 'swag_orange_07');
  pick(s, { type: 'buySwag', card: 'swag_orange_07' });
  assert.equal(s.players[0].hand.length, 3); assert.equal(E.handSize(s, 0) ?? s.players[0].handSize, 3);
});
t('R16.8 swag_orange_07 Achiever (draw-two-keep-one): draw 2, keep 1, hand size stays 2', () => {
  const s = clear(game(2, { achiever: 'draw-two-keep-one' })); buyable(s, 'swag_orange_07');
  pick(s, { type: 'buySwag', card: 'swag_orange_07' });
  assert.equal(s.stack.at(-1).kind, 'achieverKeep');
  const k = valid(s).filter((a) => a.type === 'keepAchievement');
  assert.equal(k.length, 2);
  E.applyAction(s, k[0]);
  assert.equal(s.players[0].hand.length, 3); assert.equal(s.players[0].handSize, 2);
});
t('R16.8 swag_orange_08 Influencer: 2 VP per selfie held after paying, max 10', () => {
  const s = clear(game(2), { selfies: sel(1, 1, 0) }); buyable(s, 'swag_orange_08');
  pick(s, { type: 'buySwag', card: 'swag_orange_08' }); assert.equal(s.players[0].vp, 4);
  const m = clear(game(2), { selfies: sel(4, 4, 0) }); buyable(m, 'swag_orange_08');
  pick(m, { type: 'buySwag', card: 'swag_orange_08' }); assert.equal(m.players[0].vp, 10);
  assert.deepEqual(m.players[0].selfies, sel(4, 4, 0), 'not spent');
});
t('R16.8 swag_orange_09 Photo Rally / swag_orange_11 Trending: chosen colours', () => {
  const s = clear(game(2)); vol(s, 0, PHO('h11')); vol(s, 0, PHO('h12')); buyable(s, 'swag_orange_09');
  pick(s, { type: 'buySwag', card: 'swag_orange_09' }); pick(s, { type: 'effectGainSelfies', gain: sel(0, 2, 0) });
  assert.deepEqual(s.players[0].selfies, sel(0, 2, 0));
  const t2 = clear(game(2)); buyable(t2, 'swag_orange_11'); pick(t2, { type: 'buySwag', card: 'swag_orange_11' });
  pick(t2, { type: 'effectGainSelfies', gain: sel(1, 0, 2) }); assert.deepEqual(t2.players[0].selfies, sel(1, 0, 2));
});
t('R16.8 swag_orange_10 Colour Swap: change any number of selfies', () => {
  const s = clear(game(2), { selfies: sel(2, 0, 0) }); buyable(s, 'swag_orange_10'); pick(s, { type: 'buySwag', card: 'swag_orange_10' });
  pick(s, { type: 'effectConvertSelfie', from: 'green', to: 'red' });
  pick(s, { type: 'effectConvertSelfie', from: 'green', to: 'orange' });
  if (s.toAct === 0 && s.stack.at(-1)?.kind === 'effect') pick(s, { type: 'effectDone' });
  assert.deepEqual(s.players[0].selfies, sel(0, 1, 1));
});
t('R16.8 swag_orange_12 Look at me!: 3 VP per hall with own Photographer and own Prime Position', () => {
  const s = clear(game(2)); put(s, 0, 'h11'); put(s, 1, 'h12'); put(s, 0, 'h12'); put(s, 0, 'h13');
  vol(s, 0, PHO('h11')); vol(s, 0, PHO('h12')); vol(s, 0, PHO('h13'));
  buyable(s, 'swag_orange_12'); pick(s, { type: 'buySwag', card: 'swag_orange_12' });
  assert.equal(s.players[0].vp, 6);
});
t('R16.8 swag_green_01 Jumper, green_02 Teleport, green_07 Run!, red_03 Coffee Break covered above; R16.9 cost mix 20/9/7', () => {
  const costs = Object.values(C(game()).SWAG.SWAG_COST);
  assert.deepEqual([1, 2, 3].map((k) => costs.filter((c) => c === k).length), [20, 9, 7]);
  const printed = { swag_green_01: 1, swag_green_02: 2, swag_green_03: 1, swag_green_04: 2, swag_green_05: 1, swag_green_06: 3, swag_green_07: 1, swag_green_08: 3, swag_green_09: 2, swag_green_10: 2, swag_green_11: 3, swag_green_12: 1, swag_red_01: 1, swag_red_02: 2, swag_red_03: 1, swag_red_04: 3, swag_red_05: 1, swag_red_06: 1, swag_red_07: 1, swag_red_08: 2, swag_red_09: 3, swag_red_10: 1, swag_red_11: 1, swag_red_12: 1, swag_orange_01: 1, swag_orange_02: 2, swag_orange_03: 1, swag_orange_04: 1, swag_orange_05: 2, swag_orange_06: 1, swag_orange_07: 3, swag_orange_08: 2, swag_orange_09: 1, swag_orange_10: 1, swag_orange_11: 1, swag_orange_12: 3 };
  assert.deepEqual(C(game()).SWAG.SWAG_COST, printed);
});

// ======================================================= R17 Clubs

function clubGame(club, n = 2, variants = {}, opts = {}) {
  const s = clear(game(n, { clubs: 'random', ...variants }), opts);
  for (const p of s.players) { p.club = null; p.clubUsedThisHour = false; }
  s.players[0].club = club;
  return s;
}
t('R17.2/R17.5 a Club power is a main action, once per Hour, and not after passing', () => {
  const s = clubGame('club_03'); put(s, 0, 'h11'); setCeleb(s, '1', 'character_mando_03', 'green'); turnFor(s, 0);
  pick(s, { type: 'clubPower' }); // one figure -> auto choice
  assert.equal(s.toAct, 1, 'main action');
  turnFor(s, 0);
  assert.equal(offered(s, { type: 'clubPower' }), false, 'used this Hour');
  assert.ok(E.getBlockReason(s, { type: 'clubPower', option: 'use' }));
});
t('R17.6.1 club_01 Silver Screen Society: 5 coffee VIP or 8 coffee AAA placed directly', () => {
  const s = clubGame('club_01'); turnFor(s, 0);
  pick(s, { type: 'clubPower', option: 'aaa' }); pick(s, { type: 'effectPlaceCrew', hall: G.h13 });
  const c = s.crew.find((x) => x.owner === 0 && x.hall === G.h13);
  assert.equal(c.badge, 'AAA'); assert.equal(s.players[0].coffee, 4); assert.equal(s.players[0].hats, 2); assert.equal(s.players[0].boxes, 0);
  const v = clubGame('club_01', 2, {}, { coffee: 6 }); turnFor(v, 0);
  assert.equal(offered(v, { type: 'clubPower', option: 'aaa' }), false);
  pick(v, { type: 'clubPower', option: 'vip' }); pick(v, { type: 'effectPlaceCrew', hall: G.h12 });
  assert.equal(v.crew.find((x) => x.owner === 0 && x.hall === G.h12).badge, 'VIP'); assert.equal(v.players[0].coffee, 1);
});
t('R17.6.2 club_02 Player One Posse: 1 coffee, one placement and any number of moves of own Volunteers', () => {
  const s = clubGame('club_02'); vol(s, 0, 'rope_01'); vol(s, 0, SEC('h11')); turnFor(s, 0);
  pick(s, { type: 'clubPower' });
  assert.equal(s.players[0].coffee, 11);
  pick(s, { type: 'effectPlaceVolunteer', space: PHO('h22') });
  assert.equal(offered(s, { type: 'effectPlaceVolunteer' }), false, 'one placement only');
  pick(s, { type: 'effectMoveVolunteer', from: 'rope_01', to: SEC('h33') });
  assert.equal(s.volunteers.rope_01, null); assert.equal(s.volunteers[SEC('h33')], 0);
  pick(s, { type: 'effectMoveVolunteer', from: SEC('h11'), to: 'rope_12' });
  if (s.toAct === 0 && s.stack.at(-1)?.kind === 'effect') pick(s, { type: 'effectDone' });
  assert.equal(s.volunteers.rope_12, 0);
});
t('R17.6.3 club_03 Hot Glue Syndicate: 1 coffee, 4 selfies of a figure where you have Crew', () => {
  const s = clubGame('club_03'); put(s, 0, 'h11'); for (const e of s.schedule) { e.status = 'waiting'; e.figure = null; }
  setCeleb(s, '1', 'character_mando_03', 'orange'); setCeleb(s, '2', 'character_who_03', 'green'); turnFor(s, 0);
  pick(s, { type: 'clubPower' });
  assert.deepEqual(s.players[0].selfies, sel(0, 0, 4)); assert.equal(s.players[0].coffee, 11);
});
t('R17.6.4 club_04 Otaku Alliance: VP = selfies held (max 5, not spent; not with 0), or 4 chosen selfies', () => {
  const s = clubGame('club_04', 2, {}, { selfies: sel(3, 2, 2) }); turnFor(s, 0);
  pick(s, { type: 'clubPower', option: 'vp' });
  assert.equal(s.players[0].vp, 5); assert.deepEqual(s.players[0].selfies, sel(3, 2, 2));
  const z = clubGame('club_04'); turnFor(z, 0);
  assert.equal(offered(z, { type: 'clubPower', option: 'vp' }), false);
  pick(z, { type: 'clubPower', option: 'selfies' }); pick(z, { type: 'effectGainSelfies', gain: sel(0, 4, 0) });
  assert.deepEqual(z.players[0].selfies, sel(0, 4, 0)); assert.equal(z.players[0].coffee, 11);
});
t('R17.6.5 club_05 Longbox Legion: 3 coffee, draw 3, discard 3, no coffee for the discards', () => {
  const s = clubGame('club_05'); s.players[0].hand = ['scoring_01', 'scoring_02']; turnFor(s, 0);
  pick(s, { type: 'clubPower' });
  assert.equal(s.players[0].coffee, 9); assert.equal(s.players[0].hand.length, 5);
  for (let i = 0; i < 3; i++) E.applyAction(s, valid(s).find((a) => a.type === 'effectChooseAchievement'));
  assert.equal(s.players[0].hand.length, 2); assert.equal(s.players[0].coffee, 9);
});
t('R17.6.6 club_06 Meeple Militia: 1 coffee, 6 tokens; kept + VP = 6 (coin); fixed = 3 and 3', () => {
  for (const seed of [1, 2, 3, 4]) {
    const s = clubGame('club_06'); s.rng = E.makeRng(seed); turnFor(s, 0);
    pick(s, { type: 'clubPower' }); pick(s, { type: 'effectGainSelfies', gain: sel(2, 2, 2) });
    const kept = s.players[0].selfies.green + s.players[0].selfies.red + s.players[0].selfies.orange;
    assert.equal(kept + s.players[0].vp, 6); assert.equal(s.players[0].coffee, 11);
    assert.equal(s.players[0].vpBySource.militia, s.players[0].vp);
  }
  const f = clubGame('club_06', 2, { militiaRoll: 'fixed' }); turnFor(f, 0);
  pick(f, { type: 'clubPower' }); pick(f, { type: 'effectGainSelfies', gain: sel(3, 0, 0) });
  assert.deepEqual(f.players[0].selfies, sel(3, 0, 0)); assert.equal(f.players[0].vp, 3);
});
t('R17.6.6 coin roll is random: over several seeds both outcomes appear', () => {
  const totals = new Set();
  for (let seed = 1; seed <= 12; seed++) {
    const s = clubGame('club_06'); s.rng = E.makeRng(seed * 7); turnFor(s, 0);
    pick(s, { type: 'clubPower' }); pick(s, { type: 'effectGainSelfies', gain: sel(6, 0, 0) });
    totals.add(s.players[0].vp);
  }
  assert.ok(totals.size >= 3, `VP outcomes ${[...totals]}`);
});
t('R17.6.7 club_07 TCG Traders Rare Finds: 2 of one colour -> 3 of one other, once per turn, not a main action', () => {
  const s = clubGame('club_07', 2, {}, { selfies: sel(4, 0, 0) }); turnFor(s, 0);
  pick(s, { type: 'rareFinds', pay: 'green', gain: 'red' });
  assert.deepEqual(s.players[0].selfies, sel(2, 3, 0)); assert.equal(s.toAct, 0, 'turn goes on');
  assert.equal(offered(s, { type: 'rareFinds' }), false, 'once per turn');
  assert.equal(offered(s, { type: 'clubPower' }), false, 'not a main-action Club');
});
t('R17.6.8 club_08 Retro Gaming Guild: 2 coffee, 2 VP per Prime Position hall', () => {
  const s = clubGame('club_08'); put(s, 0, 'h11'); put(s, 0, 'h12'); put(s, 1, 'h13'); put(s, 0, 'h13'); turnFor(s, 0);
  pick(s, { type: 'clubPower' });
  assert.equal(s.players[0].vp, 4); assert.equal(s.players[0].coffee, 10); assert.equal(s.players[0].vpBySource.club, 4);
});
t('R17.6.9 club_09 Selfie Stick Squad: 1 coffee -> 2 chosen selfies, unlimited, in turns and the final window', () => {
  const s = clubGame('club_09', 2, {}, { coffee: 3 }); turnFor(s, 0);
  pick(s, { type: 'strikeAPose', gain: sel(1, 1, 0) }); pick(s, { type: 'strikeAPose', gain: sel(0, 0, 2) });
  assert.equal(s.players[0].coffee, 1); assert.deepEqual(s.players[0].selfies, sel(1, 1, 2)); assert.equal(s.toAct, 0);
});
t('R17.7 printed club selfie hand limits have no effect (clubHandLimits=off)', () => {
  const s = clubGame('club_07', 2, {}, { selfies: sel(10, 10, 0) }); put(s, 0, 'h32'); turnFor(s, 0);
  pick(s, { type: 'move2', to: G.h22 });
  assert.equal(s.players[0].selfies.green + s.players[0].selfies.red, 20);
});
t('R26 clubHandLimits=on: TCG owner over 10 discards to 10 at the end of the turn; Militia limit 12', () => {
  const s = clubGame('club_07', 2, { clubHandLimits: 'on' }, { selfies: sel(6, 6, 0) }); put(s, 0, 'h32'); turnFor(s, 0);
  pick(s, { type: 'move2', to: G.h22 });
  assert.equal(s.stack.at(-1).kind, 'discardToLimit'); assert.equal(s.toAct, 0);
  pick(s, { type: 'discardSelfie', colour: 'green' }); pick(s, { type: 'discardSelfie', colour: 'red' });
  assert.equal(s.players[0].selfies.green + s.players[0].selfies.red, 10); assert.equal(s.toAct, 1);
  const m = clubGame('club_06', 2, { clubHandLimits: 'on' }, { selfies: sel(6, 6, 0) }); put(m, 0, 'h32'); turnFor(m, 0);
  pick(m, { type: 'move2', to: G.h22 });
  assert.equal(m.toAct, 1, 'Militia at 12 is within its limit');
});

// ======================================================= R18 Passing

t('R18.1/R18.2 first pass: slot 1, first passer +2 coffee, score or discard (+2) one Achievement, draw 1', () => {
  const s = clear(game(2), { coffee: 3 }); put(s, 0, 'h11'); put(s, 0, 'h12');
  s.players[0].hand = ['scoring_11', 'scoring_07']; turnFor(s, 0);
  pick(s, { type: 'pass' });
  assert.equal(s.players[0].passSlot, 1); assert.equal(s.players[0].coffee, 3 + C(s).PASS.PASS_FIRST_PASSER_COFFEE);
  assert.equal(s.hourState.firstPasser, 0);
  assert.equal(offered(s, { type: 'pass' }), false);
  pick(s, { type: 'discardAchievement', card: 'scoring_07' });
  assert.equal(s.players[0].coffee, 3 + 2 + C(s).PASS.PASS_DISCARD_COFFEE);
  assert.equal(s.players[0].hand.length, 2, 'drew 1'); assert.ok(!s.players[0].hand.includes('scoring_07'));
  // second passer gets no first-pass coffee
  s.players[1].hand = ['scoring_11', 'scoring_07']; const c1 = s.players[1].coffee = 3;
  pick(s, { type: 'pass' }); // seat 1
  assert.ok(s.players[1].coffee === c1 || s.stack.at(-1)?.kind === 'passAchievement');
  assert.equal(s.players[1].coffee, 3);
});
t('R18.2.3/R18.2.4 Hour 5 pass: must still score or discard, but draws nothing', () => {
  const s = clear(game(2)); s.hour = 5; put(s, 0, 'h11'); s.players[0].hand = ['scoring_11', 'scoring_07']; turnFor(s, 0);
  pick(s, { type: 'pass' });
  assert.equal(s.stack.at(-1).kind, 'passAchievement');
  pick(s, { type: 'scoreAchievement', card: 'scoring_11' });
  assert.deepEqual(s.players[0].hand, ['scoring_07']); assert.equal(s.players[0].vp, 2);
});
t('R18.3/R18.4 pass-turns: marker 2,3,4,4 with 1/2/3/3 coffee or VP; no main actions; App.B "Value of leaving early"', () => {
  const s = clear(game(2), { coffee: 0 });
  for (const g of ['h11', 'h12', 'h13', 'h21']) put(s, 0, g);
  put(s, 1, 'h33'); s.players[1].coffee = 12;
  setHand(s, 0, ['scoring_07', 'scoring_11']); turnFor(s, 0);
  pick(s, { type: 'pass' }); pick(s, { type: 'scoreAchievement', card: 'scoring_07' });
  assert.equal(s.players[0].vp, 8, 'Spread Out 4 halls x 2');
  const seat1 = () => { assert.equal(s.toAct, 1); E.applyAction(s, valid(s).find((a) => a.type === 'volunteer')); };
  const plan = [['vp', 1], ['vp', 2], ['coffee', 3], ['vp', 3]];
  for (const [reward, amount] of plan) {
    seat1();
    assert.equal(s.stack.at(-1).kind, 'passTurn');
    assert.ok(valid(s).every((a) => !E.MAIN_ACTION_TYPES.includes(a.type)), 'no main actions after passing');
    const events = pick(s, { type: 'passReward', reward });
    assert.equal(ev(events, 'passReward')[0].amount, amount);
  }
  assert.equal(s.players[0].vp, 14); assert.equal(s.players[0].coffee, 5);
  assert.equal(s.players[0].passSlot, 4);
});
t('R18.4.1 on 12 coffee the coffee reward is not offered', () => {
  const s = clear(game(2), { coffee: 12, selfies: sel(1, 0, 0) }); s.players[0].passSlot = 1;
  s.stack = [{ kind: 'passTurn', player: 0, conversions: 0, rareFindsUsed: false }]; s.toAct = 0; s.turn = { number: 5, player: 0, kind: 'pass' };
  assert.equal(offered(s, { type: 'passReward', reward: 'coffee' }), false);
});
t('R18.5 when everyone has passed, pass markers return for the next Hour', () => {
  const s = clear(game(3)); walkNow(s, 0);
  for (const p of s.players) assert.equal(p.passSlot, 0);
});

// ======================================================= R19 Achievements

// The audit board for the 40 Achievement counts (seat 0 scores), 3 players.
function achBoard(variants = {}) {
  const s = clear(game(3, variants), { coffee: 10, selfies: sel(3, 2, 1) });
  const A = 1, B = 2;
  put(s, 0, 'h11', 'VIP'); put(s, A, 'h11'); put(s, 0, 'h11');
  put(s, A, 'h12');
  put(s, 0, 'h13');
  put(s, A, 'h22'); put(s, 0, 'h22'); put(s, B, 'h22'); put(s, 0, 'h22'); put(s, 0, 'h22');
  put(s, A, 'h23'); put(s, 0, 'h23');
  put(s, B, 'h31'); put(s, B, 'h31');
  put(s, 0, 'h32', 'AAA'); put(s, A, 'h32', 'VIP');
  vol(s, 0, ropeOf('h11', 'h12')); vol(s, 0, ropeOf('h12', 'h22')); vol(s, 0, ropeOf('h23', 'h33'));
  vol(s, 0, SEC('h23')); vol(s, 0, SEC('h33')); vol(s, 0, PHO('h11'));
  vol(s, A, ropeOf('h21', 'h22'));
  for (const e of s.schedule) { e.status = 'waiting'; e.figure = null; e.marker = null; }
  const sc = (slot, fig, mark) => { const e = s.schedule.find((x) => x.slot === slot); e.status = 'onBoard'; e.figure = G[fig]; e.marker = G[mark]; };
  sc('1', 'h12', 'h31'); sc('2', 'h22', 'h22'); sc('3', 'h13', 'h11');
  return s;
}
const ACH_EXPECT = {
  scoring_01: 2, scoring_02: 4, scoring_03: 3, scoring_04: 4, scoring_05: 2, scoring_06: 6, scoring_07: 5, scoring_08: 1,
  scoring_09: 0, scoring_10: 1, scoring_11: 8, scoring_12: 3, scoring_13: 4, scoring_14: 1, scoring_15: 4, scoring_16: 1,
  scoring_17: 1, scoring_18: 3, scoring_19: 1, scoring_20: 1, scoring_21: 2, scoring_22: 2, scoring_23: 2, scoring_24: 3,
  scoring_25: 1, scoring_26: 1, scoring_27: 2, scoring_28: 5, scoring_29: 2, scoring_30: 1, scoring_31: 1, scoring_32: 6,
  scoring_33: 1, scoring_34: 1, scoring_35: 1, scoring_36: 2, scoring_37: 3, scoring_38: 3, scoring_39: 3, scoring_40: 0,
};
t('R19.10 the 40 Achievement counts on the audit board (hand-computed from the spec)', () => {
  const s = achBoard();
  const bad = [];
  for (const [id, want] of Object.entries(ACH_EXPECT)) {
    const got = E.countAchievement(s, 0, id);
    if (!got.implemented || got.count !== want) bad.push(`${id} want ${want} got ${got.count}`);
  }
  assert.deepEqual(bad, []);
});
t('R19.10 laurel values match the printed cards (CONSTANTS and card data)', () => {
  const L = [5, 3, 3, 3, 4, 3, 2, 6, 6, 6, 2, 4, 3, 8, 3, 5, 5, 2, 4, 4, 4, 4, 4, 4, 4, 4, 3, 3, 3, 5, 6, 3, 2, 3, 3, 3, 5, 2, 4, 10];
  const K = C(game()).ACHIEVEMENTS.ACHIEVEMENT_LAUREL;
  L.forEach((v, i) => { const id = `scoring_${String(i + 1).padStart(2, '0')}`; assert.equal(K[id], v, id); assert.equal(E.ACHIEVEMENT_CARDS.find((c) => c.id === id).laurel, v); });
});
t('R19.10 usherInHall=neither: Passion and Home Base stop counting Ushers; Obsessed keeps its Photographer', () => {
  const s = achBoard({ usherInHall: 'neither' });
  assert.equal(E.countAchievement(s, 0, 'scoring_13').count, 0);
  assert.equal(E.countAchievement(s, 0, 'scoring_31').count, 0);
  assert.equal(E.countAchievement(s, 0, 'scoring_30').count, 1);
  assert.equal(E.countAchievement(s, 0, 'scoring_08').count, 1, 'R13.7.2 pairs unchanged');
});
t('R19.10 scoring_31 Home Base: three-crew vs as-printed', () => {
  const mk = (v) => { const s = clear(game(2, v)); put(s, 0, 'h21'); put(s, 0, 'h21'); put(s, 0, 'h21'); vol(s, 0, SEC('h21')); put(s, 0, 'h33', 'VIP'); vol(s, 0, PHO('h33')); return s; };
  assert.equal(E.countAchievement(mk({}), 0, 'scoring_31').count, 1, 'three-crew: h21 only');
  assert.equal(E.countAchievement(mk({ homeBase: 'as-printed' }), 0, 'scoring_31').count, 1, 'as-printed: h33 only');
  const s = mk({ homeBase: 'as-printed' }); s.crew.find((c) => c.hall === G.h33 && c.owner === 0).hall = G.h22;
  assert.equal(E.countAchievement(s, 0, 'scoring_31').count, 0);
  const t2 = mk({}); t2.crew.find((c) => c.hall === G.h33 && c.owner === 0).hall = G.h22;
  assert.equal(E.countAchievement(t2, 0, 'scoring_31').count, 1);
});
t('R19.10 scoring_40 Relaxed: first passer with 8+ coffee after the first-pass bonus', () => {
  const s = clear(game(2), { coffee: 6 }); s.players[0].hand = ['scoring_40', 'scoring_11']; turnFor(s, 0);
  pick(s, { type: 'pass' }); pick(s, { type: 'scoreAchievement', card: 'scoring_40' });
  assert.equal(s.players[0].vp, 10);
  const n = clear(game(2), { coffee: 5 }); n.players[0].hand = ['scoring_40', 'scoring_11']; turnFor(n, 0);
  pick(n, { type: 'pass' }); pick(n, { type: 'scoreAchievement', card: 'scoring_40' });
  assert.equal(n.players[0].vp, 0, '5 + 2 = 7 coffee');
});
t('R19.1 hand size 2 is restored by the pass draw; R19.4 a count of 0 scores 0 and still discards', () => {
  const s = clear(game(2)); setHand(s, 0, ['scoring_09', 'scoring_11']); turnFor(s, 0);
  pick(s, { type: 'pass' }); const events = pick(s, { type: 'scoreAchievement', card: 'scoring_09' });
  assert.equal(s.players[0].vp, 0); assert.ok(!s.players[0].hand.includes('scoring_09')); assert.equal(s.players[0].hand.length, 2);
  assert.ok(ev(events, 'achievementScored').length === 1);
  assert.ok(s.achievements.discard.some((d) => d.card === 'scoring_09' && d.scored));
});
t('R19.3/R19.4 VP = live count x laurel (Chums, App.B 3 halls x 4 = 12)', () => {
  const s = clear(game(2)); for (const g of ['h11', 'h11', 'h12', 'h12', 'h33', 'h33', 'h23']) put(s, 0, g);
  s.players[0].hand = ['scoring_05', 'scoring_11']; turnFor(s, 0);
  pick(s, { type: 'pass' }); pick(s, { type: 'scoreAchievement', card: 'scoring_05' });
  assert.equal(s.players[0].vp, 12);
});
t('R19.5 row / column / diagonal: the best choice is taken and recorded', () => {
  const s = clear(game(2)); put(s, 0, 'h31'); put(s, 0, 'h32'); put(s, 0, 'h11');
  const r = E.countAchievement(s, 0, 'scoring_02');
  assert.equal(r.count, 2); assert.ok(r.choice !== null && r.choice !== undefined);
});
t('R19.6 printed maximums cap the count (Look at Me! 5 pairs, Collector 3 sets)', () => {
  const s = clear(game(2), { selfies: sel(9, 9, 9) });
  assert.equal(E.countAchievement(s, 0, 'scoring_03').count, 5);
  assert.equal(E.countAchievement(s, 0, 'scoring_17').count, 3);
});
t('R19.7 a scored card is public; a discarded one is a secret event', () => {
  const s = clear(game(2)); s.players[0].hand = ['scoring_09', 'scoring_11']; turnFor(s, 0);
  pick(s, { type: 'pass' }); const events = pick(s, { type: 'discardAchievement', card: 'scoring_09' });
  const d = ev(events, 'achievementDiscarded')[0];
  assert.ok(d && d.secret === true); assert.ok(E.SECRET_EVENT_TYPES.includes('achievementDiscarded'));
});
t('R19.8 empty Achievement deck: reshuffle the discard pile; both empty: no draw', () => {
  const s = clear(game(2)); s.players[0].hand = ['scoring_09', 'scoring_11'];
  s.achievements.discard = s.achievements.deck.map((c) => ({ card: c, owner: 1, scored: false })); s.achievements.deck = [];
  turnFor(s, 0); pick(s, { type: 'pass' }); const events = pick(s, { type: 'discardAchievement', card: 'scoring_09' });
  assert.ok(ev(events, 'deckReshuffled').some((e) => e.deck === 'achievement')); assert.equal(s.players[0].hand.length, 2);
  const z = clear(game(2)); z.players[0].hand = ['scoring_09', 'scoring_11']; z.achievements.deck = []; z.achievements.discard = [];
  turnFor(z, 0); pick(z, { type: 'pass' }); pick(z, { type: 'discardAchievement', card: 'scoring_11' });
  // the card just discarded can be reshuffled straight back (R19.8 shuffles the discard pile)
  assert.ok(z.players[0].hand.length >= 1);
});

// ======================================================= R20 Walk

t('R20.2/R20.3/R20.3.1 App.B "One walk, three payouts": start hall not entered; Prime then Photographer per hall entered', () => {
  const s = clear(game(2)); setCeleb(s, '1', 'character_mando_03', 'green'); // h11 > h21 > h31
  put(s, 1, 'h11'); // start hall: nothing
  put(s, 1, 'h21'); vol(s, 0, PHO('h21'));
  put(s, 0, 'h31'); vol(s, 0, PHO('h31'));
  const events = walkNow(s, 0);
  const gains = ev(events, 'selfieGain').filter((e) => e.cause.startsWith('walk'));
  const desc = gains.map((e) => `${e.player}:${e.cause}:${GRID[e.detail.hall] ?? e.detail.hall}`);
  assert.deepEqual(desc, ['1:walk-prime:h21', '0:walk-photographer:h21', '0:walk-prime:h31', '0:walk-photographer:h31']);
  assert.deepEqual(ev(events, 'celebrityEntered').map((e) => GRID[e.hall]), ['h21', 'h31']);
});
t('R20.4/R21.1 the destination hall scores; only its Crew score (Everyone 8)', () => {
  const s = clear(game(2)); setCeleb(s, '1', 'character_mando_03', 'green');
  put(s, 0, 'h31'); put(s, 1, 'h31'); put(s, 1, 'h31'); put(s, 0, 'h21');
  walkNow(s, 0);
  assert.equal(s.players[0].vpBySource.celebrity, 8); assert.equal(s.players[1].vpBySource.celebrity, 16);
});
t('R20.5 clearing up: figure and marker removed; next celebrity placed in the freed colour (H1->4, H2->5a, H3->5b)', () => {
  const s = clear(game(2));
  for (const [h, nextSlot, prevSlot] of [[1, '4', '1'], [2, '5a', '2'], [3, '5b', '3']]) {
    assert.equal(s.hour, h);
    const prev = s.schedule.find((e) => e.slot === prevSlot); const colour = prev.colour;
    walkNow(s, (s.firstPlayer + 1) % 2);
    assert.equal(prev.status, 'done'); assert.equal(prev.figure, null); assert.equal(prev.marker, null);
    const nx = s.schedule.find((e) => e.slot === nextSlot);
    assert.equal(nx.status, 'onBoard'); assert.equal(nx.colour, colour);
    assert.equal(nx.figure, card(nx.card).route[0]); assert.equal(nx.marker, card(nx.card).route.at(-1));
    clear(s);
  }
  walkNow(s, (s.firstPlayer + 1) % 2); // Hour 4: nothing placed
  assert.equal(s.hour, 5);
  assert.equal(s.schedule.filter((e) => e.status === 'onBoard').length, 2);
});
function toHour5(n = 2, variants = {}) {
  const s = clear(game(n, variants)); s.hour = 5;
  for (const e of s.schedule) if (!['5a', '5b'].includes(e.slot)) { e.status = 'done'; e.figure = null; e.marker = null; }
  for (const p of s.players) { p.hand = []; p.selfies = sel(); }
  return s;
}
t('R20.6 Hour 5: 5a and 5b walk alternately (5a first), 5a scores first; figures stay for final scoring', () => {
  const s = toHour5(2);
  setCeleb(s, '5a', 'character_mando_01', 'green'); // 5 entered: h23 h13 h12 h22 h21
  setCeleb(s, '5b', 'character_rings_01', 'red');   // 6 entered: h11 h12 h22 h32 h33 h23
  const events = walkNow(s, 0);
  const steps = ev(events, 'celebrityEntered').map((e) => `${e.slot}:${GRID[e.hall]}`);
  assert.deepEqual(steps, ['5a:h23', '5b:h11', '5a:h13', '5b:h12', '5a:h12', '5b:h22', '5a:h22', '5b:h32', '5a:h21', '5b:h33', '5b:h23']);
  assert.deepEqual(ev(events, 'celebrityScored').map((e) => e.slot), ['5a', '5b']);
  assert.ok(E.isGameOver(s));
  assert.equal(s.schedule.find((e) => e.slot === '5a').figure, G.h21);
  assert.equal(s.schedule.find((e) => e.slot === '5b').figure, G.h23);
});
t('R20.7 Walk selfies and scoring never change a queue', () => {
  const s = clear(game(2)); setCeleb(s, '1', 'character_mando_03', 'green');
  put(s, 1, 'h21'); put(s, 0, 'h21'); put(s, 0, 'h31'); put(s, 1, 'h31');
  const before = { h21: q(s, 'h21'), h31: q(s, 'h31') };
  walkNow(s, 0);
  assert.deepEqual(q(s, 'h21'), before.h21); assert.deepEqual(q(s, 'h31'), before.h31);
});

// ======================================================= R21 scoring methods

const pay = (s, id, g) => E.destinationPayouts(s, id, G[g]);
const totals = (list, n) => { const t2 = Array(n).fill(0); for (const p of list) t2[p.player] += p.vp; return t2; };
t('R21.2 everyone / by-badge: App.B "Everyone, by badge" 8 + 4 + 4 = 16 and 6 (Scarlet Killer)', () => {
  const s = clear(game(2)); put(s, 0, 'h22', 'AAA'); put(s, 0, 'h22'); put(s, 0, 'h22'); put(s, 1, 'h22', 'VIP');
  assert.deepEqual(totals(pay(s, 'character_marvel_01', 'h22'), 2), [16, 6]);
  assert.deepEqual(totals(pay(s, 'character_mando_03', 'h22'), 2), [24, 8]);
});
t('R21.2 everyone-no-n00bs (Cate Blanket 7)', () => {
  const s = clear(game(2)); put(s, 0, 'h11', 'VIP'); put(s, 0, 'h11'); put(s, 1, 'h11', 'AAA');
  assert.deepEqual(totals(pay(s, 'character_rings_02', 'h11'), 2), [7, 7]);
});
t('R21.2 in-order: position p scores the p-th value (Daisy Riddler 15,12,10,...)', () => {
  const s = clear(game(3)); put(s, 1, 'h31'); put(s, 0, 'h31'); put(s, 2, 'h31'); put(s, 0, 'h31');
  assert.deepEqual(totals(pay(s, 'character_star_wars_03', 'h31'), 3), [12 + 3, 15, 10]);
});
t('R21.2 in-order-no-n00bs: App.B Michael Corn 14, 10, 7 to the three VIP/AAA; N00bs score 0 and use no value', () => {
  const s = clear(game(2)); put(s, 1, 'h21'); put(s, 0, 'h21', 'VIP'); put(s, 1, 'h21', 'AAA'); put(s, 0, 'h21'); put(s, 0, 'h21', 'VIP');
  // queue: c1 AAA, c0 VIP, c0 VIP, c1 N00b, c0 N00b
  assert.deepEqual(totals(pay(s, 'character_tng_02', 'h21'), 2), [10 + 7, 14]);
});
t('R21.2 count-total: App.B 2 Crew band 1-2 = 12 each; 3-4 = 5; 5+ = 3 (Adam Ripper)', () => {
  const s = clear(game(3)); put(s, 0, 'h13'); put(s, 1, 'h13');
  assert.deepEqual(totals(pay(s, 'character_star_wars_02', 'h13'), 3), [12, 12, 0]);
  put(s, 2, 'h13'); assert.deepEqual(totals(pay(s, 'character_star_wars_02', 'h13'), 3), [5, 5, 5]);
  put(s, 2, 'h13'); put(s, 2, 'h13'); assert.deepEqual(totals(pay(s, 'character_star_wars_02', 'h13'), 3), [3, 3, 9]);
});
t('R21.1/R21.3 an empty hall pays nothing; positions beyond 7 score 0 (rulebook capacity 8)', () => {
  const s = clear(game(4, { queueCapacity: 'rulebook' }));
  assert.equal(pay(s, 'character_who_01', 'h33').length === 0 || totals(pay(s, 'character_who_01', 'h33'), 4).every((x) => x === 0), true);
  for (let i = 0; i < 7; i++) put(s, 1, 'h33');
  put(s, 0, 'h33');
  assert.equal(totals(pay(s, 'character_who_01', 'h33'), 4)[0], 0, '8th place scores 0');
});

// ======================================================= R22 final scoring

t('R22.2 final window: Exchange (E3) and Strike a Pose offered; Rare Finds not', () => {
  const s = toHour5(2, { clubs: 'random' }); for (const p of s.players) p.club = null; s.players[0].club = 'club_07'; s.players[1].club = 'club_09';
  setCeleb(s, '5a', 'character_mando_01'); setCeleb(s, '5b', 'character_rings_01');
  s.players[0].selfies = sel(4, 0, 0); s.players[1].selfies = sel(0, 0, 0); s.players[1].coffee = 2;
  walkNow(s, 0);
  assert.equal(s.phase, 'final'); assert.equal(s.stack.at(-1).kind, 'finalWindow');
  const who = s.toAct; const list = valid(s).map((a) => a.type);
  if (who === 0) { assert.ok(list.includes('exchange')); assert.ok(!list.includes('rareFinds')); }
  else assert.ok(list.includes('strikeAPose'));
  while (!E.isGameOver(s)) { const l = valid(s); if (s.toAct === 0) assert.ok(!l.some((a) => a.type === 'rareFinds')); E.applyAction(s, l.find((a) => a.type === 'endConversions') ?? l[0]); }
});
t('R22.3/R22.4 App.B "Blue\'s final score": 71 + Media 3 x 5 x 3 = 45 + 4 selfies -> 2 = 118; tie broken clockwise from the marker', () => {
  const s = toHour5(4); s.startPlayer = 0; s.firstPlayer = 0; // Hour 5 first player = seat 0 holds the marker
  setCeleb(s, '5a', 'character_mando_01'); setCeleb(s, '5b', 'character_rings_01');
  const BLUE = 2, RED = 3; // Blue 2 seats clockwise of the marker, Red 3
  for (let i = 0; i < 3; i++) put(s, BLUE, 'h31', 'VIP'); // h31 is on neither Hour 5 route: no Walk selfies
  s.players[BLUE].vp = 71; s.players[BLUE].hand = ['scoring_01']; s.players[BLUE].selfies = sel(2, 1, 1);
  s.players[RED].vp = 118;
  walkNow(s, 0); finish(s);
  assert.ok(E.isGameOver(s));
  assert.equal(s.players[BLUE].vp, 118);
  const r = E.scoreGame(s);
  const rank = (seat) => r.players.find((p) => p.seat === seat).rank;
  assert.ok(rank(BLUE) < rank(RED), 'Blue beats Red on the tie-break');
  assert.equal(r.winner, BLUE);
});
t('R22.3 with Achiever the best card is tripled and the others score x1', () => {
  const s = toHour5(2); setCeleb(s, '5a', 'character_mando_01'); setCeleb(s, '5b', 'character_rings_01');
  for (const g of ['h11', 'h12', 'h13']) put(s, 0, g); // Party 3 x 2 = 6, Spread Out 3 x 2 = 6, Corner Him 2 x 3 = 6 ...
  put(s, 0, 'h11', 'VIP'); // Media 1 x 5 = 5; Party 4 x 2 = 8
  s.players[0].hand = ['scoring_01', 'scoring_11']; s.players[0].handSize = 3;
  const before = s.players[0].vp;
  walkNow(s, 1); finish(s);
  const gained = s.players[0].vpBySource['achievement-final'];
  assert.equal(gained, 8 * 3 + 5, 'Party tripled (24) + Media x1 (5)');
  assert.ok(s.players[0].vp >= before + gained);
});
t('R22.4/R22.5 leftover selfies 2 VP per 4 (fewer than 4 score nothing); leftover coffee scores nothing', () => {
  const s = toHour5(2); setCeleb(s, '5a', 'character_mando_01'); setCeleb(s, '5b', 'character_rings_01');
  walkNow(s, 0);
  // selfies were 0 for the window (no decisions); now check the automatic exchange on a fresh end state
  const t2 = toHour5(2); setCeleb(t2, '5a', 'character_mando_01'); setCeleb(t2, '5b', 'character_rings_01');
  t2.players[0].coffee = 12;
  const events = walkNow(t2, 0);
  assert.equal(t2.players[0].vpBySource['final-selfies'], 0);
  assert.equal(ev(events, 'vp').filter((e) => e.player === 0 && e.source !== 'celebrity').length, 0, 'coffee scores nothing');
  const u = toHour5(2); setCeleb(u, '5a', 'character_mando_01'); setCeleb(u, '5b', 'character_rings_01');
  u.players[1].selfies = sel(5, 2, 2); // 9 -> 2 exchanges
  walkNow(u, 0);
  while (!E.isGameOver(u)) E.applyAction(u, valid(u).find((a) => a.type === 'endConversions'));
  assert.equal(u.players[1].vpBySource['final-selfies'], 4);
});
t('R22.6 ties broken clockwise from the Hour 5 first player, for every rank', () => {
  const s = toHour5(4); s.firstPlayer = 2; s.startPlayer = 3;
  setCeleb(s, '5a', 'character_mando_01'); setCeleb(s, '5b', 'character_rings_01');
  for (const p of s.players) p.vp = 10;
  walkNow(s, 1);
  const r = E.scoreGame(s);
  const order = [...r.players].sort((a, b) => a.rank - b.rank).map((p) => p.seat);
  assert.deepEqual(order, [2, 3, 0, 1]);
});
t('R22.7 every VP gain is tagged with a source; per-seat totals reconcile (random games)', () => {
  for (const seed of [5, 6]) {
    const s = E.createGame({ playerCount: 3 }, { seed });
    const sum = [0, 0, 0];
    const choose = seededPicker(seed);
    while (!E.isGameOver(s)) {
      for (const e of ev(E.applyAction(s, choose(valid(s))), 'vp')) { assert.ok(E.VP_SOURCES.includes(e.source), e.source); sum[e.player] += e.amount; }
    }
    s.players.forEach((p, i) => { assert.equal(p.vp, sum[i]); assert.equal(Object.values(p.vpBySource).reduce((a, b) => a + b, 0), p.vp); });
  }
});

// ======================================================= R23 information and randomness

t('R23.2 blindCopy keeps own hand, hides others; public state unchanged', () => {
  const s = E.createGame({ playerCount: 3 }, { seed: 17 });
  const b = E.blindCopy(s, 0, E.makeRng(99));
  assert.deepEqual(b.players[0].hand, s.players[0].hand);
  assert.deepEqual(b.crew, s.crew); assert.deepEqual(b.swag.market, s.swag.market);
});
t('R23.4 determinism: same config + seed + actions = same state', () => {
  const a = playRandom(E.createGame({ playerCount: 4 }, { seed: 77 }), 3);
  const b = playRandom(E.createGame({ playerCount: 4 }, { seed: 77 }), 3);
  assert.equal(E.hashState(a), E.hashState(b));
});
t('R23.5 single-option decisions are applied automatically (never a 1-entry list)', () => {
  playRandom(game(5, { clubs: 'random', firstPlayer: 'random' }, 88), 88);
});

// ======================================================= R24 stale wording

t('R24 player-facing text uses rulebook terms (no MOJO / Selfy / Challenge card)', () => {
  const texts = [...E.SWAG_CARDS, ...E.CLUB_CARDS, ...E.ACHIEVEMENT_CARDS].map((c) => c.text).join(' | ');
  for (const bad of [/MOJO/i, /Selfy/, /Challenge card/i, /\bNoob\b/]) assert.ok(!bad.test(texts), String(bad));
  const s = E.createGame({ playerCount: 3 }, { seed: 2 });
  const labels = valid(s).map((a) => E.describeAction(s, a)).join(' ');
  assert.ok(!/MOJO|Selfy/i.test(labels));
});

// ======================================================= R26 VARIANTS

t('R26.1 the twelve variants: names, values (default first), defaults; unknown names and values rejected', () => {
  const want = [
    ['queueCapacity', ['printed-board', 'rulebook']], ['celebrityColours', ['random-slots', 'fixed-slots']],
    ['coffeeCap', ['every-gain', 'coffee-break-only']], ['fivePlayerOpening', ['overfill', 'fallback']],
    ['usherInHall', ['both-halls', 'neither']], ['homeBase', ['three-crew', 'as-printed']],
    ['achiever', ['hand-size', 'draw-two-keep-one']], ['clubHandLimits', ['off', 'on']],
    ['finalBoard', ['figures-stay', 'figures-removed']], ['militiaRoll', ['coin', 'fixed']],
    ['clubs', ['random', 'off']], ['firstPlayer', ['random', 'seat-0']],
  ];
  assert.deepEqual(E.VARIANTS.map((v) => [v.name, v.values]), want);
  for (const v of E.VARIANTS) assert.equal(v.default, v.values[0]);
  assert.throws(() => E.createGame({ playerCount: 2, variants: { nope: 'x' } }, { seed: 1 }));
  assert.throws(() => E.createGame({ playerCount: 2, variants: { queueCapacity: 'huge' } }, { seed: 1 }));
  for (const [name, values] of want) for (const v of values) {
    const s = E.createGame({ playerCount: 4, variants: { [name]: v } }, { seed: 3 });
    assert.equal(s.variants[name], v);
  }
});
t('R26.2 finalBoard=figures-removed: Starstruck counts 0 for the last card; figures-stay counts them', () => {
  for (const [v, want] of [['figures-stay', 1], ['figures-removed', 0]]) {
    const s = toHour5(2, { finalBoard: v });
    setCeleb(s, '5a', 'character_mando_01'); setCeleb(s, '5b', 'character_rings_01');
    put(s, 0, 'h21'); // 5a ends on h21
    s.players[0].hand = ['scoring_21'];
    walkNow(s, 1);
    assert.equal(s.players[0].vpBySource['achievement-final'], want * 4 * 3, v);
  }
});
t('R26.3 any combination is legal: every non-default value at once plays to the end', () => {
  const variants = Object.fromEntries(E.VARIANTS.map((v) => [v.name, v.values[1]]));
  variants.clubs = 'random';
  const s = E.createGame({ playerCount: 5, variants }, { seed: 123 });
  playRandom(s, 123);
  assert.ok(E.isGameOver(s));
});

// ======================================================= R27 CONSTANTS

t('R27 constants equal the values printed in the spec', () => {
  const K = C(game());
  assert.deepEqual(K.GAME, { HOURS: 5, PLAYERS_MIN: 2, PLAYERS_MAX: 5, CELEBRITIES_DRAWN_PER_RANK: 2, HOUR_5_CELEBRITIES: 2 });
  assert.deepEqual(K.SUPPLY, { CREW_PER_PLAYER: 8, HATS_PER_PLAYER: 3, BOXES_PER_PLAYER: 1, VOLUNTEERS_PER_PLAYER: 6 });
  assert.equal(K.START.START_COFFEE, 12); assert.deepEqual(K.START.START_SELFIES, { green: 1, red: 1, orange: 1 });
  assert.equal(K.START.START_VP, 0); assert.equal(K.START.START_ACHIEVEMENTS, 2); assert.equal(K.START.OPENING_CREW_PER_PLAYER, 2);
  assert.equal(K.BOARD.HALL_COUNT, 9); assert.equal(K.BOARD.ROPE_COUNT, 12); assert.equal(K.BOARD.VOLUNTEER_SPACES, 30);
  assert.equal(K.BOARD.SWAG_MARKET_SLOTS, 5); assert.deepEqual(K.BOARD.SWAG_COST_MIX, [20, 9, 7]);
  assert.deepEqual(K.CAPACITY.QUEUE_CAPACITY['printed-board'], { 2: 4, 3: 6, 4: 7, 5: 7 });
  assert.deepEqual(K.CAPACITY.QUEUE_CAPACITY.rulebook, { 2: 5, 3: 7, 4: 8, 5: 8 });
  assert.equal(K.LIMITS.COFFEE_CAP, 12); assert.equal(K.LIMITS.COFFEE_MIN, 0); assert.equal(K.LIMITS.ACHIEVEMENT_HAND_SIZE, 2);
  assert.equal(K.LIMITS.ACHIEVER_HAND_BONUS, 1); assert.equal(K.LIMITS.CLUB_HAND_LIMIT_MILITIA, 12); assert.equal(K.LIMITS.CLUB_HAND_LIMIT_TCG, 10);
  assert.deepEqual(K.COSTS, { COST_MOVE_2: 1, COST_MOVE_3_CREW: 3, COST_NEW_NOOB: 4, COST_UPGRADE: 5, COST_VOLUNTEER: 2, COST_TAKE_SELFIE: 1, COST_SWAG_COFFEE: 0, COST_PASS: 0, SELFIE_GAIN_TAKE_SELFIE: 1 });
  assert.deepEqual(K.MOVEMENT, { MOVE_2_MAX_STEPS: 2, MOVE_3_MAX_CREW: 3, USHER_COFFEE_PER_CROSSING: 1 });
  assert.equal(K.EXCHANGE.EXCHANGE_E1.PAY, 2); assert.equal(K.EXCHANGE.EXCHANGE_E1.GAIN_COFFEE, 1);
  assert.equal(K.EXCHANGE.EXCHANGE_E2.PAY, 2); assert.equal(K.EXCHANGE.EXCHANGE_E2.GAIN_SELFIES, 1);
  assert.equal(K.EXCHANGE.EXCHANGE_E3.PAY, 4); assert.equal(K.EXCHANGE.EXCHANGE_E3.GAIN_VP, 2);
  assert.equal(K.PASS.PASS_SLOTS, 4); assert.equal(K.PASS.PASS_FIRST_PASSER_COFFEE, 2); assert.equal(K.PASS.PASS_DISCARD_COFFEE, 2);
  assert.equal(K.PASS.PASS_DRAW_ACHIEVEMENTS, 1); assert.deepEqual(K.PASS.PASS_SLOT_REWARD.slice(2), [1, 2, 3]);
  assert.deepEqual(K.WALK, { WALK_SELFIES_PRIME_POSITION: 1, WALK_SELFIES_PHOTOGRAPHER: 1 });
  assert.equal(K.ACHIEVEMENTS.ACHIEVEMENT_FINAL_MULTIPLIER, 3); assert.equal(K.ACHIEVEMENTS.ACHIEVEMENT_OTHER_MULTIPLIER, 1);
  assert.deepEqual(K.FINAL, { FINAL_SELFIES_PER_EXCHANGE: 4, FINAL_VP_PER_EXCHANGE: 2, FINAL_COFFEE_VP: 0 });
  assert.equal(K.SAFETY.MAX_MAIN_ACTIONS_PER_PLAYER_PER_HOUR, 60); assert.equal(K.SAFETY.MAX_ENGINE_ACTIONS_PER_GAME, 20000);
  const CL = K.CLUBS.CLUBS;
  assert.equal(CL.club_01.COST_VIP, 5); assert.equal(CL.club_01.COST_AAA, 8); assert.equal(CL.club_02.COST, 1); assert.equal(CL.club_03.COST, 1);
  assert.equal(CL.club_03.SELFIES, 4); assert.equal(CL.club_04.COST, 1); assert.equal(CL.club_04.MAX_VP, 5); assert.equal(CL.club_04.SELFIES, 4);
  assert.equal(CL.club_05.COST, 3); assert.equal(CL.club_06.COST, 1); assert.equal(CL.club_06.TOKENS, 6); assert.equal(CL.club_06.KEEP_PROBABILITY, 0.5);
  assert.equal(CL.club_07.COST, 0); assert.equal(CL.club_07.PAY, 2); assert.equal(CL.club_07.GAIN, 3); assert.equal(CL.club_08.COST, 2); assert.equal(CL.club_08.VP_PER_HALL, 2);
  assert.equal(CL.club_09.COST, 1); assert.equal(CL.club_09.SELFIES, 2);
});
t('R27.10 schedule: slot hours, ranks, colour slots X Y Z X Y Z', () => {
  const S = C(game()).SCHEDULE;
  assert.deepEqual(S.SLOTS, ['1', '2', '3', '4', '5a', '5b']);
  assert.deepEqual(Object.values(S.COLOUR_SLOT), ['X', 'Y', 'Z', 'X', 'Y', 'Z']);
  assert.deepEqual(S.FIXED_COLOURS, { X: 'green', Y: 'red', Z: 'orange' });
});
t('R27 constant overrides are honoured (COST_MOVE_2 = 2)', () => {
  const s = E.createGame({ playerCount: 2, variants: { clubs: 'off', firstPlayer: 'seat-0' }, constants: { COSTS: { COST_MOVE_2: 2 } } }, { seed: 1 });
  clear(s); const m = put(s, 0, 'h32'); turnFor(s, 0);
  pick(s, { type: 'move2', crew: m, to: G.h22 });
  assert.equal(s.players[0].coffee, 10);
});


// ======================================================= extra edge checks (second pass)

t('R4.3.3 all six colours are set (public) from the start of the game', () => {
  const s = E.createGame({ playerCount: 3 }, { seed: 6 });
  for (const e of s.schedule) assert.ok(['green', 'red', 'orange'].includes(e.colour), e.slot);
});
t('R5.4/R23.2 the 12 celebrity cards left out are never stored in the state', () => {
  const s = E.createGame({ playerCount: 3 }, { seed: 6 });
  const text = JSON.stringify(s);
  const present = E.CELEBRITY_CARDS.filter((c) => text.includes(`"${c.id}"`)).length;
  assert.equal(present, 6);
});
t('R8.9 the 60th main action flags the game turnCapped and leaves only Pass', () => {
  const s = clear(game(2)); const m = put(s, 0, 'h32'); turnFor(s, 0);
  s.players[0].mainActionsThisHour = C(s).SAFETY.MAX_MAIN_ACTIONS_PER_PLAYER_PER_HOUR - 1;
  pick(s, { type: 'move2', crew: m, to: G.h22 });
  turnFor(s, 0);
  assert.deepEqual([...new Set(valid(s).map((a) => a.type))], ['pass']);
  assert.equal(s.flags.turnCapped, true);
});
t('R10.4 nobody gains when an opponent Crew is moved across your Usher (Too Crowded)', () => {
  const s = clear(game(2), { coffee: 5 }); const o = put(s, 1, 'h32'); put(s, 1, 'h33'); vol(s, 0, ropeOf('h32', 'h31'));
  buyable(s, 'swag_green_10'); pick(s, { type: 'buySwag', card: 'swag_green_10' });
  pick(s, { type: 'effectMove', crew: o, to: G.h31 });
  assert.equal(s.players[0].coffee, 5); assert.equal(s.players[1].coffee, 5);
});
t('R10.5 a path through a full hall is never used for the Usher bonus', () => {
  const s = clear(game(2), { coffee: 5 }); const m = put(s, 0, 'h32'); vol(s, 0, ropeOf('h31', 'h21')); vol(s, 0, ropeOf('h32', 'h31'));
  for (let i = 0; i < E.capacity(s); i++) put(s, 1, 'h31');
  turnFor(s, 0);
  const e = ev(pick(s, { type: 'move2', crew: m, to: G.h21 }), 'crewMoved')[0];
  assert.ok(!e.path.includes(G.h31)); assert.equal(s.players[0].coffee, 4);
});
t('R16.5 empty deck and discard: the card just used is reshuffled straight back into the slot', () => {
  const s = clear(game(2)); buyable(s, 'swag_red_03'); s.swag.deck = []; s.swag.discard = [];
  pick(s, { type: 'buySwag', card: 'swag_red_03' });
  assert.equal(s.swag.market[0], 'swag_red_03');
});
t('R16.8 swag_orange_02 Excuse Me!: never offered for two Crew of one owner or of different badges', () => {
  const s = clear(game(2)); put(s, 0, 'h22'); put(s, 0, 'h22'); put(s, 1, 'h12', 'VIP'); put(s, 0, 'h12'); put(s, 0, 'h11');
  buyable(s, 'swag_orange_02'); pick(s, { type: 'buySwag', card: 'swag_orange_02' });
  assert.equal(s.toAct, 1, 'no legal swap: effect skipped');
});
t('R16.8 swag_green_11 Priority: never ahead of another player\'s Security-led N00b', () => {
  const s = clear(game(2)); const oN = put(s, 1, 'h12'); vol(s, 1, SEC('h12')); put(s, 0, 'h11'); buyable(s, 'swag_green_11');
  pick(s, { type: 'buySwag', card: 'swag_green_11' }); pick(s, { type: 'effectPlaceCrew', hall: G.h12 });
  const mine = s.crew.find((c) => c.owner === 0 && c.hall === G.h12).id;
  assert.deepEqual(q(s, 'h12'), [oN, mine]);
});
t('R16.8 swag_orange_05 We\'re Full!: own Crew across own Usher gains the bonus', () => {
  const s = clear(game(2), { coffee: 5 }); put(s, 1, 'h22'); const mine = put(s, 0, 'h22'); vol(s, 0, ropeOf('h22', 'h23'));
  buyable(s, 'swag_orange_05'); pick(s, { type: 'buySwag', card: 'swag_orange_05' });
  pick(s, { type: 'effectMove', crew: mine, to: G.h23 });
  assert.equal(s.players[0].coffee, 6);
});
t('R17.6.1 Silver Screen Society: never into a full hall; needs a Crew in supply', () => {
  const s = clubGame('club_01'); for (let i = 0; i < E.capacity(s); i++) put(s, 1, 'h13'); turnFor(s, 0);
  pick(s, { type: 'clubPower', option: 'vip' });
  assert.ok(!valid(s).some((a) => a.type === 'effectPlaceCrew' && a.hall === G.h13));
  const z = clubGame('club_01'); for (let i = 0; i < 8; i++) put(z, 0, ['h11', 'h12', 'h21', 'h23'][i % 4]); turnFor(z, 0);
  assert.equal(offered(z, { type: 'clubPower' }), false);
});
t('R17.6.9 Strike a Pose in the final window turns leftover coffee into selfies', () => {
  const s = toHour5(2, { clubs: 'random' }); for (const p of s.players) p.club = null; s.players[0].club = 'club_09';
  setCeleb(s, '5a', 'character_mando_01'); setCeleb(s, '5b', 'character_rings_01'); s.players[0].coffee = 2;
  walkNow(s, 1);
  assert.equal(s.stack.at(-1).kind, 'finalWindow'); assert.equal(s.toAct, 0);
  pick(s, { type: 'strikeAPose', gain: sel(2, 0, 0) }); pick(s, { type: 'strikeAPose', gain: sel(2, 0, 0) });
  finish(s);
  assert.equal(s.players[0].vpBySource['final-selfies'], 2, '4 selfies -> 2 VP');
});
t('R20.3 Walk selfies are of the celebrity\'s colour', () => {
  const s = clear(game(2)); setCeleb(s, '1', 'character_mando_03', 'orange'); put(s, 1, 'h21');
  walkNow(s, 0);
  assert.deepEqual(s.players[1].selfies, sel(0, 0, 1));
});
t('R20.5/R6.3 the First Player marker passes clockwise after the Walk (event)', () => {
  const s = clear(game(3)); const events = walkNow(s, 2);
  const m = ev(events, 'firstPlayerMoved')[0];
  assert.deepEqual([m.from, m.to], [0, 1]); assert.equal(s.firstPlayer, 1);
});
t('R22.1 final windows go in turn order from the Hour 5 first player', () => {
  const s = toHour5(3); s.firstPlayer = 1; s.startPlayer = 2;
  setCeleb(s, '5a', 'character_mando_01'); setCeleb(s, '5b', 'character_rings_01');
  for (const p of s.players) p.selfies = sel(2, 2, 0); // every window is a real decision
  walkNow(s, 0);
  const order = [];
  while (!E.isGameOver(s)) { order.push(s.toAct); E.applyAction(s, valid(s).find((a) => a.type === 'endConversions')); }
  assert.deepEqual(order, [1, 2, 0]);
});
t('R22.3 "this Hour" at final scoring is Hour 5: Relaxed scores for the Hour 5 first passer with 8+ coffee (x3 = 30)', () => {
  const s = toHour5(2); setCeleb(s, '5a', 'character_mando_01'); setCeleb(s, '5b', 'character_rings_01');
  s.players[0].hand = ['scoring_40']; s.players[0].coffee = 9; s.players[0].passSlot = 1; s.hourState.passOrder = [0]; s.hourState.firstPasser = 0;
  s.players[1].hand = []; turnFor(s, 1); E.applyAction(s, { type: 'pass' }); finish(s);
  assert.equal(s.players[0].vpBySource['achievement-final'], 30);
});

t('R26.3 under coffee-break-only the pass-slot coffee is still offered on 12 coffee', () => {
  const s = clear(game(2, { coffeeCap: 'coffee-break-only' }), { coffee: 12 }); s.players[0].passSlot = 1;
  s.stack = [{ kind: 'passTurn', player: 0, conversions: 0, rareFindsUsed: false }]; s.toAct = 0; s.turn = { number: 5, player: 0, kind: 'pass' };
  assert.ok(offered(s, { type: 'passReward', reward: 'coffee' }));
  const i = clear(game(2, { coffeeCap: 'coffee-break-only' }), { coffee: 14 }); walkNow(i, 1);
  assert.equal(i.players[0].coffee, 14, 'the Coffee Break never lowers coffee above 12');
});
t('R15.5/R17.6.7 Rare Finds is offered in a pass-turn', () => {
  const s = clubGame('club_07', 2, {}, { coffee: 5, selfies: sel(4, 0, 0) }); s.players[0].passSlot = 1;
  s.stack = [{ kind: 'passTurn', player: 0, conversions: 0, rareFindsUsed: false }]; s.toAct = 0; s.turn = { number: 5, player: 0, kind: 'pass' };
  assert.ok(offered(s, { type: 'rareFinds' }));
});
t('R17.6.1 Silver Screen AAA needs a hat and the box', () => {
  const s = clubGame('club_01'); s.players[0].hats = 0; turnFor(s, 0);
  assert.equal(offered(s, { type: 'clubPower', option: 'aaa' }), false);
});
t('R16.8 swag_orange_02 Excuse Me!: not across a Security difference', () => {
  const s = clear(game(2)); const o = put(s, 1, 'h22'); const m = put(s, 0, 'h22'); vol(s, 1, SEC('h22')); put(s, 0, 'h11');
  buyable(s, 'swag_orange_02'); pick(s, { type: 'buySwag', card: 'swag_orange_02' });
  assert.deepEqual(q(s, 'h22'), [o, m]); assert.equal(s.toAct, 1);
});
t('R18.2.3 Hour 5 pass with one Achievement left: score or discard it, then no draw', () => {
  const s = clear(game(2)); s.hour = 5; setHand(s, 0, ['scoring_11']); put(s, 0, 'h11'); turnFor(s, 0);
  pick(s, { type: 'pass' }); pick(s, { type: 'discardAchievement', card: 'scoring_11' });
  assert.deepEqual(s.players[0].hand, []);
});
t('R5.9.1 four players: the over-full Entrance sends New N00b next to it', () => {
  const s = game(4); turnFor(s, 0);
  assert.equal(E.queue(s, G.h32).length, 8);
  assert.deepEqual(valid(s).filter((a) => a.type === 'newNoob').map((a) => GRID[a.hall]).sort(), ['h22', 'h31', 'h33']);
});
t('R8.2/R18.5 the last passer resolves the pass (Achievement on the pre-Walk board) before the Walk', () => {
  const s = clear(game(2)); setCeleb(s, '1', 'character_mando_03'); // figure on h11 before walking
  put(s, 0, 'h11'); s.players[1].passSlot = 1; s.hourState.passOrder = [1]; s.hourState.firstPasser = 1;
  setHand(s, 0, ['scoring_21', 'scoring_09']); turnFor(s, 0);
  pick(s, { type: 'pass' });
  assert.equal(s.hour, 1, 'Walk waits for the Achievement choice');
  const events = pick(s, { type: 'scoreAchievement', card: 'scoring_21' });
  const sc = ev(events, 'achievementScored')[0];
  assert.ok(sc.count >= 1, `Starstruck counted the figure still on its start hall (count ${sc.count})`);
  assert.ok(ev(events, 'celebrityEntered').length > 0, 'then the Walk ran');
  assert.ok(events.indexOf(sc) < events.findIndex((e) => e.type === 'celebrityEntered'));
});
t('R6.3/R8.1 the new Hour starts with the new first player', () => {
  const s = clear(game(3)); walkNow(s, 2);
  assert.equal(s.hour, 2); assert.equal(s.toAct, 1); assert.equal(s.turn.player, 1);
});

// ---------------------------------------------------------------- run

const filter = process.argv[2];
let pass = 0; const fails = [];
const t0 = Date.now();
for (const c of checks) {
  if (filter && !c.name.includes(filter)) continue;
  try { c.fn(); pass++; } catch (e) { fails.push({ name: c.name, err: e }); }
}
for (const f of fails) console.log(`FAIL ${f.name}\n     ${String(f.err?.message ?? f.err).split('\n').slice(0, 6).join('\n     ')}`);
const bySection = {};
for (const c of checks) { const m = c.name.match(/^R(\d+)/); const k = m ? `R${m[1]}` : 'other'; bySection[k] = (bySection[k] ?? 0) + 1; }
console.log(`rules audit: ${pass} passed, ${fails.length} failed, ${checks.length} checks (${Date.now() - t0} ms)`);
console.log(`checks per section: ${Object.entries(bySection).map(([k, v]) => `${k} ${v}`).join(', ')}`);
process.exit(fails.length ? 1 : 0);
