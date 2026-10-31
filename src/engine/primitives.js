// primitives.js - the small state changes every mutator and card effect is
// built from. Every change to coffee, selfies, Crew, Volunteers, Achievement
// hands and the Swag market goes through here, and each one emits its events,
// so the stats see every flow.
//
// Nothing here checks legality: callers have already asked the block-reason
// functions (legality.js). Nothing here may throw on a state the engine made.

import { getConstants } from './state.js';
import { emit, EVENTS } from './events.js';
import { ropeBetween, COLOURS, spaceById } from './board.js';
import { coffeeRoom, usherOwner } from './queries.js';
import { addVp } from './scoring.js';
import { shuffle } from './rng.js';

// ---------------------------------------------------------------------------
// Coffee and selfies
// ---------------------------------------------------------------------------

/** R8.5 - pays coffee. The caller has checked it can be paid. */
export function spendCoffee(state, seat, amount, cause) {
  if (amount <= 0) return;
  state.players[seat].coffee -= amount;
  emit({ type: EVENTS.COFFEE_SPEND, player: seat, amount, cause });
}

/**
 * R7.3 - gains coffee up to the cap. Emits even when nothing could be kept, so
 * the stats see the waste (`lost`). Returns the amount kept.
 */
export function gainCoffee(state, seat, amount, cause, { coffeeBreak = false, detail = null } = {}) {
  const room = coffeeRoom(state, seat, coffeeBreak);
  const kept = Math.min(Math.max(amount, 0), room);
  state.players[seat].coffee += kept;
  emit({ type: EVENTS.COFFEE_GAIN, player: seat, amount: kept, lost: Math.max(amount, 0) - kept, cause, detail });
  return kept;
}

/** R1.17 - "gain" adds to a holding (selfies have no limit, R15.1); "pay" below removes, in full or not at all. Gains selfies `{ green, red, orange }`. */
export function gainSelfies(state, seat, gain, cause, detail = null) {
  const s = state.players[seat].selfies;
  for (const c of COLOURS) s[c] += gain[c];
  emit({ type: EVENTS.SELFIE_GAIN, player: seat, gain: { ...gain }, cause, detail });
}

/** Pays selfies `{ green, red, orange }`. The caller has checked they are held. */
export function spendSelfies(state, seat, pay, cause) {
  const s = state.players[seat].selfies;
  for (const c of COLOURS) s[c] -= pay[c];
  emit({ type: EVENTS.SELFIE_SPEND, player: seat, pay: { ...pay }, cause });
}

/** `{ green, red, orange }` with `n` of one colour. */
export function oneSelfie(colour, n = 1) {
  const g = { green: 0, red: 0, orange: 0 };
  g[colour] = n;
  return g;
}

// ---------------------------------------------------------------------------
// Crew
// ---------------------------------------------------------------------------

/** R9.2 - places a Crew into a hall with a new arrival stamp. R1.7: a Crew on the board never returns to supply (no function here removes one). */
export function placeCrew(state, crew, hall, cause) {
  crew.hall = hall;
  crew.stamp = state.nextStamp++;
  emit({ type: EVENTS.CREW_PLACED, player: crew.owner, crew: crew.id, hall, badge: crew.badge, stamp: crew.stamp, cause });
}

/**
 * R10.1-R10.4 - moves a Crew along a path of steps (path[0] = where it is).
 * The Usher bonus is paid at each crossing, before the next step, when the
 * mover moves their own Crew across their own Usher. New stamp on arrival.
 */
