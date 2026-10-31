// cards.test.mjs - every card in the card data has an implementation, and each one does what the spec says
// (R16.8 the 36 Swag cards, R17.6 the nine Clubs, R19.10 the 40 Achievements, R21.2 the 18 celebrities).
//
//   1. coverage: every card id has an implementation the engine knows;
//   2. Achievements: 40 conditions checked against an independent reference written from the spec
//      table over random boards; no card claims anything on an empty board; unknown metric = false;
//   3. Swag: one check per card on a constructed position;
//   4. Clubs: one check per Club, plus once-per-Hour and the pass rule.

import assert from 'node:assert/strict';
import { E, K, game, clear, put, putNext, fill, vol, give, act, refused, legal, only, vpOf, setHand, passAll, turnFor, buy } from './helpers/fixtures.mjs';

let failures = 0;
let passes = 0;
function check(name, fn) {
  try {
    fn();
    passes++;
  } catch (err) {
    failures++;
    console.log(`FAIL ${name}\n  ${err && err.stack ? err.stack.split('\n').slice(0, 5).join('\n  ') : err}`);
  }
}

const ROPE = (a, b) => E.ropeBetween(a, b);
const sorted = (xs) => xs.slice().sort();

// ---------------------------------------------------------------------------------------------
// 1. Coverage
// ---------------------------------------------------------------------------------------------

check('coverage: every card id in the card data has an implementation', () => {
  const s = game(3);
  // 36 Swag
  assert.equal(E.SWAG_CARDS.length, 36);
  for (const c of E.SWAG_CARDS) {
    assert.ok(E.EFFECTS[c.id] && E.EFFECTS[c.id].kind === 'swag', `${c.id} ${c.name} has an effect`);
    assert.equal(typeof E.EFFECTS[c.id].begin, 'function');
    assert.ok(K(s).SWAG.SWAG_COST[c.id] >= 1, `${c.id} cost`);
  }
  // 9 Clubs: seven main-action powers with effects, two free conversions (Rare Finds, Strike a Pose)
  assert.equal(E.CLUB_CARDS.length, 9);
  for (const c of E.CLUB_CARDS) {
    if (c.id === 'club_07' || c.id === 'club_09') {
      assert.ok(!E.CLUB_OPTIONS[c.id], `${c.id} is a free conversion, not a main action`);
      assert.ok(K(s).CLUBS.CLUBS[c.id], `${c.id} constants`);
    } else {
      assert.ok(E.EFFECTS[c.id] && E.EFFECTS[c.id].kind === 'club', `${c.id} ${c.name} has an effect`);
      assert.ok(E.CLUB_OPTIONS[c.id].length >= 1);
    }
  }
  // 40 Achievements
  assert.equal(E.ACHIEVEMENT_CARDS.length, 40);
  for (const c of E.ACHIEVEMENT_CARDS) {
    const spec = E.achievementSpec(s, c.id);
    assert.ok(spec && E.ACHIEVEMENT_METRICS.includes(spec.metric), `${c.id} ${c.name} has a known metric`);
    assert.ok(K(s).ACHIEVEMENTS.ACHIEVEMENT_LAUREL[c.id] >= 2, `${c.id} laurel`);
  }
  // 18 celebrities: a known scoring method, a route of adjacent halls, values for the method
  assert.equal(E.CELEBRITY_CARDS.length, 18);
  const methods = new Set();
  for (const c of E.CELEBRITY_CARDS) {
    methods.add(c.scoring.method);
    assert.ok(c.route.length >= 3 && c.route[0] === c.start && c.route[c.route.length - 1] === c.destination, c.id);
    for (let i = 1; i < c.route.length; i++) assert.ok(E.areAdjacent(c.route[i - 1], c.route[i]), `${c.id} route step ${i}`);
    const v = K(s).CELEBRITIES.CELEBRITIES[c.id];
    assert.equal(v.METHOD, c.scoring.method);
    assert.ok(v.COFFEE >= 1);
    const need = { everyone: 1, 'everyone-no-n00bs': 1, 'by-badge': 3, 'count-total': 3, 'in-order': 7, 'in-order-no-n00bs': 7 }[c.scoring.method];
    assert.equal(v.VALUES.length, need, `${c.id} (${c.scoring.method}) has ${need} values`);
  }
  assert.equal(methods.size, 6);
  assert.ok(E.PASS_CARD, 'the Pass card');
  // the card text carries no stale words (R24)
  for (const c of [...E.SWAG_CARDS, ...E.CLUB_CARDS, ...E.ACHIEVEMENT_CARDS]) assert.ok(!/MOJO|Selfy|Noob\b|Challenge card/.test(c.text), `${c.id}: "${c.text}"`);
});

// ---------------------------------------------------------------------------------------------
// 2. Achievements
// ---------------------------------------------------------------------------------------------

const ROWS = [['artist-alley', 'main-stage', 'cosplay-arena'], ['autograph-hall', 'main-hall', 'vendor-hall'], ['photo-ops', 'entrance', 'food-trucks']];
const COLS = [0, 1, 2].map((c) => ROWS.map((r) => r[c]));
const DIAGS = [['artist-alley', 'main-hall', 'food-trucks'], ['cosplay-arena', 'main-hall', 'photo-ops']];
const CORNERS = ['artist-alley', 'cosplay-arena', 'photo-ops', 'food-trucks'];
const EDGES = ['main-stage', 'autograph-hall', 'vendor-hall', 'entrance'];
const ALL_HALLS = ROWS.flat();
const ROPE_LIST = [
  ['rope_01', 'artist-alley', 'main-stage'], ['rope_02', 'artist-alley', 'autograph-hall'], ['rope_03', 'main-stage', 'cosplay-arena'],
  ['rope_04', 'main-stage', 'main-hall'], ['rope_05', 'cosplay-arena', 'vendor-hall'], ['rope_06', 'autograph-hall', 'main-hall'],
  ['rope_07', 'autograph-hall', 'photo-ops'], ['rope_08', 'main-hall', 'vendor-hall'], ['rope_09', 'main-hall', 'entrance'],
  ['rope_10', 'vendor-hall', 'food-trucks'], ['rope_11', 'photo-ops', 'entrance'], ['rope_12', 'entrance', 'food-trucks'],
];

/**
 * The reference: the R19.10 table read straight into code, written without looking at achievements.js.
 * Variants at their defaults (both-halls Ushers, three-crew Home Base).
 */
