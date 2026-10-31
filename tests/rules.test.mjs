// rules.test.mjs - one check per rule family of the numbered rules spec (v2), driven through the
// public engine API on constructed positions. Expected values are READ FROM THE CONSTANTS (R27) wherever
// the rule is a number, never typed in. Check names carry the rule numbers they cover.
//
// The card-by-card checks (36 Swag, 9 Clubs, 40 Achievements, 18 celebrities) are in cards.test.mjs.

import assert from 'node:assert/strict';
import {
  E, K, game, clear, put, putNext, fill, vol, give, act, refused, legal, only, vpOf, setHand, setCelebrity, passAll, normalise,
  turnFor, toHour5, buy,
} from './helpers/fixtures.mjs';

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

const ROPE = {
  'artist-alley|main-stage': 'rope_01',
  'artist-alley|autograph-hall': 'rope_02',
  'main-stage|cosplay-arena': 'rope_03',
  'main-stage|main-hall': 'rope_04',
  'cosplay-arena|vendor-hall': 'rope_05',
  'autograph-hall|main-hall': 'rope_06',
  'autograph-hall|photo-ops': 'rope_07',
  'main-hall|vendor-hall': 'rope_08',
  'main-hall|entrance': 'rope_09',
  'vendor-hall|food-trucks': 'rope_10',
  'photo-ops|entrance': 'rope_11',
  'entrance|food-trucks': 'rope_12',
};

// ---------------------------------------------------------------------------------------------
// R3, R5: board, capacity, setup
// ---------------------------------------------------------------------------------------------

check('R3.6, R3.6.1, R5.9.1: capacity by player count and variant; an over-full Entrance counts as full', () => {
  for (const n of [2, 3, 4, 5]) {
    for (const value of ['printed-board', 'rulebook']) {
      const s = game(n, { variants: { queueCapacity: value } });
      const C = K(s).CAPACITY.QUEUE_CAPACITY[value][n];
      assert.equal(E.capacity(s), C, `${value} at ${n} players`);
      const opening = n * K(s).START.OPENING_CREW_PER_PLAYER;
      assert.equal(E.hallCount(s, E.ENTRANCE), opening, 'all opening Crew are in the Entrance (R5.9.1 overfill)');
      assert.equal(E.isFull(s, E.ENTRANCE), opening >= C, 'full when the Entrance holds at least C (R3.6.1)');
    }
  }
  // the Entrance is not offered to a New N00b while it is full, and the message has the numbers
  const s = game(5);
  give(s, 0, { coffee: 12 });
  const C = E.capacity(s);
  const reason = refused(s, { type: 'newNoob', hall: E.ENTRANCE }, /Entrance is full/);
  assert.ok(reason.includes(`(${E.hallCount(s, E.ENTRANCE)} of ${C})`), reason);
});

check('R5: setup supplies, hands, market, schedule slots and the opening order', () => {
  const s = game(4, { variants: { firstPlayer: 'random' }, seed: 'setup-check', anySeat: true });
  const k = K(s);
  for (const p of s.players) {
    assert.equal(p.coffee, k.START.START_COFFEE);
    assert.deepEqual(p.selfies, k.START.START_SELFIES);
    assert.equal(p.hand.length, k.START.START_ACHIEVEMENTS);
    assert.equal(p.vp, k.START.START_VP);
  }
  assert.equal(s.swag.market.length, k.BOARD.SWAG_MARKET_SLOTS);
  assert.deepEqual(s.schedule.map((e) => e.slot), k.SCHEDULE.SLOTS);
  assert.deepEqual(s.schedule.filter((e) => e.status === 'onBoard').map((e) => e.slot), k.SCHEDULE.PLACED_AT_SETUP);
  // the opening stamps run in reverse turn order from the first player (R5.9)
  const order = E.openingOrder(s.startPlayer, 4);
  const stamps = s.crew.filter((c) => c.hall === E.ENTRANCE).sort((a, b) => a.stamp - b.stamp).map((c) => c.owner);
  assert.deepEqual(stamps, order.flatMap((seat) => Array(k.START.OPENING_CREW_PER_PLAYER).fill(seat)));
});

// ---------------------------------------------------------------------------------------------
// R9: queues
// ---------------------------------------------------------------------------------------------

check('R9.1: queue order is badge (AAA, VIP, N00b), then the Security owner, then arrival', () => {
  const s = game(3);
  clear(s);
  put(s, 'c0-1', 'main-hall');
  put(s, 'c1-1', 'main-hall');
  put(s, 'c2-1', 'main-hall');
  put(s, 'c1-2', 'main-hall', 'VIP');
  put(s, 'c2-2', 'main-hall', 'AAA');
  put(s, 'c0-2', 'main-hall', 'VIP');
  assert.deepEqual(E.queue(s, 'main-hall').map((c) => c.id), ['c2-2', 'c1-2', 'c0-2', 'c0-1', 'c1-1', 'c2-1']);
  // Security (R9.1 key 2): seat 2's Crew lead within their badge only
  vol(s, 'security-main-hall', 2);
  assert.deepEqual(E.queue(s, 'main-hall').map((c) => c.id), ['c2-2', 'c1-2', 'c0-2', 'c2-1', 'c0-1', 'c1-1']);
  assert.equal(E.primeOwner(s, 'main-hall'), 2);
  assert.equal(E.primeOwner(s, 'photo-ops'), null, 'an empty hall has no Prime Position');
});

check('R9.2, R10.3: every arrival gets a new stamp and stands at the back of its badge class', () => {
  const s = game(2);
  clear(s);
  put(s, 'c0-1', 'entrance');
  put(s, 'c1-1', 'main-hall');
  put(s, 'c1-2', 'main-hall');
  give(s, 0, { coffee: 6 });
  act(s, { type: 'move2', crew: 'c0-1', to: 'main-hall' });
  assert.deepEqual(E.queue(s, 'main-hall').map((c) => c.id), ['c1-1', 'c1-2', 'c0-1']);
  const stamps = s.crew.filter((c) => c.hall !== null).map((c) => c.stamp);
  assert.equal(new Set(stamps).size, stamps.length, 'stamps are unique');
});

// ---------------------------------------------------------------------------------------------
// R10: moving
// ---------------------------------------------------------------------------------------------

check('R10.2, R9.5: full halls are walls, a path never revisits a hall, a move never ends where it began', () => {
  const s = game(2);
  clear(s);
  const C = E.capacity(s);
  put(s, 'c0-1', 'entrance');
  fill(s, 'main-hall', C); // Main Hall full of seat 1's Crew
  assert.ok(E.isFull(s, 'main-hall'));
  const dests = legal(s, 'move2').filter((a) => a.crew === 'c0-1').map((a) => a.to).sort();
  assert.deepEqual(dests, ['autograph-hall', 'food-trucks', 'photo-ops', 'vendor-hall'], 'round the long way; not through Main Hall, not back to the Entrance');
  refused(s, { type: 'move2', crew: 'c0-1', to: 'main-hall' }, new RegExp(`Main Hall is full \\(${C} of ${C}\\)`));
  refused(s, { type: 'move2', crew: 'c0-1', to: 'artist-alley' }, /3 halls from Entrance; Move 2 reaches at most 2 halls/);
  refused(s, { type: 'move2', crew: 'c0-1', to: 'entrance' }, /already in Entrance/);
});

