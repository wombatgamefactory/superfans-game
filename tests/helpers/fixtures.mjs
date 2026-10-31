// fixtures.mjs - helpers for the rules tests: build a position, act, read events.
//
// A "position" is a real game state (from createGame, waiting at the first
// player's turn) whose board, hands and supplies the test then rewrites. The
// state is plain JSON, so a test may assign to it directly; `normalise`
// then re-balances the supplies so the engine's own invariants still hold.

import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const E = await import(pathToFileURL(join(root, 'src/engine/index.js')).href);
export const { randomBot } = await import(pathToFileURL(join(root, 'src/bots/randomBot.js')).href);

/** The constants in force for a state (never hard-code a number a test can read here). */
export const K = (state) => E.getConstants(state);

/**
 * A fresh game waiting at seat 0's turn: seat 0 first player, no Clubs unless asked.
 * @param {number} n players
 * @param {object} [o] { variants, constants, clubs: ['club_04', ...] (per seat), seed }
 */
export function game(n = 3, o = {}) {
  const variants = { firstPlayer: 'seat-0', clubs: 'off', ...(o.variants ?? {}) };
  const config = { playerCount: n, variants };
  if (o.constants) config.constants = o.constants;
  const state = E.createGame(config, { seed: o.seed ?? 'fixture' });
  if (o.clubs) o.clubs.forEach((c, i) => (state.players[i].club = c));
  if (!o.anySeat) assert.equal(state.toAct, 0, 'fixture: seat 0 to act');
  return state;
}

/** Takes every Crew and Volunteer off the board (all back in supply, all N00b). */
export function clear(state) {
  for (const c of state.crew) {
    c.hall = null;
    c.stamp = null;
    c.badge = 'N00b';
  }
  for (const id of Object.keys(state.volunteers)) state.volunteers[id] = null;
  normalise(state);
}

/** Re-balances hats, boxes and Volunteers in supply from what stands on the board. */
export function normalise(state) {
  const k = K(state);
  for (const p of state.players) {
    const mine = state.crew.filter((c) => c.owner === p.seat);
    p.hats = k.SUPPLY.HATS_PER_PLAYER - mine.filter((c) => c.badge !== 'N00b').length;
    p.boxes = k.SUPPLY.BOXES_PER_PLAYER - mine.filter((c) => c.badge === 'AAA').length;
    p.volunteers = k.SUPPLY.VOLUNTEERS_PER_PLAYER - Object.values(state.volunteers).filter((v) => v === p.seat).length;
  }
}

/** Puts a Crew into a hall with the next arrival stamp (so calls in order = queue order within a badge). */
export function put(state, id, hall, badge = 'N00b') {
  const c = E.crewById(state, id);
  c.hall = hall;
  c.badge = badge;
  c.stamp = state.nextStamp++;
  normalise(state);
  return c;
}

/** Puts `seat`'s next supply Crew into a hall. */
export function putNext(state, seat, hall, badge = 'N00b') {
  const c = state.crew.find((x) => x.owner === seat && x.hall === null);
  return put(state, c.id, hall, badge);
}

/** Puts `count` Crew into a hall, taking supply Crew from the seats other than `except` in turn. */
export function fill(state, hall, count, except = 0) {
  const seats = state.players.map((p) => p.seat).filter((x) => x !== except);
  for (let i = 0; i < count; i++) {
    let placed = false;
    for (let k = 0; k < seats.length && !placed; k++) {
      const seat = seats[(i + k) % seats.length];
      const c = state.crew.find((x) => x.owner === seat && x.hall === null);
      if (c) {
        put(state, c.id, hall);
        placed = true;
      }
    }
    assert.ok(placed, 'fill: out of Crew');
  }
}

/** Starts a fresh normal turn for a seat (as the flow would): used to take several turns in a row in one position. */
export function turnFor(state, seat) {
  state.turn = { number: (state.turn.number ?? 0) + 1, player: seat, kind: 'normal' };
  state.stack = [{ kind: 'turn', player: seat, conversions: 0, rareFindsUsed: false }];
  state.toAct = seat;
  state.step = 'turnEnd';
  state.phase = 'floor';
}

/** Moves the position to Hour 5's floor: 5a and 5b on the board at their start halls, `firstSeat` to act and first player. */
export function toHour5(state, firstSeat = state.toAct) {
  state.hour = 5;
  for (const e of state.schedule) {
    if (e.hour < 5) {
      e.status = 'done';
      e.figure = null;
      e.marker = null;
    } else {
      const c = E.celebrityCard(e.card);
      e.status = 'onBoard';
      e.figure = c.start;
      e.marker = c.destination;
    }
  }
  state.firstPlayer = firstSeat;
  const n = state.players.length;
  state.startPlayer = (((firstSeat - 4) % n) + n) % n;
  turnFor(state, firstSeat);
}

/** Sets a Volunteer on a space for a seat. */
export function vol(state, space, seat) {
  state.volunteers[space] = seat;
  normalise(state);
}