export function moveCrewAlong(state, crew, path, mover, cause) {
  const K = getConstants(state);
  let crossed = 0;
  let paid = 0;
  for (let i = 1; i < path.length; i++) {
    const rope = ropeBetween(path[i - 1], path[i]);
    const owner = usherOwner(state, rope);
    if (owner !== null) crossed++;
    if (owner !== null && owner === mover && crew.owner === mover) {
      paid++;
      gainCoffee(state, mover, K.MOVEMENT.USHER_COFFEE_PER_CROSSING, 'usher', { detail: { rope, crew: crew.id } });
    }
  }
  const from = crew.hall;
  crew.hall = path[path.length - 1];
  crew.stamp = state.nextStamp++;
  emit({
    type: EVENTS.CREW_MOVED,
    player: mover,
    owner: crew.owner,
    crew: crew.id,
    from,
    to: crew.hall,
    path: path.slice(),
    ushersCrossed: crossed,
    ushersPaid: paid,
    jump: false,
    cause,
  });
}

/** R10.3 - arrival: the Crew joins the destination queue with a new stamp, at the back of its badge class. R16.4.3 - a jump: no path, no rope crossed, no Usher bonus. New stamp on arrival (R16.4.4). */
export function jumpCrew(state, crew, to, mover, cause) {
  const from = crew.hall;
  crew.hall = to;
  crew.stamp = state.nextStamp++;
  emit({
    type: EVENTS.CREW_MOVED,
    player: mover,
    owner: crew.owner,
    crew: crew.id,
    from,
    to,
    path: [from, to],
    ushersCrossed: 0,
    ushersPaid: 0,
    jump: true,
    cause,
  });
}

/** The smallest arrival stamp among the Crew in a hall other than `except` (null when none). */
function minStampInHall(state, hall, except) {
  let min = null;
  for (const c of state.crew) {
    if (c.hall !== hall || c === except) continue;
    if (min === null || c.stamp < min) min = c.stamp;
  }
  return min;
}

/**
 * R16.4.6 (Fast Track, Priority) - gives a Crew in a hall an arrival stamp
 * earlier than every other Crew there. Queue order is still R9.1: it moves to
 * the front of its badge and Security standing, never past a higher badge.
 */
export function stampToFront(state, crew) {
  const min = minStampInHall(state, crew.hall, crew);
  if (min !== null && min <= crew.stamp) crew.stamp = min - 1;
}

/** R16.8 swag_orange_02 - two Crew swap arrival stamps and so change places. */
export function swapStamps(crewA, crewB) {
  const t = crewA.stamp;
  crewA.stamp = crewB.stamp;
  crewB.stamp = t;
}

/**
 * R12.1 - raises a Crew's badge one step (R12.3: badges are permanent - nothing here or anywhere lowers one, recovers a hat or the box, or moves a badge) (hat for N00b -> VIP, box for VIP ->
 * AAA), with a new arrival stamp (R12.2). The caller has checked the piece is
 * in supply.
 */
export function upgradeCrew(state, crew, cause) {
  const owner = state.players[crew.owner];
  const from = crew.badge;
  if (from === 'N00b') {
    owner.hats -= 1;
    crew.badge = 'VIP';
  } else {
    owner.boxes -= 1;
    crew.badge = 'AAA';
  }
  crew.stamp = state.nextStamp++;
  emit({ type: EVENTS.CREW_UPGRADED, player: crew.owner, crew: crew.id, hall: crew.hall, from, to: crew.badge, cause });
}

/**
 * R16.4.1, R17.6.1 - takes a Crew from supply, gives it a badge (using a hat,
 * or a hat and the box) and places it. Used by New N00b (no badge pieces),
 * Priority, Shared Ticket, Staff Line and Finer Things.
 */
export function placeNewCrew(state, seat, hall, badge, cause, { front = false } = {}) {
  const owner = state.players[seat];
  const crew = state.crew.find((c) => c.owner === seat && c.hall === null);
  if (badge === 'VIP' || badge === 'AAA') owner.hats -= 1;
  if (badge === 'AAA') owner.boxes -= 1;
  crew.badge = badge;
  placeCrew(state, crew, hall, cause);
  if (front) stampToFront(state, crew);
  return crew;
}

// ---------------------------------------------------------------------------
// Volunteers
// ---------------------------------------------------------------------------