check('R10.4, R10.5: the Usher bonus is paid per own crossing of an own Usher; the path with most Ushers wins, then the first grid ids', () => {
  const k = K(game(2));
  // two own Ushers on the route Entrance - Main Hall - Main Stage
  let s = game(2);
  clear(s);
  put(s, 'c0-1', 'entrance');
  vol(s, ROPE['main-hall|entrance'], 0);
  vol(s, ROPE['main-stage|main-hall'], 0);
  give(s, 0, { coffee: 5 });
  let ev = act(s, { type: 'move2', crew: 'c0-1', to: 'main-stage' });
  assert.equal(s.players[0].coffee, 5 - k.COSTS.COST_MOVE_2 + 2 * k.MOVEMENT.USHER_COFFEE_PER_CROSSING);
  assert.equal(only(ev, E.EVENTS.CREW_MOVED)[0].ushersPaid, 2);
  // another player's Usher pays nothing
  s = game(2);
  clear(s);
  put(s, 'c0-1', 'entrance');
  vol(s, ROPE['main-hall|entrance'], 1);
  give(s, 0, { coffee: 5 });
  act(s, { type: 'move2', crew: 'c0-1', to: 'main-hall' });
  assert.equal(s.players[0].coffee, 5 - k.COSTS.COST_MOVE_2);
  // two paths to Autograph Hall: via Main Hall (h32,h22,h21) or via Photo Ops (h32,h31,h21)
  s = game(2);
  clear(s);
  put(s, 'c0-1', 'entrance');
  give(s, 0, { coffee: 5 });
  assert.deepEqual(E.movePaths(s, E.crewById(s, 'c0-1'), 2, 0)['autograph-hall'].path, ['entrance', 'main-hall', 'autograph-hall'], 'tie: first by grid ids (h22 before h31)');
  vol(s, ROPE['photo-ops|entrance'], 0);
  assert.deepEqual(E.movePaths(s, E.crewById(s, 'c0-1'), 2, 0)['autograph-hall'].path, ['entrance', 'photo-ops', 'autograph-hall'], 'more own Ushers wins');
  vol(s, ROPE['autograph-hall|photo-ops'], 0);
  ev = act(s, { type: 'move2', crew: 'c0-1', to: 'autograph-hall' });
  assert.deepEqual(only(ev, E.EVENTS.CREW_MOVED)[0].path, ['entrance', 'photo-ops', 'autograph-hall']);
  assert.equal(s.players[0].coffee, 5 - k.COSTS.COST_MOVE_2 + 2 * k.MOVEMENT.USHER_COFFEE_PER_CROSSING);
});

check('R10.7: Move 1 Crew x3 pays up front, steps by different Crew, checked step by step, ends after the third', () => {
  const s = game(3);
  clear(s);
  const C = E.capacity(s);
  put(s, 'c0-1', 'entrance');
  put(s, 'c0-2', 'entrance');
  put(s, 'c0-3', 'entrance');
  fill(s, 'main-hall', C - 1); // one place left in Main Hall
  give(s, 0, { coffee: 6 });
  const cost = K(s).COSTS.COST_MOVE_3_CREW;
  act(s, { type: 'move3', crew: 'c0-1', to: 'main-hall' });
  assert.equal(s.players[0].coffee, 6 - cost);
  assert.equal(E.topFrame(s).kind, 'moveSteps');
  refused(s, { type: 'moveStep', crew: 'c0-1', to: 'photo-ops' }, /already moved/);
  refused(s, { type: 'moveStep', crew: 'c0-2', to: 'main-hall' }, /Main Hall is full/);
  act(s, { type: 'moveStep', crew: 'c0-2', to: 'photo-ops' });
  act(s, { type: 'moveStep', crew: 'c0-3', to: 'food-trucks' });
  assert.equal(s.turn.player, 1, 'three steps end the action; the turn passes on');
});

check('R11.2, R11.3: a New N00b goes to the Entrance, else next to the Entrance, else anywhere with room', () => {
  const s = game(5);
  clear(s);
  const C = E.capacity(s);
  give(s, 0, { coffee: 12 });
  assert.deepEqual(legal(s, 'newNoob').map((a) => a.hall), ['entrance']);
  fill(s, 'entrance', C);
  assert.deepEqual(legal(s, 'newNoob').map((a) => a.hall).sort(), ['food-trucks', 'main-hall', 'photo-ops']);
  refused(s, { type: 'newNoob', hall: 'artist-alley' }, /next to the Entrance \(Main Hall, Photo Ops, Food Trucks\) has room/);
  for (const h of ['main-hall', 'photo-ops', 'food-trucks']) fill(s, h, C);
  const rest = legal(s, 'newNoob').map((a) => a.hall);
  assert.ok(rest.length > 0 && !rest.includes('entrance') && !rest.includes('main-hall'), 'any hall with room');
  const cost = K(s).COSTS.COST_NEW_NOOB;
  const before = s.players[0].coffee;
  act(s, { type: 'newNoob', hall: rest[0] });
  assert.equal(s.players[0].coffee, before - cost);
  assert.equal(E.crewOnBoard(s, 0).length, 1);
});

// ---------------------------------------------------------------------------------------------
// R12, R13
// ---------------------------------------------------------------------------------------------

check('R12: Upgrade pays, raises one badge, uses the hat then the box, new stamp, pieces are limited', () => {
  const s = game(3);
  clear(s);
  const k = K(s);
  put(s, 'c0-1', 'main-hall');
  put(s, 'c1-1', 'main-hall', 'VIP');
  put(s, 'c2-1', 'main-hall');
  give(s, 0, { coffee: 12 });
  act(s, { type: 'upgrade', crew: 'c0-1' });
  assert.equal(s.players[0].coffee, 12 - k.COSTS.COST_UPGRADE);
  assert.equal(E.crewById(s, 'c0-1').badge, 'VIP');
  assert.equal(s.players[0].hats, k.SUPPLY.HATS_PER_PLAYER - 1);
  assert.deepEqual(E.queue(s, 'main-hall').map((c) => c.id), ['c1-1', 'c0-1', 'c2-1'], 'back of the VIP class, ahead of the N00bs (R12.2)');
  turnFor(s, 0);
  give(s, 0, { coffee: 12 });
  act(s, { type: 'upgrade', crew: 'c0-1' });
  assert.equal(E.crewById(s, 'c0-1').badge, 'AAA');
  assert.equal(s.players[0].boxes, k.SUPPLY.BOXES_PER_PLAYER - 1);
  assert.equal(s.players[0].hats, k.SUPPLY.HATS_PER_PLAYER - 1, 'the AAA keeps its hat (R12.1)');
  turnFor(s, 0);
  give(s, 0, { coffee: 12 });
  refused(s, { type: 'upgrade', crew: 'c0-1' }, /already AAA/);
  put(s, 'c0-2', 'main-hall', 'VIP');
  put(s, 'c0-3', 'main-hall', 'VIP');
  assert.equal(s.players[0].hats, 0);
  refused(s, { type: 'upgrade', crew: 'c0-2' }, /no AAA box/);
  put(s, 'c0-4', 'main-hall');
  refused(s, { type: 'upgrade', crew: 'c0-4' }, new RegExp(`no VIP hat left in your supply: all ${k.SUPPLY.HATS_PER_PLAYER} are on your Crew`));
  give(s, 0, { coffee: 1 });
  refused(s, { type: 'upgrade', crew: 'c0-4' }, new RegExp(`Upgrade Crew costs ${k.COSTS.COST_UPGRADE} coffee and you have 1`));
});