/** Sets a player's coffee and selfies. */
export function give(state, seat, o = {}) {
  const p = state.players[seat];
  if (o.coffee !== undefined) p.coffee = o.coffee;
  if (o.selfies) p.selfies = { green: 0, red: 0, orange: 0, ...o.selfies };
}

/** Applies an action and returns its events; the action must be legal. */
export function act(state, action) {
  const reason = E.getBlockReason(state, action);
  assert.equal(reason, null, `${E.actionKey(action)} should be legal but: ${reason}`);
  return E.applyAction(state, action);
}

/** Asserts an action is refused, with a reason matching `re`; the state is untouched. */
export function refused(state, action, re) {
  const reason = E.getBlockReason(state, action);
  assert.ok(reason !== null, `${E.actionKey(action)} should be refused`);
  if (re) assert.match(reason, re);
  const before = E.serialiseState(state);
  assert.throws(() => E.applyAction(state, action), (err) => err.code === 'ILLEGAL_ACTION');
  assert.equal(E.serialiseState(state), before, 'a refused action leaves the state untouched');
  return reason;
}

/** The legal actions of a type for whoever is to act. */
export function legal(state, type) {
  return E.getValidActions(state).filter((a) => a.type === type);
}

/** Events of one type. */
export const only = (events, type) => events.filter((e) => e.type === type);

/** Total VP events for a seat, optionally of one source. */
export function vpOf(events, seat, source) {
  return events.filter((e) => e.type === E.EVENTS.VP && e.player === seat && (!source || e.source === source)).reduce((a, e) => a + e.amount, 0);
}

/** Puts a Swag card into market slot 0 (swapping it with where it was, so the 36 cards stay accounted for). */
export function stockMarket(state, card, slot = 0) {
  const sw = state.swag;
  const old = sw.market[slot];
  const inMarket = sw.market.indexOf(card);
  if (inMarket >= 0) {
    sw.market[inMarket] = old;
  } else if (sw.deck.includes(card)) {
    sw.deck[sw.deck.indexOf(card)] = old;
  } else if (sw.discard.includes(card)) {
    sw.discard[sw.discard.indexOf(card)] = old;
  }
  sw.market[slot] = card;
}

/** Gives the seat to act exactly the selfies and coffee to buy a card, stocks it, and buys it. Returns events. */
export function buy(state, card) {
  const seat = state.toAct;
  const def = E.SWAG_CARDS.find((c) => c.id === card);
  const have = state.players[seat].selfies;
  have[def.colour] = Math.max(have[def.colour], K(state).SWAG.SWAG_COST[card]);
  stockMarket(state, card);
  return act(state, { type: 'buySwag', card });
}

/** Gives a hand of Achievements to a seat, swapping with wherever those cards were. */
export function setHand(state, seat, cards) {
  const p = state.players[seat];
  const ach = state.achievements;
  // return the old hand to the deck, take the new cards out of the deck/other hands/discard
  for (const c of p.hand) ach.deck.push(c);
  p.hand = [];
  for (const card of cards) {
    let i = ach.deck.indexOf(card);
    if (i >= 0) {
      ach.deck.splice(i, 1);
    } else {
      let found = false;
      for (const q of state.players) {
        const j = q.hand.indexOf(card);
        if (j >= 0) {
          q.hand.splice(j, 1, ach.deck.shift());
          found = true;
          break;
        }
      }
      if (!found) {
        const d = ach.discard.findIndex((x) => x.card === card);
        assert.ok(d >= 0, `${card} not found`);
        ach.discard.splice(d, 1);
      }
    }
    p.hand.push(card);
  }
}

/** Replaces the celebrity of a schedule slot by a card (figure and marker follow the card's route). */
export function setCelebrity(state, slot, cardId) {
  const entry = E.scheduleSlot(state, slot);
  const card = E.celebrityCard(cardId);
  entry.card = cardId;
  if (entry.status === 'onBoard') {
    entry.figure = card.start;
    entry.marker = card.destination;
  }
  return entry;
}

/**
 * Plays the floor to its end: every player in turn passes (discarding their first Achievement
 * for coffee when asked, taking VP on later pass-turns) until the phase leaves the floor.
 * Returns all events, including the Walk that follows the last pass.
 */
export function passAll(state, { score = false } = {}) {
  const events = [];
  let guard = 0;
  while (state.phase === 'floor' || state.stack.length > 0) {
    if (guard++ > 200) throw new Error('passAll: no end in sight');
    const top = E.topFrame(state);
    if (top === null) break;
    const hour = state.hour;
    let a;
    if (top.kind === 'passAchievement') {
      const hand = state.players[top.player].hand;
      a = score ? { type: 'scoreAchievement', card: hand[0] } : { type: 'discardAchievement', card: hand[0] };
    } else if (top.kind === 'turn') a = { type: 'pass' };
    else if (top.kind === 'passTurn') a = { type: 'passReward', reward: 'vp' };
    else break;
    events.push(...act(state, a));
    if (state.hour !== hour) break; // the Walk ran and the next Hour began
  }
  return events;
}