function reference(state, seat) {
  const rank = { AAA: 2, VIP: 1, N00b: 0 };
  const onBoard = state.crew.filter((c) => c.hall !== null);
  const inHall = (h) => onBoard.filter((c) => c.hall === h);
  const queue = (h) => {
    const sec = state.volunteers[`security-${h}`];
    return inHall(h).sort((a, b) => rank[b.badge] - rank[a.badge] || (b.owner === sec) - (a.owner === sec) || a.stamp - b.stamp);
  };
  const own = (h) => inHall(h).filter((c) => c.owner === seat);
  const vols = [];
  for (const [id, a, b] of ROPE_LIST) if (state.volunteers[id] === seat) vols.push({ role: 'usher', halls: [a, b] });
  for (const h of ALL_HALLS) {
    if (state.volunteers[`security-${h}`] === seat) vols.push({ role: 'security', halls: [h] });
    if (state.volunteers[`photographer-${h}`] === seat) vols.push({ role: 'photographer', halls: [h] });
  }
  const volIn = (h) => vols.filter((v) => v.halls.includes(h)).length;
  const figures = state.schedule.filter((e) => e.status === 'onBoard');
  const p = state.players[seat];
  const pairs = (role) => {
    const nodes = vols.filter((v) => v.role === role);
    const adjacent = (a, b) => (role === 'usher' ? a.halls.some((h) => b.halls.includes(h)) : ROPE_LIST.some(([, x, y]) => (x === a.halls[0] && y === b.halls[0]) || (y === a.halls[0] && x === b.halls[0])));
    let best = 0;
    const go = (i, used, n) => {
      best = Math.max(best, n);
      for (let a = i; a < nodes.length; a++) {
        if (used.has(a)) continue;
        for (let b = a + 1; b < nodes.length; b++) {
          if (used.has(b) || !adjacent(nodes[a], nodes[b])) continue;
          used.add(a);
          used.add(b);
          go(a + 1, used, n + 1);
          used.delete(a);
          used.delete(b);
        }
      }
    };
    go(0, new Set(), 0);
    return best;
  };
  const count = (list, f) => list.filter(f).length;
  const line = (lines) => Math.max(...lines.map((l) => count(onBoard, (c) => c.owner === seat && l.includes(c.hall))));
  const roleCount = (r) => vols.filter((v) => v.role === r).length;
  const res = {};
  res.scoring_01 = count(onBoard, (c) => c.owner === seat && c.badge !== 'N00b');
  res.scoring_02 = line(ROWS);
  res.scoring_03 = Math.min(5, Math.floor((p.selfies.green + p.selfies.red + p.selfies.orange) / 2));
  res.scoring_04 = count(ALL_HALLS, (h) => queue(h).length > 0 && queue(h)[0].owner === seat);
  res.scoring_05 = count(ALL_HALLS, (h) => own(h).length >= 2);
  res.scoring_06 = vols.length;
  res.scoring_07 = count(ALL_HALLS, (h) => own(h).length >= 1);
  res.scoring_08 = pairs('usher');
  res.scoring_09 = pairs('photographer');
  res.scoring_10 = pairs('security');
  res.scoring_11 = onBoard.filter((c) => c.owner === seat).length;
  res.scoring_12 = count(ALL_HALLS, (h) => !figures.some((e) => e.figure === h) && own(h).length >= 1 && state.players.every((q) => q.seat === seat || count(inHall(h), (c) => c.owner === q.seat) <= own(h).length));
  res.scoring_13 = count(ALL_HALLS, (h) => volIn(h) >= 2);
  res.scoring_14 = Math.min(roleCount('usher'), roleCount('security'), roleCount('photographer'));
  res.scoring_15 = line(COLS);
  res.scoring_16 = count(ALL_HALLS, (h) => own(h).length >= 3);
  res.scoring_17 = Math.min(3, p.selfies.green, p.selfies.red, p.selfies.orange);
  res.scoring_18 = count(ALL_HALLS, (h) => queue(h).length > 0 && queue(h)[queue(h).length - 1].owner === seat);
  res.scoring_19 = count(ALL_HALLS, (h) => inHall(h).length > 0 && inHall(h).every((c) => c.owner === seat));
  res.scoring_20 = count(ALL_HALLS, (h) => queue(h).length >= 2 && queue(h)[0].owner === seat && queue(h)[queue(h).length - 1].owner === seat);
  res.scoring_21 = count(figures, (e) => own(e.figure).length >= 1);
  res.scoring_22 = count(ALL_HALLS, (h) => figures.some((e) => e.marker === h) && own(h).length >= 2);
  res.scoring_23 = roleCount('security');
  res.scoring_24 = roleCount('usher');
  res.scoring_25 = roleCount('photographer');
  res.scoring_26 = count(ALL_HALLS, (h) => new Set(own(h).map((c) => c.badge)).size >= 2);
  res.scoring_27 = count(CORNERS, (h) => own(h).length >= 1);
  res.scoring_28 = line(DIAGS);
  res.scoring_29 = count(EDGES, (h) => own(h).length >= 1);
  res.scoring_30 = count(ALL_HALLS, (h) => count(own(h), (c) => c.badge !== 'N00b') >= 1 && volIn(h) >= 1);
  res.scoring_31 = count(ALL_HALLS, (h) => own(h).length >= 3 && volIn(h) >= 1);
  res.scoring_32 = count(onBoard, (c) => c.owner === seat && c.badge === 'N00b');
  res.scoring_33 = count(ALL_HALLS, (h) => queue(h).length >= 2 && queue(h)[1].owner === seat);
  res.scoring_34 = (() => {
    let n = 0;
    for (const h of ALL_HALLS) {
      const q = queue(h);
      for (let i = 1; i < q.length - 1; i++) if (q[i].owner === seat && q[i - 1].owner !== seat && q[i + 1].owner !== seat) n++;
    }
    return n;
  })();
  res.scoring_35 = count(ALL_HALLS, (h) => own(h).length >= 2 && queue(h)[0].owner !== seat);
  res.scoring_36 = count(ALL_HALLS, (h) => own(h).length >= 1 && state.players.some((q) => q.seat !== seat && count(inHall(h), (c) => c.owner === q.seat) === own(h).length));
  res.scoring_37 = count(ALL_HALLS, (h) => own(h).length > inHall(h).length - own(h).length);
  res.scoring_38 = count(ROPE_LIST, ([, a, b]) => own(a).length >= 1 && own(b).length >= 1);
  res.scoring_39 = Math.floor(p.coffee / 3);
  res.scoring_40 = state.hourState.firstPasser === seat && p.coffee >= 8 ? 1 : 0;
  return res;
}

function randomBoard(seed, n) {
  const rng = E.makeRng(`board-${seed}`);
  const s = game(n, { seed: `b${seed}` });
  clear(s);
  const badges = ['N00b', 'N00b', 'N00b', 'VIP', 'AAA'];
  for (const c of s.crew) {
    if (E.rngInt(rng, 100) < 55) put(s, c.id, E.rngPick(rng, ALL_HALLS), E.rngPick(rng, badges));
  }
  for (const sp of E.VOLUNTEER_SPACES) if (E.rngInt(rng, 100) < 30) vol(s, sp.id, E.rngInt(rng, n));
  for (const p of s.players) {
    p.coffee = E.rngInt(rng, 13);
    p.selfies = { green: E.rngInt(rng, 5), red: E.rngInt(rng, 5), orange: E.rngInt(rng, 5) };
  }
  for (const e of s.schedule) {
    if (e.status === 'onBoard') {
      e.figure = E.rngPick(rng, ALL_HALLS);
      e.marker = E.rngPick(rng, ALL_HALLS);
    }
  }
  s.hourState.firstPasser = E.rngInt(rng, 3) === 0 ? null : E.rngInt(rng, n);
  return s;
}

check('R19.10: all 40 Achievement counts equal an independent reading of the table, on 150 random boards', () => {
  for (let i = 0; i < 150; i++) {
    const n = 2 + (i % 4);
    const s = randomBoard(i, n);
    for (let seat = 0; seat < n; seat++) {
      const ref = reference(s, seat);
      assert.equal(Object.keys(ref).length, 40);
      for (const card of E.ACHIEVEMENT_CARDS) {
        const got = E.countAchievement(s, seat, card.id);
        assert.equal(got.count, ref[card.id], `board ${i} seat ${seat} ${card.id} ${card.name}`);
      }
    }
  }
});

check('R19.4-R19.6: count x laurel x multiplier, the best row/column/diagonal is picked and recorded, maximums cap', () => {
  const s = game(2);
  clear(s);
  put(s, 'c0-1', 'photo-ops');
  put(s, 'c0-2', 'entrance');
  put(s, 'c0-3', 'food-trucks');
  put(s, 'c0-4', 'main-stage');
  const row = E.countAchievement(s, 0, 'scoring_02');
  assert.equal(row.count, 3);
  assert.deepEqual(row.choice.halls, ['photo-ops', 'entrance', 'food-trucks']);
  assert.equal(E.achievementValue(s, 0, 'scoring_02', 3), 3 * K(s).ACHIEVEMENTS.ACHIEVEMENT_LAUREL.scoring_02 * 3);
  give(s, 0, { selfies: { green: 9, red: 9, orange: 9 } });
  const k = K(s).ACHIEVEMENTS.ACHIEVEMENT_PARAMS;
  assert.equal(E.countAchievement(s, 0, 'scoring_03').count, k.scoring_03.MAX_PAIRS, 'Look at Me! is capped (R19.6)');
  assert.equal(E.countAchievement(s, 0, 'scoring_17').count, k.scoring_17.MAX_SETS, 'Collector is capped');
});

check('R19.10: nothing is claimable from nothing - an empty board, no selfies, no coffee counts 0 for every card; unknown metric = false', () => {
  for (const n of [2, 3, 4, 5]) {
    const s = game(n);
    clear(s);
    for (const e of s.schedule) {
      e.figure = null;
      e.marker = null;
    }
    for (const p of s.players) {
      p.coffee = 0;
      p.selfies = { green: 0, red: 0, orange: 0 };
    }
    s.hourState.firstPasser = null;
    for (const p of s.players) for (const card of E.ACHIEVEMENT_CARDS) assert.equal(E.countAchievement(s, p.seat, card.id).count, 0, `${card.id} at ${n} players`);
  }
  // a fresh setup: only conditions the opening actually satisfies pay (no Volunteers, no VIPs, nobody has passed ...)
  const s = game(3);
  for (const p of s.players) {
    // Volunteer cards, VIP/AAA cards and Relaxed cannot pay before anyone has placed a Volunteer, upgraded a Crew or passed
    for (const id of ['scoring_06', 'scoring_08', 'scoring_09', 'scoring_10', 'scoring_13', 'scoring_14', 'scoring_23', 'scoring_24', 'scoring_25', 'scoring_30', 'scoring_31', 'scoring_01', 'scoring_26', 'scoring_40']) {
      assert.equal(E.countAchievement(s, p.seat, id).count, 0, `${id} on a fresh setup`);
    }
  }
  // an unknown card or an unknown metric never pays
  assert.deepEqual(E.countAchievement(s, 0, 'scoring_99'), { count: 0, choice: null, implemented: false });
  const spec = E.ACHIEVEMENT_SPECS.scoring_01;
  const original = spec.metric;
  try {
    spec.metric = 'no-such-metric';
    const r = E.countAchievement(s, 0, 'scoring_01');
    assert.equal(r.count, 0);
    assert.equal(r.implemented, false);
  } finally {
    spec.metric = original;
  }
});