check('R12.4, R9.5: upgrading works in a full hall (it adds no Crew)', () => {
  const s = game(2);
  clear(s);
  const C = E.capacity(s);
  put(s, 'c0-1', 'main-hall');
  fill(s, 'main-hall', C - 1);
  assert.ok(E.isFull(s, 'main-hall'));
  give(s, 0, { coffee: 12 });
  assert.equal(E.getBlockReason(s, { type: 'upgrade', crew: 'c0-1' }), null);
});

check('R13.1-R13.3: Volunteer costs coffee, goes on an empty space of any hall, stays, and the supply is limited', () => {
  const s = game(2);
  clear(s);
  const k = K(s);
  give(s, 0, { coffee: 12 });
  assert.equal(legal(s, 'volunteer').length, k.BOARD.VOLUNTEER_SPACES, 'every one of the 30 spaces is offered');
  act(s, { type: 'volunteer', space: 'security-photo-ops' });
  assert.equal(s.volunteers['security-photo-ops'], 0);
  assert.equal(s.players[0].coffee, 12 - k.COSTS.COST_VOLUNTEER);
  assert.equal(s.players[0].volunteers, k.SUPPLY.VOLUNTEERS_PER_PLAYER - 1);
  give(s, 1, { coffee: 12 });
  refused(s, { type: 'volunteer', space: 'security-photo-ops' }, /Security space in Photo Ops already holds Player 1's Volunteer/);
  assert.ok(!legal(s, 'volunteer').some((a) => a.space === 'security-photo-ops'));
  s.players[1].volunteers = 0;
  refused(s, { type: 'volunteer', space: 'rope_03' }, new RegExp(`All ${k.SUPPLY.VOLUNTEERS_PER_PLAYER} of your Volunteers are on the board`));
});

check('R13.7.1-R13.7.3: an Usher is in both halls its rope touches; adjacency and pair matching of Volunteers', () => {
  const s = game(2);
  clear(s);
  vol(s, ROPE['main-hall|entrance'], 0);
  assert.equal(E.volunteersInHall(s, 0, 'main-hall'), 1);
  assert.equal(E.volunteersInHall(s, 0, 'entrance'), 1);
  assert.equal(E.volunteersInHall(s, 0, 'photo-ops'), 0);
  vol(s, ROPE['photo-ops|entrance'], 0); // touches the Entrance too: adjacent to rope_09
  vol(s, ROPE['artist-alley|main-stage'], 0); // far from both
  assert.equal(E.countAchievement(s, 0, 'scoring_08').count, 1);
  vol(s, ROPE['entrance|food-trucks'], 0); // a chain of three around the Entrance: still one pair
  assert.equal(E.countAchievement(s, 0, 'scoring_08').count, 1, 'three mutually adjacent + one far = 1 pair (a maximum matching)');
  vol(s, ROPE['artist-alley|autograph-hall'], 0); // touches Artist Alley like rope_01: a second pair
  assert.equal(E.countAchievement(s, 0, 'scoring_08').count, 2);
});

// ---------------------------------------------------------------------------------------------
// R14, R15
// ---------------------------------------------------------------------------------------------

check('R14: Take a Selfie costs coffee, needs a Crew in the hall of a figure, one action per figure, colour of the figure', () => {
  const s = game(3);
  clear(s);
  const k = K(s);
  const figs = E.figuresOnBoard(s);
  assert.equal(figs.length, 3);
  assert.equal(legal(s, 'takeSelfie').length, 0, 'no Crew in a celebrity hall, nothing to take');
  refused(s, { type: 'takeSelfie', celebrity: figs[0].card }, /You have no Crew in .*, where .* stands/);
  putNext(s, 0, figs[0].figure);
  putNext(s, 0, figs[0].figure);
  const before = { ...s.players[0].selfies };
  const coffee = s.players[0].coffee;
  act(s, { type: 'takeSelfie', celebrity: figs[0].card });
  assert.equal(s.players[0].selfies[figs[0].colour], before[figs[0].colour] + k.COSTS.SELFIE_GAIN_TAKE_SELFIE, 'one selfie however many Crew are there');
  assert.equal(s.players[0].coffee, coffee - k.COSTS.COST_TAKE_SELFIE);
  // two figures in one hall (R5.6, Q28) = one action per figure
  const s2 = game(3);
  clear(s2);
  const [a, b] = E.figuresOnBoard(s2);
  b.figure = a.figure;
  putNext(s2, 0, a.figure);
  const expected = E.figuresOnBoard(s2).filter((f) => f.figure === a.figure).map((f) => f.card).sort();
  assert.ok(expected.length >= 2);
  assert.deepEqual(legal(s2, 'takeSelfie').map((x) => x.celebrity).sort(), expected);
});

check("R15.2-R15.5: the Selfie Exchange E1, E2, E3; free, repeatable, in the player's own window", () => {
  const s = game(3);
  const k = K(s);
  give(s, 0, { coffee: 4, selfies: { green: 3, red: 3, orange: 3 } });
  act(s, { type: 'exchange', rate: 'E1', pay: { green: 1, red: 1, orange: 0 }, gain: null });
  assert.equal(s.players[0].coffee, 4 + k.EXCHANGE.EXCHANGE_E1.GAIN_COFFEE);
  assert.equal(E.topFrame(s).kind, 'turn', 'a conversion keeps the turn (R15.5)');
  refused(s, { type: 'exchange', rate: 'E2', pay: { green: 1, red: 1, orange: 0 }, gain: 'red' }, /different from each Selfie you pay/);
  act(s, { type: 'exchange', rate: 'E2', pay: { green: 2, red: 0, orange: 0 }, gain: 'orange' });
  assert.deepEqual(s.players[0].selfies, { green: 0, red: 2, orange: 4 });
  const ev = act(s, { type: 'exchange', rate: 'E3', pay: { green: 0, red: 2, orange: 2 }, gain: null });
  assert.equal(s.players[0].vp, k.EXCHANGE.EXCHANGE_E3.GAIN_VP);
  assert.equal(vpOf(ev, 0, 'exchange'), k.EXCHANGE.EXCHANGE_E3.GAIN_VP);
  give(s, 0, { coffee: k.LIMITS.COFFEE_CAP, selfies: { green: 2 } });
  refused(s, { type: 'exchange', rate: 'E1', pay: { green: 2, red: 0, orange: 0 }, gain: null }, /on 12 coffee/);
  give(s, 1, { selfies: { green: 3, red: 3 } });
  refused(s, { type: 'exchange', rate: 'E3', pay: { green: 2, red: 2, orange: 0 }, gain: null, player: 1 }, /It is .*'s decision/);
});

// ---------------------------------------------------------------------------------------------
// R16 market, R8 costs, R7 income
// ---------------------------------------------------------------------------------------------

check('R16.1-R16.6: Swag costs selfies of its own colour and no coffee; the card is replaced; a dry deck reshuffles the discard', () => {
  const s = game(3);
  const k = K(s);
  const card = 'swag_green_02'; // Teleport, a card that gives no coffee
  const cost = k.SWAG.SWAG_COST[card];
  const colour = E.SWAG_CARDS.find((c) => c.id === card).colour;
  const other = E.COLOURS.find((c) => c !== colour);
  // stock it
  const old = s.swag.market[0];
  const at = s.swag.deck.indexOf(card);
  if (at >= 0) s.swag.deck[at] = old;
  s.swag.market[0] = card;
  give(s, 0, { coffee: 3, selfies: { [other]: 9, [colour]: cost - 1 } });
  refused(s, { type: 'buySwag', card }, new RegExp(`Teleport costs ${cost} ${colour} Selfies and you have ${cost - 1}`));
  s.players[0].selfies[colour] = cost + 1;
  const deckBefore = s.swag.deck.length;
  act(s, { type: 'buySwag', card });
  assert.equal(s.players[0].coffee, 3, 'costs no coffee (R16.1)');
  assert.equal(s.players[0].selfies[colour], 1, 'paid in its own colour only');
  assert.equal(s.players[0].selfies[other], 9);
  assert.ok(s.swag.discard.includes(card), 'the card goes to the Swag discard (R16.5)');
  assert.notEqual(s.swag.market[0], card, 'and is replaced');
  assert.equal(s.swag.deck.length, deckBefore - 1);
  // a dry deck: the discard pile (including the card just used) becomes the new deck
  const t = game(3);
  t.swag.discard.push(...t.swag.deck);
  t.swag.deck = [];
  const first = t.swag.market[0];
  const def = E.SWAG_CARDS.find((c) => c.id === first);
  give(t, 0, { selfies: { [def.colour]: 9 } });
  const ev = act(t, { type: 'buySwag', card: first });
  assert.ok(only(ev, E.EVENTS.DECK_RESHUFFLED).some((e) => e.deck === 'swag'));
  assert.equal(t.swag.deck.length + t.swag.discard.length + t.swag.market.filter((x) => x !== null).length, K(t).BOARD.SWAG_CARDS);
  assert.ok(t.swag.market.every((x) => x !== null));
});

check('R8.5, R8.6: no debt, and the first failing condition is the reason', () => {
  const s = game(2);
  clear(s);
  put(s, 'c0-1', 'main-hall');
  give(s, 0, { coffee: 0 });
  assert.equal(legal(s, 'move2').length, 0);
  assert.equal(legal(s, 'upgrade').length, 0);
  assert.equal(legal(s, 'volunteer').length, 0);
  assert.equal(legal(s, 'pass').length, 1, 'Pass is always offered');
  refused(s, { type: 'move2', crew: 'c0-1', to: 'main-stage' }, new RegExp(`Move 2 costs ${K(s).COSTS.COST_MOVE_2} coffee and you have 0`));
});

check('R7.2, R7.3: Coffee Break income is the celebrity coffee value (Hour 5: both cards), capped at 12', () => {
  const s = game(2);
  const k = K(s);
  clear(s);
  give(s, 0, { coffee: 0 });
  give(s, 1, { coffee: 11 });
  const events = passAll(s);
  assert.equal(s.hour, 2);
  const gains = only(events, E.EVENTS.COFFEE_GAIN).filter((e) => e.cause === 'coffee-break');
  assert.equal(gains.length, 2);
  const income = k.CELEBRITIES.CELEBRITIES[E.scheduleSlot(s, '2').card].COFFEE;
  for (const g of gains) assert.equal(g.amount + g.lost, income, 'everyone is offered the celebrity value; the cap decides what is kept');
  for (const p of s.players) assert.ok(p.coffee <= k.LIMITS.COFFEE_CAP);
  const cap = gains.find((g) => g.player === 1);
  assert.equal(cap.lost, income, 'a player already on 12 loses the lot');
  const sum = k.CELEBRITIES.CELEBRITIES[E.scheduleSlot(s, '5a').card].COFFEE + k.CELEBRITIES.CELEBRITIES[E.scheduleSlot(s, '5b').card].COFFEE;
  assert.equal(E.hourIncome(s, 5), sum, 'Hour 5 is the sum of both C cards (R7.2)');
});

check('R8.9: after the main-action safety limit only Pass is offered, and the game is flagged turnCapped', () => {
  const limit = 3;
  const s = game(2, { constants: { SAFETY: { MAX_MAIN_ACTIONS_PER_PLAYER_PER_HOUR: limit } } });
  clear(s);
  put(s, 'c0-1', 'main-hall');
  give(s, 0, { coffee: 12 });
  const halls = ['main-stage', 'main-hall', 'main-stage'];
  for (let i = 0; i < limit; i++) {
    turnFor(s, 0);
    act(s, { type: 'move2', crew: 'c0-1', to: halls[i] });
  }
  assert.equal(s.flags.turnCapped, true);
  turnFor(s, 0);
  assert.deepEqual(E.getValidActions(s).filter((a) => E.MAIN_ACTION_TYPES.includes(a.type)).map((a) => a.type), ['pass']);
  refused(s, { type: 'move2', crew: 'c0-1', to: 'main-hall' }, new RegExp(`You have taken ${limit} main actions this Hour`));
});

// ---------------------------------------------------------------------------------------------
// R18: passing
// ---------------------------------------------------------------------------------------------

check('R18.2-R18.4: first pass +2 coffee and the Achievement choice, then the ladder (coffee or VP) with slot 4 repeating', () => {
  const s = game(3);
  const k = K(s);
  give(s, 0, { coffee: 5 });
  const hand0 = s.players[0].hand.slice();
  act(s, { type: 'pass' });
  assert.equal(s.players[0].coffee, 5 + k.PASS.PASS_FIRST_PASSER_COFFEE, 'first passer (R18.2.2)');
  assert.equal(E.topFrame(s).kind, 'passAchievement');
  act(s, { type: 'discardAchievement', card: hand0[0] });
  assert.equal(s.players[0].coffee, 5 + k.PASS.PASS_FIRST_PASSER_COFFEE + k.PASS.PASS_DISCARD_COFFEE);
  assert.equal(s.players[0].hand.length, k.START.START_ACHIEVEMENTS, 'drew a replacement (R18.2.4)');
  assert.equal(s.players[0].passSlot, 1);
  const c1 = s.players[1].coffee;
  act(s, { type: 'pass' });
  assert.equal(s.players[1].coffee, c1, 'only the first passer gets coffee');
  act(s, { type: 'scoreAchievement', card: s.players[1].hand[0] });
  const ladder = [];
  for (let round = 0; round < 4; round++) {
    give(s, 2, { coffee: 12 });
    act(s, { type: 'volunteer', space: `rope_0${round + 1}` });
    assert.equal(s.toAct, 0);
    refused(s, { type: 'move2', crew: E.crewOnBoard(s, 0)[0].id, to: 'main-hall' }, /You have passed this Hour/);
    const before = s.players[0].vp;
    act(s, { type: 'passReward', reward: 'vp' });
    ladder.push(s.players[0].vp - before);
    act(s, { type: 'passReward', reward: 'vp' }); // seat 1
  }
  assert.deepEqual(ladder, [2, 3, 4, 4].map((slot) => k.PASS.PASS_SLOT_REWARD[slot]));
  assert.equal(s.players[0].passSlot, k.PASS.PASS_SLOTS);
});

check('R18.2.3, R18.2.4: Hour 5 pass still forces the Achievement choice but draws nothing', () => {
  const s = game(2);
  s.hour = 5;
  const k = K(s);
  const before = s.achievements.deck.length;
  const hand = s.players[0].hand.slice();
  act(s, { type: 'pass' });
  act(s, { type: 'discardAchievement', card: hand[0] });
  assert.equal(s.players[0].hand.length, k.START.START_ACHIEVEMENTS - 1);
  assert.equal(s.achievements.deck.length, before);
});

check('R18.4.1: the coffee reward is not offered on 12 coffee (every-gain)', () => {
  const s = game(3);
  act(s, { type: 'pass' });
  act(s, { type: 'discardAchievement', card: s.players[0].hand[0] });
  act(s, { type: 'pass' });
  act(s, { type: 'discardAchievement', card: s.players[1].hand[0] });
  give(s, 2, { coffee: 12 });
  act(s, { type: 'volunteer', space: 'rope_01' });
  give(s, 0, { coffee: K(s).LIMITS.COFFEE_CAP });
  assert.deepEqual(legal(s, 'passReward').map((a) => a.reward), ['vp']);
  refused(s, { type: 'passReward', reward: 'coffee' }, /on 12 coffee/);
});

check('R19.8: an empty Achievement deck is rebuilt from the discard pile', () => {
  const s = game(2);
  const ach = s.achievements;
  ach.discard.push(...ach.deck.map((card) => ({ card, owner: 0, scored: true })));
  ach.deck = [];
  const total = ach.discard.length;
  act(s, { type: 'pass' });
  const ev = act(s, { type: 'discardAchievement', card: s.players[0].hand[0] });
  assert.ok(only(ev, E.EVENTS.DECK_RESHUFFLED).some((e) => e.deck === 'achievement'));
  assert.equal(s.players[0].hand.length, K(s).START.START_ACHIEVEMENTS);
  assert.equal(s.achievements.deck.length, total, 'the pile (with the card just discarded) became the deck; one was drawn');
  assert.equal(s.achievements.discard.length, 0);
});

check('R6.3, R6.4, R8.2: the First Player marker passes clockwise after Hours 1-4 (not after 5); per-Hour state resets; the phase ends at the last pass', () => {
  const s = game(3);
  const k = K(s);
  const first = [];
  for (let hour = 1; hour <= 4; hour++) {
    assert.equal(s.hour, hour);
    first.push(s.firstPlayer);
    assert.equal(s.toAct, s.firstPlayer, 'the first player acts first (R8.1)');
    const ev = passAll(s);
    assert.equal(only(ev, E.EVENTS.FIRST_PLAYER_MOVED).length, 1);
    assert.equal(s.hour, hour + 1);
    for (const p of s.players) {
      assert.equal(p.passSlot, 0, 'pass markers are back (R6.4)');
      assert.equal(p.mainActionsThisHour, 0);
    }
    assert.deepEqual(s.hourState, { firstPasser: null, passOrder: [] });
  }
  assert.deepEqual(first, [0, 1, 2, 0], 'seat (start + hour - 1) mod n (R6.3)');
  assert.equal(s.hour, k.GAME.HOURS);
  assert.equal(s.firstPlayer, 1);
  const ev = passAll(s);
  assert.equal(only(ev, E.EVENTS.FIRST_PLAYER_MOVED).length, 0, 'the marker does not pass after Hour 5');
  assert.equal(s.firstPlayer, 1);
  assert.equal(E.topFrame(s).kind, 'finalWindow');
});

// ---------------------------------------------------------------------------------------------
// R20, R21: the Walk and destination scoring
// ---------------------------------------------------------------------------------------------

/** Plays Hour 1's walk with the given celebrity in slot 1 and the layout the callback builds. */
function walkWith(cardId, setup, n = 3, o = {}) {
  const s = game(n, o);
  clear(s);
  setCelebrity(s, '1', cardId);
  const entry = E.scheduleSlot(s, '1');
  setup(s, entry);
  const events = passAll(s);
  const scored = only(events, E.EVENTS.CELEBRITY_SCORED).find((e) => e.slot === '1');
  return { s, events, scored, entry };
}

check('R20.2, R20.3: the Walk enters every hall of the route after the start; Prime Position then Photographer get selfies of the colour', () => {
  const { events, entry, s } = walkWith('character_mando_03', (st) => {
    // Pedro Daddy: artist-alley > autograph-hall > photo-ops
    put(st, 'c0-1', 'autograph-hall');
    put(st, 'c1-1', 'autograph-hall');
    put(st, 'c1-2', 'photo-ops');
    vol(st, 'photographer-autograph-hall', 0);
    vol(st, 'photographer-photo-ops', 1);
    vol(st, 'photographer-artist-alley', 2); // the START hall is not entered
  });
  const entered = only(events, E.EVENTS.CELEBRITY_ENTERED).filter((e) => e.slot === '1').map((e) => e.hall);
  assert.deepEqual(entered, ['autograph-hall', 'photo-ops']);
  const gains = only(events, E.EVENTS.SELFIE_GAIN).filter((e) => e.cause.startsWith('walk-') && e.detail.celebrity === 'character_mando_03');
  const sum = (seat, cause) => gains.filter((g) => g.player === seat && g.cause === cause).reduce((a, g) => a + g.gain[entry.colour], 0);
  assert.equal(sum(0, 'walk-prime'), K(s).WALK.WALK_SELFIES_PRIME_POSITION, 'seat 0 is first in Autograph Hall');
  assert.equal(sum(0, 'walk-photographer'), K(s).WALK.WALK_SELFIES_PHOTOGRAPHER);
  assert.equal(sum(1, 'walk-prime'), K(s).WALK.WALK_SELFIES_PRIME_POSITION, 'seat 1 is first in Photo Ops (destination)');
  assert.equal(sum(1, 'walk-photographer'), K(s).WALK.WALK_SELFIES_PHOTOGRAPHER);
  assert.equal(sum(2, 'walk-photographer'), 0, 'a Photographer in the start hall earns nothing');
  assert.ok(gains.every((g) => Object.entries(g.gain).every(([c, n]) => n === 0 || c === entry.colour)), 'selfies are of the celebrity colour only (R4.3.4)');
  assert.deepEqual(gains.filter((g) => g.detail.hall === 'autograph-hall').map((g) => g.cause), ['walk-prime', 'walk-photographer'], 'Prime Position first, then Photographer (R20.3)');
  assert.equal(entry.status, 'done');
  const next = E.scheduleSlot(s, '4');
  assert.equal(next.status, 'onBoard', 'the Hour 4 celebrity is placed (R20.5)');
  assert.equal(next.colour, entry.colour, 'in the colour just freed (R4.3.2)');
});

check('R21.2: each scoring method pays by its formula (everyone, by-badge, no-n00bs, in-order, in-order-no-n00bs, count-total)', () => {
  // queue: AAA c2-1, VIP c0-1, VIP c1-1, N00b c1-2, N00b c0-2
  const layout = (s, destination) => {
    put(s, 'c2-1', destination, 'AAA');
    put(s, 'c0-1', destination, 'VIP');
    put(s, 'c1-1', destination, 'VIP');
    put(s, 'c1-2', destination);
    put(s, 'c0-2', destination);
  };
  const byMethod = {};
  for (const card of E.CELEBRITY_CARDS) if (!byMethod[card.scoring.method]) byMethod[card.scoring.method] = card.id;
  assert.equal(Object.keys(byMethod).length, 6, 'all six methods exist');
  for (const [method, id] of Object.entries(byMethod)) {
    const card = E.celebrityCard(id);
    const { scored, s } = walkWith(id, (st) => layout(st, card.destination));
    const v = K(s).CELEBRITIES.CELEBRITIES[id].VALUES;
    const badge = ['AAA', 'VIP', 'VIP', 'N00b', 'N00b'];
    const expected = badge.map((b, i) => {
      switch (method) {
        case 'everyone': return v[0];
        case 'by-badge': return b === 'AAA' ? v[2] : b === 'VIP' ? v[1] : v[0];
        case 'everyone-no-n00bs': return b === 'N00b' ? 0 : v[0];
        case 'in-order': return v[i] ?? 0;
        case 'in-order-no-n00bs': return b === 'N00b' ? 0 : v[i]; // the three non-N00b are positions 1-3
        case 'count-total': {
          const [b1, b2] = K(s).CELEBRITIES.COUNT_TOTAL_BANDS;
          return 5 <= b1 ? v[0] : 5 <= b2 ? v[1] : v[2];
        }
        default: throw new Error(method);
      }
    });
    assert.deepEqual(scored.payouts.map((p) => p.vp), expected, `${method} (${id})`);
    assert.equal(scored.method, method);
    const bySeat = [0, 0, 0];
    scored.payouts.forEach((p) => (bySeat[p.player] += p.vp));
    assert.deepEqual(scored.totals, bySeat);
    for (let seat = 0; seat < 3; seat++) assert.equal(s.players[seat].vpBySource.celebrity, bySeat[seat], `${method}: VP by source (R22.7)`);
  }
});

check('R21.1, R21.3: an empty destination pays nothing; positions beyond the list score 0', () => {
  const { scored } = walkWith('character_mando_03', () => {});
  assert.deepEqual(scored.payouts, []);
  const s = game(4, { variants: { queueCapacity: 'rulebook' } });
  clear(s);
  setCelebrity(s, '1', 'character_who_03'); // Score in Order, 7 values
  const dest = E.celebrityCard('character_who_03').destination;
  fill(s, dest, 8);
  const events = passAll(s);
  const sc = only(events, E.EVENTS.CELEBRITY_SCORED).find((e) => e.slot === '1');
  assert.equal(sc.payouts.length, 8);
  assert.equal(sc.payouts[7].vp, 0);
  assert.equal(sc.payouts[6].vp, K(s).CELEBRITIES.CELEBRITIES.character_who_03.VALUES[6]);
});

check('R20.6: Hour 5 - 5a and 5b advance together, 5a first; each destination then scores, 5a first; the figures stay', () => {
  const s = game(2);
  clear(s);
  toHour5(s, 0);
  setCelebrity(s, '5a', 'character_mando_01'); // 5 halls entered
  setCelebrity(s, '5b', 'character_tng_01'); // 6
  const a = E.celebrityCard('character_mando_01');
  const b = E.celebrityCard('character_tng_01');
  put(s, 'c0-1', a.destination);
  put(s, 'c1-1', b.destination);
  const events = passAll(s);
  const slots = only(events, E.EVENTS.CELEBRITY_ENTERED).map((e) => e.slot);
  assert.deepEqual(slots.slice(0, 10), ['5a', '5b', '5a', '5b', '5a', '5b', '5a', '5b', '5a', '5b']);
  assert.equal(slots.length, a.route.length - 1 + (b.route.length - 1));
  assert.deepEqual(slots.slice(10), ['5b'], '5b walks on alone once 5a has arrived');
  assert.deepEqual(only(events, E.EVENTS.CELEBRITY_SCORED).map((e) => e.slot), ['5a', '5b']);
  assert.equal(E.scheduleSlot(s, '5a').status, 'onBoard');
  assert.equal(E.scheduleSlot(s, '5a').figure, a.destination, 'figures stay for final scoring (R20.6)');
  assert.equal(E.topFrame(s).kind, 'finalWindow');
});

// ---------------------------------------------------------------------------------------------
// R22: the end
// ---------------------------------------------------------------------------------------------

check('R22.1-R22.4, R22.6: final windows in turn order, the best last Achievement x3, leftover selfies 4 for 2 VP, ties from the Hour 5 first player', () => {
  const s = game(3);
  clear(s);
  const k = K(s);
  put(s, 'c0-1', 'main-hall');
  put(s, 'c0-2', 'main-hall');
  put(s, 'c0-3', 'entrance');
  put(s, 'c1-1', 'main-stage');
  put(s, 'c2-1', 'main-stage');
  // Party (2 per Crew) and Spread Out (2 per hall): seat 0 holds both after the pass discard (the Achiever case)
  setHand(s, 0, ['scoring_36', 'scoring_07', 'scoring_11']);
  setHand(s, 1, ['scoring_32', 'scoring_16']);
  setHand(s, 2, ['scoring_33', 'scoring_19']);
  for (const p of s.players) give(s, p.seat, { selfies: { green: 3, red: 3, orange: 3 } });
  toHour5(s, 1);
  const flowEvents = passAll(s);
  assert.equal(E.topFrame(s).kind, 'finalWindow');
  const before = s.players.map((p) => ({ selfies: { ...p.selfies }, vp: p.vp }));
  const beforeCounts = {
    party: E.countAchievement(s, 0, 'scoring_11').count,
    spread: E.countAchievement(s, 0, 'scoring_07').count,
  };
  const ev = [];
  const windows = [];
  while (!E.isGameOver(s)) {
    const top = E.topFrame(s);
    assert.equal(top.kind, 'finalWindow');
    windows.push(top.player);
    ev.push(...act(s, { type: 'endConversions' }));
  }
  void flowEvents;
  assert.deepEqual(windows, [1, 2, 0], 'windows in turn order from the Hour 5 first player (R22.1)');
  const finals = only(ev, E.EVENTS.ACHIEVEMENT_SCORED).filter((e) => e.when === 'final');
  const mine = finals.filter((e) => e.player === 0);
  assert.equal(mine.length, 2);
  const party = mine.find((e) => e.card === 'scoring_11');
  const spread = mine.find((e) => e.card === 'scoring_07');
  assert.equal(party.vp, beforeCounts.party * k.ACHIEVEMENTS.ACHIEVEMENT_LAUREL.scoring_11 * k.ACHIEVEMENTS.ACHIEVEMENT_FINAL_MULTIPLIER);
  assert.equal(party.multiplier, k.ACHIEVEMENTS.ACHIEVEMENT_FINAL_MULTIPLIER);
  assert.equal(party.tripled, true);
  assert.equal(spread.multiplier, k.ACHIEVEMENTS.ACHIEVEMENT_OTHER_MULTIPLIER, 'the other card scores x1');
  assert.equal(spread.vp, beforeCounts.spread * k.ACHIEVEMENTS.ACHIEVEMENT_LAUREL.scoring_07);
  for (const p of s.players) {
    const total = before[p.seat].selfies.green + before[p.seat].selfies.red + before[p.seat].selfies.orange;
    assert.equal(vpOf(ev, p.seat, 'final-selfies'), Math.floor(total / k.FINAL.FINAL_SELFIES_PER_EXCHANGE) * k.FINAL.FINAL_VP_PER_EXCHANGE, `seat ${p.seat} leftover selfies`);
    assert.equal(E.selfieTotal(p.selfies), total % k.FINAL.FINAL_SELFIES_PER_EXCHANGE, 'fewer than 4 left over score nothing');
  }
  const sc = E.scoreGame(s);
  assert.equal(sc.final, true);
  assert.equal(sc.winner, sc.order[0]);
  // R22.6 tie-break: with equal VP the order starts at the Hour 5 first player (seat 1) and runs clockwise
  const tie = E.cloneState(s);
  for (const p of tie.players) p.vp = 10;
  const t = E.scoreGame(tie);
  assert.deepEqual(t.order, [1, 2, 0]);
  assert.deepEqual(t.sharedTop.slice().sort(), [0, 1, 2]);
  assert.deepEqual(t.players.map((p) => p.rank), [3, 1, 2]);
  assert.deepEqual(t.players.map((p) => p.vpRank), [1, 1, 1]);
});

// ---------------------------------------------------------------------------------------------
// R26: variants
// ---------------------------------------------------------------------------------------------

check('R4.3, R4.3.5, R26 celebrityColours: random-slots gives each colour exactly twice; fixed-slots is green, red, orange', () => {
  for (let i = 0; i < 40; i++) {
    const s = game(2 + (i % 4), { variants: { celebrityColours: 'random-slots' }, seed: `col-${i}`, anySeat: true });
    const count = {};
    for (const e of s.schedule) count[e.colour] = (count[e.colour] ?? 0) + 1;
    assert.deepEqual(Object.values(count), [2, 2, 2]);
    const same = (a, b) => assert.equal(E.scheduleSlot(s, a).colour, E.scheduleSlot(s, b).colour);
    same('1', '4');
    same('2', '5a');
    same('3', '5b');
  }
  const f = game(3, { variants: { celebrityColours: 'fixed-slots' } });
  assert.deepEqual(f.schedule.map((e) => e.colour), ['green', 'red', 'orange', 'green', 'red', 'orange']);
});

check('R7.3, R26 coffeeCap: coffee-break-only lets other gains go above 12, the Coffee Break never does', () => {
  const s = game(2, { variants: { coffeeCap: 'coffee-break-only' } });
  const cap = K(s).LIMITS.COFFEE_CAP;
  give(s, 0, { coffee: cap, selfies: { green: 2 } });
  act(s, { type: 'exchange', rate: 'E1', pay: { green: 2, red: 0, orange: 0 }, gain: null }); // allowed: it changes something (R26.3)
  assert.equal(s.players[0].coffee, cap + K(s).EXCHANGE.EXCHANGE_E1.GAIN_COFFEE);
  assert.equal(E.coffeeRoom(s, 0, true), 0, 'the Coffee Break tops up to 12, never above');
  assert.equal(E.coffeeRoom(s, 0, false), Infinity);
  const t = game(2);
  give(t, 0, { coffee: cap, selfies: { green: 2 } });
  refused(t, { type: 'exchange', rate: 'E1', pay: { green: 2, red: 0, orange: 0 }, gain: null }, /on 12 coffee/);
});

check('R5.9.1, R26 fivePlayerOpening: fallback places the overflow like New N00b Crew, one decision each, in opening order', () => {
  for (const [n, queueCapacity] of [[4, 'printed-board'], [5, 'printed-board'], [5, 'rulebook'], [3, 'printed-board']]) {
    const s = game(n, { variants: { fivePlayerOpening: 'fallback', queueCapacity }, anySeat: true });
    const C = E.capacity(s);
    const total = n * K(s).START.OPENING_CREW_PER_PLAYER;
    const overflow = Math.max(0, total - C);
    assert.equal(E.hallCount(s, E.ENTRANCE), Math.min(total, C), `${n}p ${queueCapacity}: the Entrance is filled to capacity`);
    let placed = 0;
    while (s.phase === 'setup') {
      const top = E.topFrame(s);
      assert.equal(top.kind, 'openingPlacement');
      assert.equal(top.remaining, overflow - placed);
      const options = E.getValidActions(s);
      assert.ok(options.every((a) => a.type === 'placeOpeningCrew'));
      assert.deepEqual(options.map((a) => a.hall).sort(), ['food-trucks', 'main-hall', 'photo-ops']);
      act(s, options[0]);
      placed++;
    }
    assert.equal(placed, overflow);
    assert.equal(s.phase, 'floor');
    for (const p of s.players) assert.equal(E.crewOnBoard(s, p.seat).length, K(s).START.OPENING_CREW_PER_PLAYER, 'everyone has their two Crew out');
  }
});

check('R13.7.1, R26 usherInHall: neither - Ushers are in no hall for hall-based cards; pairs still use them', () => {
  const s = game(2, { variants: { usherInHall: 'neither' } });
  clear(s);
  vol(s, ROPE['main-hall|entrance'], 0);
  vol(s, ROPE['photo-ops|entrance'], 0);
  put(s, 'c0-1', 'entrance', 'VIP');
  assert.equal(E.volunteersInHall(s, 0, 'entrance'), 0);
  assert.equal(E.countAchievement(s, 0, 'scoring_30').count, 0, 'Obsessed ignores Ushers');
  assert.equal(E.countAchievement(s, 0, 'scoring_08').count, 1, 'Corridor pairs still count them');
  const t = game(2);
  clear(t);
  vol(t, ROPE['main-hall|entrance'], 0);
  put(t, 'c0-1', 'entrance', 'VIP');
  assert.equal(E.countAchievement(t, 0, 'scoring_30').count, 1);
});

check('R19.10 scoring_31, R26 homeBase: three-crew (3+ Crew and a Volunteer) or as-printed (the same as Obsessed)', () => {
  for (const [value, mixed] of [['three-crew', 0], ['as-printed', 1]]) {
    const s = game(2, { variants: { homeBase: value } });
    clear(s);
    put(s, 'c0-1', 'photo-ops', 'VIP');
    vol(s, 'security-photo-ops', 0);
    assert.equal(E.countAchievement(s, 0, 'scoring_31').count, mixed, `${value}: one VIP and a Volunteer`);
    put(s, 'c0-2', 'main-hall');
    put(s, 'c0-3', 'main-hall');
    put(s, 'c0-4', 'main-hall');
    vol(s, 'security-main-hall', 0);
    assert.equal(E.countAchievement(s, 0, 'scoring_31').count, mixed + (value === 'three-crew' ? 1 : 0), `${value}: plus three N00b and a Volunteer`);
  }
});

check('R16.8 swag_orange_07, R19.1, R22.3, R26 achiever: hand-size (+1 permanently) or draw-two-keep-one (a choice, no lasting size)', () => {
  const s = game(2);
  const P = K(s).SWAG.SWAG_PARAMS.swag_orange_07;
  const hand = s.players[0].hand.length;
  buy(s, 'swag_orange_07');
  assert.equal(s.players[0].handSize, K(s).LIMITS.ACHIEVEMENT_HAND_SIZE + P.HAND_BONUS);
  assert.equal(s.players[0].hand.length, hand + P.DRAW);
  const t = game(2, { variants: { achiever: 'draw-two-keep-one' } });
  buy(t, 'swag_orange_07');
  assert.equal(E.topFrame(t).kind, 'achieverKeep');
  assert.equal(E.topFrame(t).player, 0);
  const two = E.topFrame(t).cards.slice();
  assert.equal(two.length, P.DRAW_TWO);
  assert.deepEqual(E.getValidActions(t).map((a) => a.card).sort(), two.slice().sort());
  act(t, { type: 'keepAchievement', card: two[1] });
  assert.equal(t.players[0].hand.length, K(t).LIMITS.ACHIEVEMENT_HAND_SIZE + 1);
  assert.ok(t.players[0].hand.includes(two[1]) && !t.players[0].hand.includes(two[0]));
  assert.equal(t.players[0].handSize, K(t).LIMITS.ACHIEVEMENT_HAND_SIZE, 'no lasting effect on the nominal size (R26.2)');
  assert.ok(t.achievements.discard.some((d) => d.card === two[0] && d.scored === false), 'the other is discarded unscored (R19.7)');
});

check('R17.7, R26 clubHandLimits: on - a Meeple Militia / TCG Traders owner discards down at the end of their turn; off - no limit', () => {
  for (const [club, limitName] of [['club_06', 'CLUB_HAND_LIMIT_MILITIA'], ['club_07', 'CLUB_HAND_LIMIT_TCG']]) {
    const s = game(2, { variants: { clubHandLimits: 'on' }, clubs: [club, 'club_08'] });
    const limit = K(s).LIMITS[limitName];
    give(s, 0, { selfies: { green: limit, red: 5, orange: 3 } });
    act(s, { type: 'pass' });
    act(s, { type: 'discardAchievement', card: s.players[0].hand[0] });
    assert.equal(E.topFrame(s).kind, 'discardToLimit');
    assert.equal(E.topFrame(s).limit, limit);
    let guard = 0;
    while (E.topFrame(s) && E.topFrame(s).kind === 'discardToLimit') {
      const options = E.getValidActions(s);
      assert.ok(options.every((a) => a.type === 'discardSelfie'));
      assert.ok(E.selfieTotal(s.players[0].selfies) > limit);
      act(s, options[options.length - 1]);
      if (guard++ > 50) throw new Error('no end');
    }
    assert.equal(E.selfieTotal(s.players[0].selfies), limit);
    const off = game(2, { clubs: [club, 'club_08'] });
    give(off, 0, { selfies: { green: limit, red: 5, orange: 3 } });
    act(off, { type: 'pass' });
    act(off, { type: 'discardAchievement', card: off.players[0].hand[0] });
    assert.equal(E.topFrame(off).kind, 'turn');
    assert.ok(E.selfieTotal(off.players[0].selfies) > limit);
  }
});

check('R20.6, R22.3, R26 finalBoard: figures-removed clears the Hour 5 figures before final scoring; figures-stay keeps them', () => {
  for (const value of ['figures-stay', 'figures-removed']) {
    const s = game(2, { variants: { finalBoard: value } });
    clear(s);
    toHour5(s, 0);
    passAll(s);
    assert.equal(E.topFrame(s).kind, 'finalWindow');
    assert.equal(E.figuresOnBoard(s).length, value === 'figures-stay' ? 2 : 0, value);
    // Starstruck / Photo Op read the live board, so they see exactly what the variant leaves
    const destinations = E.figuresOnBoard(s).map((f) => f.figure);
    assert.equal(destinations.length, value === 'figures-stay' ? 2 : 0);
  }
});

check('R26 firstPlayer and clubs: random varies the first player; seat-0 fixes it; clubs off deals none; clubs random deals distinct Clubs', () => {
  const firsts = new Set();
  for (let i = 0; i < 40; i++) firsts.add(E.createGame({ playerCount: 4, variants: { clubs: 'random' } }, { seed: `fp-${i}` }).startPlayer);
  assert.ok(firsts.size > 1, 'random first player varies');
  assert.equal(E.createGame({ playerCount: 4, variants: { firstPlayer: 'seat-0' } }, { seed: 'fp-x' }).startPlayer, 0);
  const withClubs = E.createGame({ playerCount: 5 }, { seed: 'clubs-x' });
  const clubs = withClubs.players.map((p) => p.club);
  assert.equal(new Set(clubs).size, 5);
  assert.ok(clubs.every((c) => E.CLUB_CARDS.some((x) => x.id === c)));
  const none = game(3, { variants: { clubs: 'off' } });
  assert.ok(none.players.every((p) => p.club === null));
  assert.equal(legal(none, 'clubPower').length, 0);
  refused(none, { type: 'clubPower', option: 'use' }, /no Club card/);
});

if (failures > 0) {
  console.log(`rules: ${failures} failed, ${passes} passed`);
  process.exit(1);
}
console.log(`rules ok (${passes} checks)`);