/** R13.1 - places a Volunteer from supply on an empty space. R13.2: it stays for the rest of the game (only Player One Posse moves it); R13.3: it only ever works for its owner. */
export function placeVolunteer(state, seat, space, cause) {
  state.volunteers[space] = seat;
  state.players[seat].volunteers -= 1;
  emit({ type: EVENTS.VOLUNTEER_PLACED, player: seat, space, role: spaceById(space).role, cause });
}

/** R17.6.2 - moves a placed Volunteer to an empty space, where it takes that space's role. */
export function moveVolunteer(state, seat, from, to, cause) {
  state.volunteers[from] = null;
  state.volunteers[to] = seat;
  emit({ type: EVENTS.VOLUNTEER_MOVED, player: seat, from, to, role: spaceById(to).role, cause });
}

// ---------------------------------------------------------------------------
// Achievements
// ---------------------------------------------------------------------------

/** R19.8 - the top card of the Achievement deck (reshuffling the discard pile first if the deck is empty), or null. */
export function takeAchievementFromDeck(state) {
  const ach = state.achievements;
  if (ach.deck.length === 0 && ach.discard.length > 0) {
    ach.deck = shuffle(state.rng, ach.discard.map((d) => d.card));
    ach.discard = [];
    emit({ type: EVENTS.DECK_RESHUFFLED, deck: 'achievement', size: ach.deck.length });
  }
  return ach.deck.length === 0 ? null : ach.deck.pop();
}

/** R19.8 - draws one Achievement into a hand, reshuffling the discard if the deck is empty. */
export function drawAchievement(state, seat, cause) {
  const card = takeAchievementFromDeck(state);
  if (card === null) return null;
  state.players[seat].hand.push(card);
  emit({ type: EVENTS.ACHIEVEMENT_DRAWN, player: seat, card, cause, secret: true });
  return card;
}

/** R19.7 - discards an Achievement from a hand without scoring it: face down, secret. */
export function discardAchievementUnscored(state, seat, card, cause) {
  const p = state.players[seat];
  p.hand.splice(p.hand.indexOf(card), 1);
  state.achievements.discard.push({ card, owner: seat, scored: false });
  emit({ type: EVENTS.ACHIEVEMENT_DISCARDED, player: seat, card, cause, secret: true });
}

// ---------------------------------------------------------------------------
// The Swag market
// ---------------------------------------------------------------------------

/**
 * R16.5 - deals the top Swag card into an empty market slot; if the deck is
 * empty the discard pile (which already holds the card just used) is shuffled
 * into a new deck first; if there is still no card the slot stays empty.
 */
export function dealSwagSlot(state, slot) {
  const sw = state.swag;
  if (sw.deck.length === 0 && sw.discard.length > 0) {
    sw.deck = shuffle(state.rng, sw.discard.slice());
    sw.discard = [];
    emit({ type: EVENTS.DECK_RESHUFFLED, deck: 'swag', size: sw.deck.length });
  }
  const card = sw.deck.length > 0 ? sw.deck.pop() : null;
  sw.market[slot] = card;
  emit({ type: EVENTS.SWAG_DEALT, slot, card });
  return card;
}

/** R16.5 - refills the slot just emptied first, then any other empty slot (a later refill "finds" a card). */
export function refillSwagMarket(state, firstSlot) {
  const sw = state.swag;
  const order = [firstSlot];
  for (let i = 0; i < sw.market.length; i++) if (i !== firstSlot && sw.market[i] === null) order.push(i);
  for (const slot of order) dealSwagSlot(state, slot);
}

// ---------------------------------------------------------------------------
// VP from cards
// ---------------------------------------------------------------------------

/** R22.7 - VP from a Swag card or Club power, tagged with its source and card. */
export function gainCardVp(state, seat, amount, source, card) {
  addVp(state, seat, amount, source, source === 'swag' ? { card } : { club: card });
}