// ---------------------------------------------------------------------------------------------
// 3. Swag - one check per card
// ---------------------------------------------------------------------------------------------

/** A 3-player position with seat 0 on 5 coffee; `setup` builds the board; then the card is bought. */
function swag(card, setup, o = {}) {
  const s = game(o.n ?? 3, o.game ?? {});
  clear(s);
  give(s, 0, { coffee: 5 });
  if (setup) setup(s);
  const ev = buy(s, card);
  return { s, ev, k: K(s) };
}

const frameKind = (s) => E.topFrame(s).kind;
const options = (s, type) => E.getValidActions(s).filter((a) => a.type === type);
/** The effect is over: the next player's turn begins. */
function done(s) {
  assert.equal(frameKind(s), 'turn', 'the effect is over and the next turn begins');
  assert.equal(s.toAct, 1);
}

// ----- green -----

check('swag_green_01 Jumper (R16.8): place a Volunteer on an empty Security space; skipped when you have none left', () => {
  const { s } = swag('swag_green_01', (st) => vol(st, 'security-main-hall', 1));
  const spaces = sorted(options(s, 'effectPlaceVolunteer').map((a) => a.space));
  assert.deepEqual(spaces, sorted(E.HALL_IDS.filter((h) => h !== 'main-hall').map((h) => `security-${h}`)), 'empty Security spaces only');
  refused(s, { type: 'effectPlaceVolunteer', space: 'rope_01' }, /places a Security volunteer, and the rope between Artist Alley and Main Stage is not one of those spaces/);
  refused(s, { type: 'effectPlaceVolunteer', space: 'security-main-hall' }, /already holds/);
  act(s, { type: 'effectPlaceVolunteer', space: 'security-photo-ops' });
  assert.equal(s.volunteers['security-photo-ops'], 0);
  assert.equal(s.players[0].volunteers, K(s).SUPPLY.VOLUNTEERS_PER_PLAYER - 1);
  done(s);
  const none = swag('swag_green_01', (st) => {
    st.players[0].volunteers = 0;
  });
  done(none.s); // R8.7: bought, nothing to do, no empty frame
  assert.ok(none.s.swag.discard.includes('swag_green_01'));
});

check('swag_green_02 Teleport (R16.8, R16.4.3): a jump of your own Crew to any other hall with room - no rope, no Usher bonus, new stamp', () => {
  const { s, ev, k } = swag('swag_green_02', (st) => {
    put(st, 'c0-1', 'photo-ops');
    fill(st, 'main-hall', E.capacity(st));
    vol(st, ROPE('photo-ops', 'entrance'), 0);
    vol(st, ROPE('autograph-hall', 'photo-ops'), 0);
  });
  const dests = sorted(options(s, 'effectMove').map((a) => a.to));
  assert.deepEqual(dests, sorted(E.HALL_IDS.filter((h) => h !== 'photo-ops' && h !== 'main-hall')), 'anywhere with room, not where it stands');
  refused(s, { type: 'effectMove', crew: 'c0-1', to: 'main-hall' }, /Main Hall is full/);
  refused(s, { type: 'effectMove', crew: 'c1-1', to: 'artist-alley' }, /may only|moves your own|Player 2's/);
  const coffee = s.players[0].coffee;
  const events = act(s, { type: 'effectMove', crew: 'c0-1', to: 'entrance' });
  const moved = only(events, E.EVENTS.CREW_MOVED)[0];
  assert.equal(moved.jump, true);
  assert.equal(moved.ushersPaid, 0);
  assert.equal(s.players[0].coffee, coffee, 'no Usher bonus for a jump (R10.4)');
  assert.equal(E.crewById(s, 'c0-1').hall, 'entrance');
  done(s);
  void ev;
  void k;
});

check('swag_green_03 Star Chaser (R16.8): a jump to a hall with room that holds a celebrity figure', () => {
  const { s } = swag('swag_green_03', (st) => put(st, 'c0-1', 'photo-ops'));
  const figures = new Set(E.figuresOnBoard(s).map((f) => f.figure));
  figures.delete('photo-ops');
  assert.deepEqual(sorted(options(s, 'effectMove').map((a) => a.to)), sorted([...figures]));
  const notThere = E.HALL_IDS.find((h) => !figures.has(h) && h !== 'photo-ops');
  refused(s, { type: 'effectMove', crew: 'c0-1', to: notThere }, /No celebrity is standing in/);
  act(s, { type: 'effectMove', crew: 'c0-1', to: [...figures][0] });
  done(s);
});

check('swag_green_04 3-2-1 Push! (R16.8, R16.4.2): one Crew up to 3 steps; the Usher bonus applies', () => {
  const { s, k } = swag('swag_green_04', (st) => {
    put(st, 'c0-1', 'entrance');
    vol(st, ROPE('entrance', 'main-hall'), 0);
    vol(st, ROPE('main-hall', 'main-stage'), 0);
    vol(st, ROPE('main-stage', 'artist-alley'), 0);
  });
  const dests = options(s, 'effectMove').map((a) => a.to);
  assert.ok(dests.includes('artist-alley'), 'entrance to artist-alley is 3 steps');
  assert.ok(!dests.includes('entrance'));
  const max = k.SWAG.SWAG_PARAMS.swag_green_04.MAX_STEPS;
  assert.equal(max, 3);
  const ev = act(s, { type: 'effectMove', crew: 'c0-1', to: 'main-stage' });
  assert.equal(only(ev, E.EVENTS.CREW_MOVED)[0].ushersPaid, 2);
  assert.equal(s.players[0].coffee, 5 + 2 * k.MOVEMENT.USHER_COFFEE_PER_CROSSING);
  done(s);
});

check('swag_green_05 Line Monitor (R16.8): coffee for each Crew of yours in a hall where you have the Security volunteer', () => {
  const { s, k } = swag('swag_green_05', (st) => {
    vol(st, 'security-main-hall', 0);
    vol(st, 'security-photo-ops', 0);
    vol(st, 'security-entrance', 1);
    put(st, 'c0-1', 'main-hall');
    put(st, 'c0-2', 'main-hall');
    put(st, 'c1-1', 'main-hall');
    put(st, 'c0-3', 'entrance');
  });
  assert.deepEqual(sorted(options(s, 'effectChooseHall').map((a) => a.hall)), ['main-hall', 'photo-ops']);
  refused(s, { type: 'effectChooseHall', hall: 'entrance' }, /do not have the Security volunteer in Entrance/);
  act(s, { type: 'effectChooseHall', hall: 'main-hall' });
  assert.equal(s.players[0].coffee, 5 + 2 * k.SWAG.SWAG_PARAMS.swag_green_05.COFFEE_PER_CREW);
  done(s);
});

check('swag_green_06 Fast Track (R16.8, R16.4.6): an earlier stamp - front of its class, never past a higher badge or a Security-led Crew', () => {
  const { s } = swag('swag_green_06', (st) => {
    put(st, 'c1-1', 'main-hall', 'VIP');
    put(st, 'c2-1', 'main-hall');
    put(st, 'c2-2', 'main-hall');
    put(st, 'c0-1', 'main-hall'); // last N00b
    put(st, 'c0-2', 'photo-ops'); // a second choice, so the pick is a real decision
    vol(st, 'security-main-hall', 2); // seat 2's N00bs lead the N00b class
  });
  assert.deepEqual(E.queue(s, 'main-hall').map((c) => c.id), ['c1-1', 'c2-1', 'c2-2', 'c0-1']);
  act(s, { type: 'effectChooseCrew', crew: 'c0-1' });
  assert.deepEqual(E.queue(s, 'main-hall').map((c) => c.id), ['c1-1', 'c2-1', 'c2-2', 'c0-1'], 'still behind the VIP and the Security-led N00bs');
  assert.ok(E.crewById(s, 'c0-1').stamp < E.crewById(s, 'c2-1').stamp, 'but its stamp is the earliest');
  done(s);
  const t = swag('swag_green_06', (st) => {
    put(st, 'c1-1', 'main-hall');
    put(st, 'c2-1', 'main-hall');
    put(st, 'c0-1', 'main-hall');
    put(st, 'c0-2', 'photo-ops');
  });
  act(t.s, { type: 'effectChooseCrew', crew: 'c0-1' });
  assert.equal(E.queue(t.s, 'main-hall')[0].id, 'c0-1', 'Prime Position among equals');
});

check('swag_green_07 Run! (R16.8): one Crew up to 2 steps, as Move 2 without the coffee', () => {
  const { s, k } = swag('swag_green_07', (st) => {
    put(st, 'c0-1', 'entrance');
    vol(st, ROPE('entrance', 'main-hall'), 0);
  });
  const dests = sorted(options(s, 'effectMove').map((a) => a.to));
  assert.deepEqual(dests, sorted(['main-hall', 'photo-ops', 'food-trucks', 'main-stage', 'autograph-hall', 'vendor-hall']));
  act(s, { type: 'effectMove', crew: 'c0-1', to: 'main-stage' });
  assert.equal(s.players[0].coffee, 5 + k.MOVEMENT.USHER_COFFEE_PER_CROSSING, 'no cost, one Usher crossing');
  done(s);
});

check('swag_green_08 Rush! (R16.8, R10.7): up to two single steps by different Crew, at least one', () => {
  const { s } = swag('swag_green_08', (st) => {
    put(st, 'c0-1', 'entrance');
    put(st, 'c0-2', 'entrance');
    put(st, 'c0-3', 'entrance');
  });
  assert.equal(frameKind(s), 'moveSteps');
  assert.equal(E.topFrame(s).max, K(s).SWAG.SWAG_PARAMS.swag_green_08.MAX_CREW);
  assert.ok(!options(s, 'stopMoving').length, 'cannot stop before the first step');
  refused(s, { type: 'stopMoving' }, /at least one step/);
  act(s, { type: 'moveStep', crew: 'c0-1', to: 'main-hall' });
  assert.ok(options(s, 'stopMoving').length === 1, 'may stop after one');
  refused(s, { type: 'moveStep', crew: 'c0-1', to: 'photo-ops' }, /already moved/);
  act(s, { type: 'moveStep', crew: 'c0-2', to: 'photo-ops' });
  done(s); // two steps end it
});

check('swag_green_09 Hold Hands (R16.8): two of your Crew in one hall step together to an adjacent hall with 2 free places, old order kept', () => {
  const { s, k } = swag('swag_green_09', (st) => {
    put(st, 'c0-1', 'entrance');
    put(st, 'c1-1', 'entrance');
    put(st, 'c0-2', 'entrance');
    put(st, 'c0-3', 'photo-ops');
    fill(st, 'food-trucks', E.capacity(st) - 1); // one place left: not enough for two
    vol(st, ROPE('entrance', 'main-hall'), 0);
  });
  const opts = options(s, 'effectMovePair');
  assert.ok(opts.every((o) => ['c0-1', 'c0-2'].includes(o.crew) && ['c0-1', 'c0-2'].includes(o.other)), 'both Crew are yours and share a hall');
  assert.deepEqual(sorted(opts.map((o) => o.to)), ['main-hall', 'photo-ops'].sort(), 'Food Trucks has only one free place');
  refused(s, { type: 'effectMovePair', crew: 'c0-1', other: 'c0-2', to: 'food-trucks' }, /needs 2/);
  refused(s, { type: 'effectMovePair', crew: 'c0-1', other: 'c1-1', to: 'main-hall' }, /only|own/);
  refused(s, { type: 'effectMovePair', crew: 'c0-1', other: 'c0-3', to: 'main-hall' }, /same hall/);
  const ev = act(s, { type: 'effectMovePair', crew: 'c0-2', other: 'c0-1', to: 'main-hall' });
  assert.deepEqual(only(ev, E.EVENTS.CREW_MOVED).map((e) => e.crew), ['c0-1', 'c0-2'], 'the one further forward arrives first');
  assert.equal(s.players[0].coffee, 5 + 2 * k.MOVEMENT.USHER_COFFEE_PER_CROSSING, 'each crossing earns the Usher bonus (R16.8)');
  done(s);
});

check("swag_green_10 Too Crowded (R16.8): an opponent's N00b steps to an adjacent hall with room; nobody gains an Usher bonus", () => {
  const { s } = swag('swag_green_10', (st) => {
    put(st, 'c1-1', 'entrance');
    put(st, 'c2-1', 'entrance', 'VIP');
    put(st, 'c0-1', 'entrance');
    vol(st, ROPE('entrance', 'main-hall'), 0);
    vol(st, ROPE('entrance', 'photo-ops'), 1);
  });
  const crew = sorted([...new Set(options(s, 'effectMove').map((a) => a.crew))]);
  assert.deepEqual(crew, ['c1-1'], "only another player's N00b");
  refused(s, { type: 'effectMove', crew: 'c0-1', to: 'main-hall' }, /opponent's N00b/);
  refused(s, { type: 'effectMove', crew: 'c2-1', to: 'main-hall' }, /not a N00b/);
  act(s, { type: 'effectMove', crew: 'c1-1', to: 'main-hall' });
  assert.equal(s.players[0].coffee, 5, "even across the buyer's own Usher");
  assert.equal(s.players[1].coffee, K(s).START.START_COFFEE);
  done(s);
});

check('swag_green_11 Priority (R16.8, R16.4.6): a fresh N00b in any hall with room takes Prime Position unless a higher badge or Security leads', () => {
  const { s } = swag('swag_green_11', (st) => {
    put(st, 'c1-1', 'main-hall', 'VIP');
    put(st, 'c2-1', 'main-hall');
    fill(st, 'photo-ops', E.capacity(st));
  });
  const halls = options(s, 'effectPlaceCrew').map((a) => a.hall);
  assert.ok(halls.includes('main-hall') && !halls.includes('photo-ops'), 'full halls are not offered');
  refused(s, { type: 'effectPlaceCrew', hall: 'photo-ops' }, /Photo Ops is full/);
  act(s, { type: 'effectPlaceCrew', hall: 'main-hall' });
  assert.deepEqual(E.queue(s, 'main-hall').map((c) => c.owner), [1, 0, 2], 'behind the VIP, ahead of the N00b');
  done(s);
  const empty = swag('swag_green_11', null);
  act(empty.s, { type: 'effectPlaceCrew', hall: 'artist-alley' });
  assert.equal(E.primeOwner(empty.s, 'artist-alley'), 0);
  const noSupply = swag('swag_green_11', (st) => {
    for (const c of st.crew.filter((x) => x.owner === 0)) put(st, c.id, 'artist-alley');
  });
  assert.equal(frameKind(noSupply.s), 'turn', 'no Crew in supply: the placement does not happen (R16.4.1)');
});

check('swag_green_12 Over Here! (R16.8): a jump to a hall with room where you have the Security volunteer', () => {
  const { s } = swag('swag_green_12', (st) => {
    put(st, 'c0-1', 'entrance');
    vol(st, 'security-vendor-hall', 0);
    vol(st, 'security-food-trucks', 0);
    vol(st, 'security-photo-ops', 1);
    vol(st, 'security-entrance', 0); // where it already stands: not a move
  });
  assert.deepEqual(sorted(options(s, 'effectMove').map((a) => a.to)), ['food-trucks', 'vendor-hall']);
  refused(s, { type: 'effectMove', crew: 'c0-1', to: 'photo-ops' }, /do not have the Security volunteer in Photo Ops/);
  act(s, { type: 'effectMove', crew: 'c0-1', to: 'vendor-hall' });
  assert.equal(E.crewById(s, 'c0-1').hall, 'vendor-hall');
});

// ----- red -----

check('swag_red_01 Guide / swag_orange_01 Selfie Booth (R16.8, R16.4.5): a Volunteer on an empty Usher / Photographer space', () => {
  const g = swag('swag_red_01', (st) => vol(st, 'rope_05', 1));
  assert.deepEqual(sorted(options(g.s, 'effectPlaceVolunteer').map((a) => a.space)), sorted(E.ROPE_IDS.filter((r) => r !== 'rope_05')));
  act(g.s, { type: 'effectPlaceVolunteer', space: 'rope_01' });
  assert.equal(g.s.volunteers.rope_01, 0);
  const p = swag('swag_orange_01', null);
  assert.deepEqual(sorted(options(p.s, 'effectPlaceVolunteer').map((a) => a.space)), sorted(E.HALL_IDS.map((h) => `photographer-${h}`)));
  act(p.s, { type: 'effectPlaceVolunteer', space: 'photographer-vendor-hall' });
  assert.equal(p.s.volunteers['photographer-vendor-hall'], 0);
});

check('swag_red_02 Shared Ticket (R16.8): a fresh N00b in a hall with room that holds one of your VIP or AAA Crew', () => {
  const { s } = swag('swag_red_02', (st) => {
    put(st, 'c0-1', 'main-hall', 'VIP');
    put(st, 'c0-2', 'vendor-hall', 'AAA');
    put(st, 'c0-3', 'photo-ops');
    put(st, 'c0-4', 'autograph-hall', 'VIP');
    put(st, 'c1-1', 'food-trucks', 'VIP');
    fill(st, 'vendor-hall', E.capacity(st) - 1); // vendor-hall now full
  });
  assert.deepEqual(sorted(options(s, 'effectPlaceCrew').map((a) => a.hall)), ['autograph-hall', 'main-hall'], 'not the full hall, not the N00b-only hall, not the opponent VIP');
  refused(s, { type: 'effectPlaceCrew', hall: 'photo-ops' }, /no VIP or AAA Crew in Photo Ops/);
  act(s, { type: 'effectPlaceCrew', hall: 'main-hall' });
  assert.equal(E.hallCount(s, 'main-hall'), 2);
});

check('swag_red_03 Coffee Break (R16.8): gain 3 coffee, up to the cap', () => {
  const { s, k } = swag('swag_red_03', null);
  assert.equal(s.players[0].coffee, 5 + k.SWAG.SWAG_PARAMS.swag_red_03.COFFEE);
  done(s);
  const t = swag('swag_red_03', (st) => give(st, 0, { coffee: 11 }));
  assert.equal(t.s.players[0].coffee, t.k.LIMITS.COFFEE_CAP);
  const lost = only(t.ev, E.EVENTS.COFFEE_GAIN).find((e) => e.cause === 'swag');
  assert.equal(lost.amount + lost.lost, t.k.SWAG.SWAG_PARAMS.swag_red_03.COFFEE);
});

check('swag_red_04 Upgrade! (R16.8): the Upgrade Crew action (R12) without the coffee', () => {
  const { s } = swag('swag_red_04', (st) => {
    put(st, 'c0-1', 'main-hall');
    put(st, 'c0-2', 'main-hall', 'AAA');
    put(st, 'c0-3', 'entrance', 'VIP');
    put(st, 'c0-4', 'entrance');
  });
  assert.deepEqual(sorted(options(s, 'effectChooseCrew').map((a) => a.crew)), ['c0-1', 'c0-4'], 'AAA cannot rise; the box is already used so a VIP cannot rise');
  refused(s, { type: 'effectChooseCrew', crew: 'c0-2' }, /already AAA/);
  act(s, { type: 'effectChooseCrew', crew: 'c0-1' });
  assert.equal(E.crewById(s, 'c0-1').badge, 'VIP');
  assert.equal(s.players[0].coffee, 5, 'free');
});

check('swag_red_05 All Together / swag_red_11 Coffee Run (R16.8, Q20): coffee for your Crew in a hall / for every Crew there, at most 6', () => {
  const a = swag('swag_red_05', (st) => {
    put(st, 'c0-1', 'main-hall');
    put(st, 'c0-2', 'main-hall');
    put(st, 'c1-1', 'main-hall');
  });
  assert.equal(options(a.s, 'effectChooseHall').length, 9, 'any hall');
  act(a.s, { type: 'effectChooseHall', hall: 'main-hall' });
  assert.equal(a.s.players[0].coffee, 5 + 2 * a.k.SWAG.SWAG_PARAMS.swag_red_05.COFFEE_PER_CREW);
  const b = swag('swag_red_11', (st) => {
    fill(st, 'main-hall', 5);
    put(st, 'c0-1', 'main-hall');
    fill(st, 'vendor-hall', 1);
  });
  const P = b.k.SWAG.SWAG_PARAMS.swag_red_11;
  const before = b.s.players[0].coffee;
  act(b.s, { type: 'effectChooseHall', hall: 'main-hall' });
  assert.equal(b.s.players[0].coffee, Math.min(before + P.MAX_COFFEE, b.k.LIMITS.COFFEE_CAP), '6 Crew x 2 = 12, capped at the card maximum');
  const c = swag('swag_red_11', (st) => fill(st, 'vendor-hall', 2));
  act(c.s, { type: 'effectChooseHall', hall: 'vendor-hall' });
  assert.equal(c.s.players[0].coffee, 5 + 2 * P.COFFEE_PER_CREW);
});

check('swag_red_06 Network / swag_red_10 Miranda! / swag_orange_06 Cameras! (R16.8): coffee per Usher / per VIP-AAA Crew / per Photographer', () => {
  const n = swag('swag_red_06', (st) => {
    vol(st, 'rope_01', 0);
    vol(st, 'rope_02', 0);
    vol(st, 'rope_03', 1);
  });
  assert.equal(n.s.players[0].coffee, 5 + 2 * n.k.SWAG.SWAG_PARAMS.swag_red_06.COFFEE_PER_USHER);
  const m = swag('swag_red_10', (st) => {
    put(st, 'c0-1', 'main-hall', 'VIP');
    put(st, 'c0-2', 'main-hall', 'AAA');
    put(st, 'c0-3', 'main-hall');
    put(st, 'c1-1', 'main-hall', 'VIP');
  });
  assert.equal(m.s.players[0].coffee, 5 + 2 * m.k.SWAG.SWAG_PARAMS.swag_red_10.COFFEE_PER_VIP);
  const c = swag('swag_orange_06', (st) => {
    vol(st, 'photographer-main-hall', 0);
    vol(st, 'photographer-entrance', 0);
    vol(st, 'security-entrance', 0);
  });
  assert.equal(c.s.players[0].coffee, 5 + 2 * c.k.SWAG.SWAG_PARAMS.swag_orange_06.COFFEE_PER_PHOTOGRAPHER);
});

check("swag_red_07 Special Line / swag_red_08 Staff Line (R16.8, Q20): a jump next to ANY Usher / a fresh N00b next to YOUR Usher", () => {
  const a = swag('swag_red_07', (st) => {
    put(st, 'c0-1', 'photo-ops');
    vol(st, ROPE('main-stage', 'cosplay-arena'), 1); // touches main-stage and cosplay-arena
  });
  assert.deepEqual(sorted(options(a.s, 'effectMove').map((o) => o.to)), ['cosplay-arena', 'main-stage']);
  refused(a.s, { type: 'effectMove', crew: 'c0-1', to: 'entrance' }, /No rope touching Entrance holds an Usher/);
  act(a.s, { type: 'effectMove', crew: 'c0-1', to: 'main-stage' });
  const b = swag('swag_red_08', (st) => {
    vol(st, ROPE('main-stage', 'cosplay-arena'), 1);
    vol(st, ROPE('entrance', 'food-trucks'), 0);
  });
  assert.deepEqual(sorted(options(b.s, 'effectPlaceCrew').map((o) => o.hall)), ['entrance', 'food-trucks']);
  act(b.s, { type: 'effectPlaceCrew', hall: 'food-trucks' });
  assert.equal(E.hallCount(b.s, 'food-trucks'), 1);
});

check('swag_red_09 Path (R16.8): up to two Ushers, at least one (one if only one is possible)', () => {
  const { s } = swag('swag_red_09', null);
  assert.ok(!options(s, 'effectDone').length, 'at least one');
  act(s, { type: 'effectPlaceVolunteer', space: 'rope_01' });
  assert.equal(frameKind(s), 'effect');
  assert.ok(options(s, 'effectDone').length === 1, 'may stop after one');
  act(s, { type: 'effectDone' });
  done(s);
  const two = swag('swag_red_09', null);
  act(two.s, { type: 'effectPlaceVolunteer', space: 'rope_01' });
  act(two.s, { type: 'effectPlaceVolunteer', space: 'rope_02' });
  done(two.s);
  const lone = swag('swag_red_09', (st) => {
    for (const r of E.ROPE_IDS.slice(1)) vol(st, r, 1); // only rope_01 empty
  });
  assert.equal(lone.s.volunteers.rope_01, 0, 'the only possible placement was made for the player');
  done(lone.s);
});

check('swag_red_12 Velvet Rope (R16.8, Q20): 1 VP per Crew of yours in a hall touched by a rope with your Usher (each Crew once)', () => {
  const { s, ev, k } = swag('swag_red_12', (st) => {
    vol(st, ROPE('entrance', 'main-hall'), 0);
    vol(st, ROPE('main-stage', 'main-hall'), 0); // main-hall is touched twice
    vol(st, ROPE('photo-ops', 'autograph-hall'), 1);
    put(st, 'c0-1', 'main-hall');
    put(st, 'c0-2', 'entrance');
    put(st, 'c0-3', 'photo-ops');
    put(st, 'c1-1', 'main-hall');
  });
  assert.equal(s.players[0].vp, 2 * k.SWAG.SWAG_PARAMS.swag_red_12.VP_PER_CREW);
  assert.equal(vpOf(ev, 0, 'swag'), s.players[0].vp);
  done(s);
});

// ----- orange -----

check('swag_orange_02 Excuse Me! (R16.8, Q19): two neighbours in a queue - different players, same badge, same Security standing - swap places', () => {
  const { s } = swag('swag_orange_02', (st) => {
    put(st, 'c1-1', 'main-hall');
    put(st, 'c2-1', 'main-hall');
    put(st, 'c0-1', 'main-hall');
    put(st, 'c1-2', 'main-hall', 'VIP');
    put(st, 'c2-3', 'main-hall', 'AAA');
    put(st, 'c1-3', 'vendor-hall');
    put(st, 'c1-4', 'vendor-hall');
  });
  const opts = options(s, 'effectSwap');
  assert.deepEqual(opts.map((o) => `${o.crew}/${o.other}`), ['c1-1/c2-1', 'c2-1/c0-1'], 'only different owners with equal badge side by side');
  refused(s, { type: 'effectSwap', crew: 'c1-3', other: 'c1-4' }, /two different players/);
  refused(s, { type: 'effectSwap', crew: 'c2-3', other: 'c1-2' }, /same badge/);
  refused(s, { type: 'effectSwap', crew: 'c1-1', other: 'c0-1' }, /next to each other/);
  act(s, { type: 'effectSwap', crew: 'c0-1', other: 'c2-1' }); // either order is accepted
  assert.deepEqual(E.queue(s, 'main-hall').map((c) => c.id), ['c2-3', 'c1-2', 'c1-1', 'c0-1', 'c2-1']);
  done(s);
  // Security standing: the queue rules would undo a swap with the Security owner's Crew
  const t = swag('swag_orange_02', (st) => {
    vol(st, 'security-main-hall', 1);
    put(st, 'c1-1', 'main-hall');
    put(st, 'c2-1', 'main-hall');
    put(st, 'c0-1', 'main-hall');
    put(st, 'c0-2', 'main-hall');
  });
  // the Security owner's Crew (c1-1) is not swappable with a Crew outside Security; the only legal swap is c2-1/c0-1,
  // a single option, so the engine made it for the player (R23.5)
  assert.deepEqual(E.queue(t.s, 'main-hall').map((c) => c.id), ['c1-1', 'c0-1', 'c2-1', 'c0-2']);
  done(t.s);
});

check('swag_orange_03 Collector (R16.8, Q20): 3 selfies of the colour of any celebrity on the board', () => {
  const { s, k } = swag('swag_orange_03', null);
  const figs = E.figuresOnBoard(s);
  assert.deepEqual(sorted(options(s, 'effectChooseCelebrity').map((a) => a.celebrity)), sorted(figs.map((f) => f.card)));
  const before = s.players[0].selfies[figs[1].colour];
  act(s, { type: 'effectChooseCelebrity', celebrity: figs[1].card });
  assert.equal(s.players[0].selfies[figs[1].colour] - before, k.SWAG.SWAG_PARAMS.swag_orange_03.SELFIES);
  done(s);
});

check('swag_orange_04 Much Better (R16.8): score an Achievement in hand at x1 (source achievement-swag), then draw one', () => {
  const { s, ev, k } = swag('swag_orange_04', (st) => {
    setHand(st, 0, ['scoring_11', 'scoring_07']);
    put(st, 'c0-1', 'main-hall');
    put(st, 'c0-2', 'entrance');
  });
  assert.deepEqual(sorted(options(s, 'effectChooseAchievement').map((a) => a.card)), ['scoring_07', 'scoring_11']);
  const deck = s.achievements.deck.length;
  const events = act(s, { type: 'effectChooseAchievement', card: 'scoring_11' });
  assert.equal(vpOf(events, 0, 'achievement-swag'), 2 * k.ACHIEVEMENTS.ACHIEVEMENT_LAUREL.scoring_11 * k.SWAG.SWAG_PARAMS.swag_orange_04.MULTIPLIER);
  assert.equal(s.players[0].hand.length, 2, 'drew another');
  assert.ok(!s.players[0].hand.includes('scoring_11'));
  assert.equal(s.achievements.deck.length, deck - k.SWAG.SWAG_PARAMS.swag_orange_04.DRAW);
  assert.ok(s.achievements.discard.some((d) => d.card === 'scoring_11' && d.scored));
  void ev;
  done(s);
});

check("swag_orange_05 We're Full! (R16.8): the Crew at the end of a line, any player's, steps to an adjacent hall with room", () => {
  const { s, k } = swag('swag_orange_05', (st) => {
    put(st, 'c1-1', 'main-hall');
    put(st, 'c2-1', 'main-hall');
    put(st, 'c0-1', 'entrance');
    vol(st, ROPE('entrance', 'photo-ops'), 0);
    vol(st, ROPE('main-hall', 'vendor-hall'), 0);
  });
  const crew = sorted([...new Set(options(s, 'effectMove').map((a) => a.crew))]);
  assert.deepEqual(crew, ['c0-1', 'c2-1'], 'the last of each queue');
  refused(s, { type: 'effectMove', crew: 'c1-1', to: 'vendor-hall' }, /not last in its queue/);
  act(s, { type: 'effectMove', crew: 'c2-1', to: 'vendor-hall' });
  assert.equal(s.players[0].coffee, 5, "another player's Crew gains the buyer no Usher coffee");
  assert.equal(E.crewById(s, 'c2-1').hall, 'vendor-hall');
  const t = swag('swag_orange_05', (st) => {
    put(st, 'c0-1', 'entrance');
    vol(st, ROPE('entrance', 'photo-ops'), 0);
  });
  act(t.s, { type: 'effectMove', crew: 'c0-1', to: 'photo-ops' });
  assert.equal(t.s.players[0].coffee, 5 + k.MOVEMENT.USHER_COFFEE_PER_CROSSING, 'your own Crew across your own Usher earns it');
});

check('swag_orange_08 Influencer (R16.8, Q20): 2 VP per selfie held after paying, at most 10; selfies are not spent', () => {
  const a = swag('swag_orange_08', (st) => give(st, 0, { selfies: { green: 2, red: 1, orange: 1 } }));
  const P = a.k.SWAG.SWAG_PARAMS.swag_orange_08;
  // buy() raises orange to the cost (2) if needed; after paying 2 orange the player holds 2 green + 1 red + 0 orange
  assert.equal(a.s.players[0].vp, P.VP_PER_SELFIE * E.selfieTotal(a.s.players[0].selfies));
  const b = swag('swag_orange_08', (st) => give(st, 0, { selfies: { green: 9, red: 9, orange: 9 } }));
  assert.equal(b.s.players[0].vp, P.MAX_VP);
  assert.equal(E.selfieTotal(b.s.players[0].selfies), 27 - b.k.SWAG.SWAG_COST.swag_orange_08, 'only the card was paid for');
});

check('swag_orange_09 Photo Rally / swag_orange_11 Trending (R16.8, Q20): selfies of colours you choose', () => {
  const a = swag('swag_orange_09', (st) => {
    vol(st, 'photographer-main-hall', 0);
    vol(st, 'photographer-photo-ops', 0);
  });
  assert.equal(options(a.s, 'effectGainSelfies').length, 6, 'compositions of 2 selfies over 3 colours');
  refused(a.s, { type: 'effectGainSelfies', gain: { green: 3, red: 0, orange: 0 } }, /exactly 2 Selfies/);
  const before = { ...a.s.players[0].selfies };
  act(a.s, { type: 'effectGainSelfies', gain: { green: 1, red: 1, orange: 0 } });
  assert.equal(a.s.players[0].selfies.green, before.green + 1);
  assert.equal(a.s.players[0].selfies.red, before.red + 1);
  const none = swag('swag_orange_09', null);
  done(none.s); // no Photographer: nothing to gain, no frame
  const t = swag('swag_orange_11', null);
  assert.equal(options(t.s, 'effectGainSelfies').length, 10);
  act(t.s, { type: 'effectGainSelfies', gain: { green: 0, red: 0, orange: 3 } });
  done(t.s);
});

check('swag_orange_10 Colour Swap (R16.8, Q20): change the colour of any number of your selfies, each at most once', () => {
  const { s } = swag('swag_orange_10', (st) => give(st, 0, { selfies: { green: 2, red: 0, orange: 1 } }));
  // paid 1 orange: holds 2 green
  assert.deepEqual(s.players[0].selfies, { green: 2, red: 0, orange: 0 });
  let types = options(s, 'effectConvertSelfie').map((a) => `${a.from}>${a.to}`);
  assert.deepEqual(sorted(types), ['green>orange', 'green>red']);
  assert.equal(options(s, 'effectDone').length, 1, 'any number includes none');
  act(s, { type: 'effectConvertSelfie', from: 'green', to: 'red' });
  types = options(s, 'effectConvertSelfie').map((a) => `${a.from}>${a.to}`);
  assert.deepEqual(sorted(types), ['green>orange', 'green>red'], 'the converted selfie is spent as a source: one green left to change');
  act(s, { type: 'effectConvertSelfie', from: 'green', to: 'orange' });
  assert.equal(frameKind(s), 'turn', 'nothing left to change: the effect ends by itself');
  assert.deepEqual(s.players[0].selfies, { green: 0, red: 1, orange: 1 });
  const t = swag('swag_orange_10', (st) => give(st, 0, { selfies: { green: 2, orange: 1 } }));
  act(t.s, { type: 'effectDone' });
  assert.deepEqual(t.s.players[0].selfies, { green: 2, red: 0, orange: 0 });
});

check('swag_orange_12 Look at me! (R16.8): 3 VP per hall where you have the Photographer and one of your Crew is first', () => {
  const { s, k } = swag('swag_orange_12', (st) => {
    vol(st, 'photographer-main-hall', 0);
    vol(st, 'photographer-photo-ops', 0);
    vol(st, 'photographer-entrance', 0);
    vol(st, 'photographer-vendor-hall', 1);
    put(st, 'c0-1', 'main-hall');
    put(st, 'c1-1', 'photo-ops');
    put(st, 'c0-2', 'photo-ops');
    put(st, 'c0-3', 'vendor-hall');
  });
  assert.equal(s.players[0].vp, k.SWAG.SWAG_PARAMS.swag_orange_12.VP_PER_HALL, 'only Main Hall: first there with the Photographer');
});

// ---------------------------------------------------------------------------------------------
// 4. Clubs
// ---------------------------------------------------------------------------------------------

function clubGame(club, n = 3, o = {}) {
  const s = game(n, { clubs: [club], ...o });
  clear(s);
  give(s, 0, { coffee: 12 });
  return s;
}

check('club_01 Silver Screen Society (R17.6.1): 5 coffee for a VIP Crew or 8 for an AAA, placed in any hall with room', () => {
  const s = clubGame('club_01');
  const k = K(s);
  assert.deepEqual(E.getValidActions(s).filter((a) => a.type === 'clubPower').map((a) => a.option), ['vip', 'aaa']);
  give(s, 0, { coffee: k.CLUBS.CLUBS.club_01.COST_AAA - 1 });
  assert.deepEqual(E.getValidActions(s).filter((a) => a.type === 'clubPower').map((a) => a.option), ['vip'], 'AAA costs more');
  refused(s, { type: 'clubPower', option: 'aaa' }, new RegExp(`costs ${k.CLUBS.CLUBS.club_01.COST_AAA} coffee and you have ${k.CLUBS.CLUBS.club_01.COST_AAA - 1}`));
  give(s, 0, { coffee: 12 });
  const ev = act(s, { type: 'clubPower', option: 'aaa' });
  assert.equal(s.players[0].coffee, 12 - k.CLUBS.CLUBS.club_01.COST_AAA);
  assert.equal(only(ev, E.EVENTS.CLUB_USED)[0].option, 'aaa');
  assert.equal(frameKind(s), 'effect');
  act(s, { type: 'effectPlaceCrew', hall: 'photo-ops' });
  const c = E.crewOnBoard(s, 0)[0];
  assert.equal(c.badge, 'AAA');
  assert.equal(s.players[0].hats, k.SUPPLY.HATS_PER_PLAYER - 1, 'a hat and the box');
  assert.equal(s.players[0].boxes, k.SUPPLY.BOXES_PER_PLAYER - 1);
  done(s);
  // once per Hour (R17.5)
  turnFor(s, 0);
  refused(s, { type: 'clubPower', option: 'vip' }, /already used Silver Screen Society this Hour/);
  // needs the pieces: no box left means no AAA
  const t = clubGame('club_01');
  put(t, 'c0-1', 'main-hall', 'AAA');
  assert.deepEqual(E.getValidActions(t).filter((a) => a.type === 'clubPower').map((a) => a.option), ['vip']);
  refused(t, { type: 'clubPower', option: 'aaa' }, /no AAA box/);
});

check('club_02 Player One Posse (R17.6.2): 1 coffee; place one Volunteer anywhere and/or move your placed ones (each once), at least one', () => {
  const s = clubGame('club_02');
  const k = K(s);
  vol(s, 'rope_01', 0);
  vol(s, 'rope_02', 0);
  act(s, { type: 'clubPower', option: 'use' });
  assert.equal(s.players[0].coffee, 12 - k.CLUBS.CLUBS.club_02.COST);
  assert.ok(!options(s, 'effectDone').length, 'at least one placement or move');
  const first = options(s, 'effectPlaceVolunteer').length;
  assert.equal(first, k.BOARD.VOLUNTEER_SPACES - 2);
  assert.equal(options(s, 'effectMoveVolunteer').length, 2 * (k.BOARD.VOLUNTEER_SPACES - 2));
  act(s, { type: 'effectPlaceVolunteer', space: 'security-main-hall' });
  assert.ok(!options(s, 'effectPlaceVolunteer').length, 'one placement only');
  assert.ok(options(s, 'effectDone').length === 1);
  assert.ok(!options(s, 'effectMoveVolunteer').some((a) => a.from === 'security-main-hall'), 'the new Volunteer is not moved again');
  act(s, { type: 'effectMoveVolunteer', from: 'rope_01', to: 'photographer-entrance' });
  assert.equal(s.volunteers.rope_01, null);
  assert.equal(s.volunteers['photographer-entrance'], 0, 'takes the new space\'s role');
  assert.ok(!options(s, 'effectMoveVolunteer').some((a) => a.from === 'photographer-entrance'), 'each moves once');
  act(s, { type: 'effectMoveVolunteer', from: 'rope_02', to: 'rope_09' });
  done(s); // nothing left to do: Done is the only option and was applied for the player
  assert.equal(E.volunteersOf(s, 0).length, 3, 'two placed before plus one placed now; moves change nothing in the count');
});

check('club_03 Hot Glue Syndicate (R17.6.3): 4 selfies of a celebrity in a hall where you have a Crew', () => {
  const s = clubGame('club_03');
  assert.equal(legal(s, 'clubPower').length, 0, 'no Crew with a celebrity');
  refused(s, { type: 'clubPower', option: 'use' }, /no Crew in a hall with a celebrity/);
  const f = E.figuresOnBoard(s)[2];
  putNext(s, 0, f.figure);
  const k = K(s);
  act(s, { type: 'clubPower', option: 'use' });
  assert.equal(s.players[0].coffee, 12 - k.CLUBS.CLUBS.club_03.COST);
  const here = E.figuresOnBoard(s).filter((x) => x.figure === f.figure);
  if (here.length > 1) act(s, { type: 'effectChooseCelebrity', celebrity: here[0].card });
  const colour = (here.length > 1 ? here[0] : f).colour;
  assert.equal(s.players[0].selfies[colour], k.START.START_SELFIES[colour] + k.CLUBS.CLUBS.club_03.SELFIES);
});

check('club_04 Otaku Alliance (R17.6.4): 1 VP per selfie held (max 5, not while you hold none), or 4 selfies of chosen colours', () => {
  const s = clubGame('club_04');
  const k = K(s);
  give(s, 0, { selfies: { green: 7 } });
  assert.deepEqual(E.getValidActions(s).filter((a) => a.type === 'clubPower').map((a) => a.option), ['vp', 'selfies']);
  const ev = act(s, { type: 'clubPower', option: 'vp' });
  assert.equal(vpOf(ev, 0, 'club'), k.CLUBS.CLUBS.club_04.MAX_VP);
  assert.equal(s.players[0].selfies.green, 7, 'selfies are not spent');
  const t = clubGame('club_04');
  give(t, 0, { selfies: {} });
  refused(t, { type: 'clubPower', option: 'vp' }, /hold no Selfies/);
  act(t, { type: 'clubPower', option: 'selfies' });
  assert.equal(options(t, 'effectGainSelfies').length, 15, 'compositions of 4');
  act(t, { type: 'effectGainSelfies', gain: { green: 1, red: 1, orange: 2 } });
  assert.deepEqual(t.players[0].selfies, { green: 1, red: 1, orange: 2 });
  const u = clubGame('club_04');
  give(u, 0, { selfies: { red: 3 } });
  assert.equal(vpOf(act(u, { type: 'clubPower', option: 'vp' }), 0, 'club'), 3, 'fewer than the maximum: one VP each');
});

check('club_05 Longbox Legion (R17.6.5): 3 coffee; draw 3 Achievements, then discard 3 from the hand - unscored, secret, no coffee', () => {
  const s = clubGame('club_05');
  const k = K(s);
  const hand = s.players[0].hand.slice();
  const deck = s.achievements.deck.length;
  act(s, { type: 'clubPower', option: 'use' });
  assert.equal(s.players[0].coffee, 12 - k.CLUBS.CLUBS.club_05.COST);
  assert.equal(s.players[0].hand.length, hand.length + k.CLUBS.CLUBS.club_05.DRAW);
  assert.equal(s.achievements.deck.length, deck - k.CLUBS.CLUBS.club_05.DRAW);
  const keep = s.players[0].hand.slice().sort();
  let events = [];
  while (frameKind(s) === 'effect') {
    const opts = options(s, 'effectChooseAchievement');
    assert.ok(opts.length > 0);
    events = events.concat(act(s, opts[0]));
  }
  assert.equal(s.players[0].hand.length, hand.length, 'back to the hand size');
  assert.equal(only(events, E.EVENTS.ACHIEVEMENT_DISCARDED).length, k.CLUBS.CLUBS.club_05.DISCARD);
  assert.ok(only(events, E.EVENTS.ACHIEVEMENT_DISCARDED).every((e) => e.secret === true && e.cause === 'club'));
  assert.equal(s.players[0].coffee, 12 - k.CLUBS.CLUBS.club_05.COST, 'no coffee for these discards');
  assert.equal(s.achievements.discard.filter((d) => d.scored === false && d.owner === 0).length, k.CLUBS.CLUBS.club_05.DISCARD);
  assert.deepEqual(s.players[0].hand.slice().sort(), keep.slice(-hand.length), 'the first picks are the lowest ids: the highest are kept');
});

check('club_06 Meeple Militia (R17.6.6, R26 militiaRoll): 6 chosen tokens, each kept on a coin flip else 1 VP; fixed = 3 kept and 3 VP', () => {
  const k = K(game(2));
  let keptTotal = 0;
  let games = 0;
  const outcomes = new Set();
  for (let i = 0; i < 60; i++) {
    const s = game(2, { clubs: ['club_06', 'club_08'], seed: `militia-${i}` });
    give(s, 0, { coffee: 12, selfies: {} });
    const ev0 = act(s, { type: 'clubPower', option: 'use' });
    void ev0;
    assert.equal(s.players[0].coffee, 12 - k.CLUBS.CLUBS.club_06.COST);
    assert.equal(options(s, 'effectGainSelfies').length, 28, 'compositions of 6');
    const ev = act(s, { type: 'effectGainSelfies', gain: { green: 2, red: 2, orange: 2 } });
    const kept = E.selfieTotal(s.players[0].selfies);
    const vp = vpOf(ev, 0, 'militia');
    assert.equal(kept + vp, k.CLUBS.CLUBS.club_06.TOKENS, 'every token is kept or scores 1 VP');
    assert.equal(s.players[0].vp, vp);
    assert.equal(s.players[0].vpBySource.militia, vp);
    keptTotal += kept;
    games++;
    outcomes.add(kept);
  }
  const mean = keptTotal / games;
  assert.ok(mean > 2.4 && mean < 3.6, `fair coin: mean kept ${mean}`);
  assert.ok(outcomes.size >= 4, 'varied results');
  // determinism: same seed, same flips
  const a = game(2, { clubs: ['club_06', 'club_08'], seed: 'same' });
  const b = game(2, { clubs: ['club_06', 'club_08'], seed: 'same' });
  for (const g of [a, b]) {
    give(g, 0, { coffee: 12, selfies: {} });
    act(g, { type: 'clubPower', option: 'use' });
    act(g, { type: 'effectGainSelfies', gain: { green: 6, red: 0, orange: 0 } });
  }
  assert.deepEqual(a.players[0].selfies, b.players[0].selfies);
  const f = game(2, { clubs: ['club_06', 'club_08'], variants: { militiaRoll: 'fixed' } });
  give(f, 0, { coffee: 12, selfies: {} });
  act(f, { type: 'clubPower', option: 'use' });
  assert.equal(options(f, 'effectGainSelfies').length, 10, 'fixed: 3 kept, chosen by the owner');
  const fev = act(f, { type: 'effectGainSelfies', gain: { green: 1, red: 1, orange: 1 } });
  assert.equal(E.selfieTotal(f.players[0].selfies), k.CLUBS.CLUBS.club_06.FIXED_KEPT);
  assert.equal(vpOf(fev, 0, 'militia'), k.CLUBS.CLUBS.club_06.TOKENS - k.CLUBS.CLUBS.club_06.FIXED_KEPT);
});

check('club_07 TCG Traders (R17.6.7): Rare Finds is a free conversion - 2 of one colour for 3 of another, once per turn, own turns only', () => {
  const s = clubGame('club_07');
  const k = K(s);
  give(s, 0, { coffee: 12, selfies: { green: 4 } });
  assert.equal(legal(s, 'clubPower').length, 0, 'not a main action');
  refused(s, { type: 'clubPower', option: 'use' }, /free action/);
  act(s, { type: 'rareFinds', pay: 'green', gain: 'red' });
  assert.deepEqual(s.players[0].selfies, { green: 4 - k.CLUBS.CLUBS.club_07.PAY, red: k.CLUBS.CLUBS.club_07.GAIN, orange: 0 });
  assert.equal(frameKind(s), 'turn', 'the turn goes on');
  refused(s, { type: 'rareFinds', pay: 'green', gain: 'orange' }, /once per turn/);
  turnFor(s, 0);
  assert.equal(legal(s, 'rareFinds').length > 0, true, 'a new turn, a new use');
  // never in the final window
  const f = clubGame('club_07');
  give(f, 0, { selfies: { green: 4 } });
  f.stack = [{ kind: 'finalWindow', player: 0, conversions: 0, rareFindsUsed: false }];
  f.toAct = 0;
  assert.equal(legal(f, 'rareFinds').length, 0);
});

check('club_08 Retro Gaming Guild (R17.6.8): 2 coffee; 2 VP per hall where one of your Crew is first; not with none', () => {
  const s = clubGame('club_08');
  const k = K(s);
  refused(s, { type: 'clubPower', option: 'use' }, /not first in the queue in any hall/);
  put(s, 'c0-1', 'main-hall');
  put(s, 'c0-2', 'main-hall');
  put(s, 'c0-3', 'photo-ops');
  put(s, 'c1-1', 'entrance');
  put(s, 'c0-4', 'entrance');
  const ev = act(s, { type: 'clubPower', option: 'use' });
  assert.equal(vpOf(ev, 0, 'club'), 2 * k.CLUBS.CLUBS.club_08.VP_PER_HALL);
  assert.equal(s.players[0].coffee, 12 - k.CLUBS.CLUBS.club_08.COST);
});

check('club_09 Selfie Stick Squad (R17.6.9, R7.1): Strike a Pose is a free conversion in every window - 1 coffee for 2 selfies of your choice', () => {
  const s = clubGame('club_09', 2);
  const k = K(s);
  assert.equal(legal(s, 'clubPower').length, 0);
  const gain = { green: 1, red: 0, orange: 1 };
  act(s, { type: 'strikeAPose', gain });
  act(s, { type: 'strikeAPose', gain: { green: 0, red: 2, orange: 0 } });
  assert.equal(s.players[0].coffee, 12 - 2 * k.CLUBS.CLUBS.club_09.COST, 'any number of times');
  assert.equal(E.selfieTotal(s.players[0].selfies), E.selfieTotal(k.START.START_SELFIES) + 2 * k.CLUBS.CLUBS.club_09.SELFIES);
  refused(s, { type: 'strikeAPose', gain: { green: 3, red: 0, orange: 0 } }, /exactly 2 Selfies/);
  // the pre-income window of the next Hour (R7.1): offered to its owner before anyone is paid
  const t = game(2, { clubs: ['club_09', 'club_08'] });
  give(t, 0, { coffee: 12 });
  passAll(t);
  assert.equal(t.hour, 2);
  assert.equal(E.topFrame(t).kind, 'squadWindow');
  assert.equal(t.toAct, 0);
  assert.equal(E.activePlayer(t), null);
  assert.ok(legal(t, 'strikeAPose').length > 0 && legal(t, 'endConversions').length === 1);
  const coffee = t.players[0].coffee;
  act(t, { type: 'endConversions' });
  assert.ok(t.players[0].coffee >= coffee, 'income arrived after the window');
});

check('R17.2, R17.5, R18.3: a Club power is a main action - once per Hour, reset each Hour, never after passing', () => {
  const s = clubGame('club_08');
  put(s, 'c0-1', 'main-hall');
  act(s, { type: 'clubPower', option: 'use' });
  assert.equal(s.players[0].clubUsedThisHour, true);
  turnFor(s, 0);
  refused(s, { type: 'clubPower', option: 'use' }, /already used Retro Gaming Guild this Hour/);
  assert.equal(legal(s, 'clubPower').length, 0);
  // passing everyone round resets it
  const t = game(2, { clubs: ['club_08', 'club_01'] });
  put(t, 'c0-1', 'main-hall');
  give(t, 0, { coffee: 12 });
  act(t, { type: 'clubPower', option: 'use' });
  passAll(t);
  assert.equal(t.hour, 2);
  assert.equal(t.players[0].clubUsedThisHour, false, 'available again (R6.4)');
  // after passing: no main-action power
  const u = game(2, { clubs: ['club_08', 'club_01'] });
  put(u, 'c0-1', 'main-hall');
  act(u, { type: 'pass' });
  act(u, { type: 'discardAchievement', card: u.players[0].hand[0] });
  act(u, { type: 'pass' });
  act(u, { type: 'discardAchievement', card: u.players[1].hand[0] });
  assert.equal(u.hour, 2, 'both passed: the Hour is over');
  const v = game(3, { clubs: ['club_08', 'club_01', 'club_02'] });
  put(v, 'c0-1', 'main-hall');
  act(v, { type: 'pass' });
  act(v, { type: 'discardAchievement', card: v.players[0].hand[0] });
  act(v, { type: 'volunteer', space: 'rope_01', player: 1 });
  refused(v, { type: 'clubPower', option: 'use', player: 0 }, /passed this Hour|It is/);
});

if (failures > 0) {
  console.log(`cards: ${failures} failed, ${passes} passed`);
  process.exit(1);
}
console.log(`cards ok (${passes} checks)`);
