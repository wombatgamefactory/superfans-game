// queries.js - reads of the game state. Nothing here changes or copies it.
//
// The UI, the bots and the engine's own legality and mutators all read the
// board through these functions, so a queue is ordered in exactly one place
// (R9.1) and a path is chosen in exactly one place (R10.5).

import { getConstants } from './state.js';
import {
  HALL_IDS,
  ADJACENT,
  ENTRANCE,
  ropeBetween,
  hallById,
  securitySpace,
  photographerSpace,
  VOLUNTEER_SPACES,
  BADGE_RANK,
  COLOURS,
} from './board.js';
import { CELEBRITY_CARDS, ACHIEVEMENT_CARDS, SWAG_CARDS, CLUB_CARDS } from './data/cards.js';

// ---------------------------------------------------------------------------
// Card data lookups
// ---------------------------------------------------------------------------

const CELEB = new Map(CELEBRITY_CARDS.map((c) => [c.id, c]));
const ACH = new Map(ACHIEVEMENT_CARDS.map((c) => [c.id, c]));
const SWAGD = new Map(SWAG_CARDS.map((c) => [c.id, c]));
const CLUB = new Map(CLUB_CARDS.map((c) => [c.id, c]));

/** R4.1 - the printed data of a celebrity card (rank, coffee value, route start to destination, scoring method), or null. */
export function celebrityCard(id) {
  return CELEB.get(id) ?? null;
}
/** R1.12 - the printed data of an Achievement card, or null. */
export function achievementCard(id) {
  return ACH.get(id) ?? null;
}
/** R1.13 - the printed data of a Swag card, or null. */
export function swagCard(id) {
  return SWAGD.get(id) ?? null;
}
/** R1.14 - the printed data of a Club card, or null. */
export function clubCard(id) {
  return CLUB.get(id) ?? null;
}

// ---------------------------------------------------------------------------
// Seats and turn order (Note 6: clockwise = increasing seat number)
// ---------------------------------------------------------------------------

/** The seat after `seat`, clockwise. */
export function nextSeat(state, seat) {
  return (seat + 1) % state.players.length;
}

/** Every seat in turn order starting with `first`. */
export function seatsFrom(state, first) {
  const n = state.players.length;
  const out = [];
  for (let i = 0; i < n; i++) out.push((first + i) % n);
  return out;
}

/** R6.3 - the first player of Hour h. */
export function firstPlayerOfHour(state, hour) {
  return (state.startPlayer + hour - 1) % state.players.length;
}

/** Whose turn it is On the Floor (the active player), or null outside a turn. Can differ from state.toAct. */
export function activePlayer(state) {
  return state.phase === 'floor' ? state.turn.player : null;
}

// ---------------------------------------------------------------------------
// Coffee and selfies
// ---------------------------------------------------------------------------

/** Total selfies held. */
export function selfieTotal(selfies) {
  return selfies.green + selfies.red + selfies.orange;
}

/** Whether `have` holds at least `need` of every colour. */
export function canPaySelfies(have, need) {
  return have.green >= need.green && have.red >= need.red && have.orange >= need.orange;
}

/** "1 green + 2 red Selfies" (colours with zero left out). */
export function formatSelfies(counts) {
  const parts = COLOURS.filter((c) => counts[c] > 0).map((c) => `${counts[c]} ${c}`);
  if (parts.length === 0) return 'no Selfies';
  const total = selfieTotal(counts);
  return `${parts.join(' + ')} ${total === 1 ? 'Selfie' : 'Selfies'}`;
}

/**
 * R7.3 - how much of a coffee gain a player can keep. `coffeeBreak` true for
 * the Coffee Break income, which is capped under both values of `coffeeCap`.
 */
export function coffeeRoom(state, seat, coffeeBreak) {
  const K = getConstants(state);
  const p = state.players[seat];
  if (state.variants.coffeeCap === 'every-gain' || coffeeBreak) return Math.max(0, K.LIMITS.COFFEE_CAP - p.coffee);
  return Infinity;
}

/** R8.7, R15.4, R18.4.1, R26.3 - whether gaining coffee now would change nothing. */
export function coffeeGainWasted(state, seat) {
  return coffeeRoom(state, seat, false) === 0;
}

// ---------------------------------------------------------------------------
// Halls and queues
// ---------------------------------------------------------------------------

/** R3.6 - queue capacity C per hall in this game. */
export function capacity(state) {
  const K = getConstants(state);
  return K.CAPACITY.QUEUE_CAPACITY[state.variants.queueCapacity][state.players.length];
}

/** The Crew record with this id, or null. */
export function crewById(state, id) {
  if (typeof id !== 'string') return null;
  const m = /^c(\d+)-(\d+)$/.exec(id);
  if (!m) return null;
  const K = getConstants(state);
  const index = Number(m[1]) * K.SUPPLY.CREW_PER_PLAYER + Number(m[2]) - 1;
  const c = state.crew[index];
  return c && c.id === id ? c : null;
}

// ---------------------------------------------------------------------------
// Per-call memo. getValidActions opens it for the length of ONE call, during
// which the state is not changed, so hall counts and best paths can be
// computed once instead of once per candidate action (movePaths dominated the
// time per decision). It is closed in a `finally`; outside a call nothing is
// cached, so a state mutated by hand or by a mutator is never read stale.
// ---------------------------------------------------------------------------

let memo = null;

/** hall code id -> grid id, for the R10.5 tie-break. */
const GRID_OF = Object.fromEntries(HALL_IDS.map((h) => [h, hallById(h).grid]));

/** Opens the memo for one read-only pass over `state`. Returns true if this call opened it (the caller then closes it). */
export function openQueryMemo(state) {
  if (memo !== null) return false;
  memo = { state, counts: null, paths: new Map() };
  return true;
}

/** Closes the memo opened by openQueryMemo. */
export function closeQueryMemo() {
  memo = null;
}

function memoFor(state) {
  return memo !== null && memo.state === state ? memo : null;
}

/** Number of Crew in each hall (by hall id), computed once per memo. */
function hallCounts(state) {
  const m = memoFor(state);
  if (m !== null && m.counts !== null) return m.counts;
  const counts = {};
  for (const h of HALL_IDS) counts[h] = 0;
  for (const c of state.crew) if (c.hall !== null) counts[c.hall] += 1;
  if (m !== null) m.counts = counts;
  return counts;
}

/** Number of Crew in a hall. */
export function hallCount(state, hall) {
  if (memoFor(state) !== null) return hallCounts(state)[hall] ?? 0;
  let n = 0;
  for (const c of state.crew) if (c.hall === hall) n++;
  return n;
}

/** R3.6.1 - a hall is full when it holds at least C Crew. */
export function isFull(state, hall) {
  return hallCount(state, hall) >= capacity(state);
}

/** R3.6.1 - a hall has room when it is not full. */
export function hasRoom(state, hall) {
  return !isFull(state, hall);
}

/** The seat whose Volunteer is on a space, or null. R13.3: a Volunteer works only for the player who placed it. */
export function volunteerOwner(state, space) {
  return state.volunteers[space];
}

/** R9.3, R13.5 - the seat with the Security volunteer in a hall, or null. Security never lets a Crew overtake a higher badge (it is key 2 of R9.1). */
export function securityOwner(state, hall) {
  return state.volunteers[securitySpace(hall)];
}

/** R13.6 - the seat with the Photographer in a hall, or null (R20.3.2: it needs no Crew there). */
export function photographerOwner(state, hall) {
  return state.volunteers[photographerSpace(hall)];
}

/** R13.4, R10.4 - the seat with the Usher on a rope, or null. */
export function usherOwner(state, rope) {
  return state.volunteers[rope];
}

/**
 * R9.1 - the Crew in a hall in queue order (position 1 first): badge (AAA,
 * VIP, N00b), then the Security owner's Crew first within a badge, then the
 * earlier arrival stamp. Returns the Crew records (not copies).
 * R9.4: a queue is never stored, so it is recomputed after every change to its hall by construction.
 */
export function queue(state, hall) {
  const sec = securityOwner(state, hall);
  const list = state.crew.filter((c) => c.hall === hall);
  list.sort((a, b) => {
    const br = BADGE_RANK[b.badge] - BADGE_RANK[a.badge];
    if (br !== 0) return br;
    const sa = a.owner === sec ? 0 : 1;
    const sb = b.owner === sec ? 0 : 1;
    if (sa !== sb) return sa - sb;
    return a.stamp - b.stamp;
  });
  return list;
}

/** Queue position (1 = Prime Position) of a Crew on the board, or null. */
export function queuePosition(state, crewId) {
  const c = crewById(state, crewId);
  if (!c || c.hall === null) return null;
  return queue(state, c.hall).findIndex((x) => x.id === crewId) + 1;
}

/** R1.9 - the seat in Prime Position of a hall, or null when it is empty. */
export function primeOwner(state, hall) {
  const q = queue(state, hall);
  return q.length === 0 ? null : q[0].owner;
}

/** A player's Crew on the board. */
export function crewOnBoard(state, seat) {
  return state.crew.filter((c) => c.owner === seat && c.hall !== null);
}

/** A player's Crew still in supply. */
export function crewInSupply(state, seat) {
  return state.crew.filter((c) => c.owner === seat && c.hall === null);
}

/** Whether the player has at least one Crew in the hall. */
export function hasCrewIn(state, seat, hall) {
  return state.crew.some((c) => c.owner === seat && c.hall === hall);
}

/** Halls with room, in reading order. */
export function hallsWithRoom(state) {
  return HALL_IDS.filter((h) => hasRoom(state, h));
}

/**
 * R11.2 - the halls a new N00b may be placed in: the Entrance if it has room;
 * else the halls next to it that have room; else any hall with room.
 */
export function newNoobHalls(state) {
  if (hasRoom(state, ENTRANCE)) return [ENTRANCE];
  const near = ADJACENT[ENTRANCE].filter((h) => hasRoom(state, h));
  if (near.length > 0) return near;
  return hallsWithRoom(state);
}

// ---------------------------------------------------------------------------
// Movement (R10)
// ---------------------------------------------------------------------------

/**
 * R10.2, R10.5 - the best path for each destination a Crew can reach in 1 to
 * `maxSteps` steps. Every hall after the start must have room when entered;
 * a path never visits a hall twice. Best = most ropes crossed holding an Usher
 * of `bonusSeat` (the mover, when moving their own Crew; null = no bonus is
 * possible), tie: the path whose list of GRID ids is first alphabetically.
 *
 * @returns {Object<string, { path: string[], ushers: number }>} destination -> best path (path includes the start)
 */
export function movePaths(state, crew, maxSteps, bonusSeat) {
  const m = memoFor(state);
  let memoKey = null;
  if (m !== null) {
    memoKey = `${crew.id}|${crew.hall}|${maxSteps}|${bonusSeat}`;
    const hit = m.paths.get(memoKey);
    if (hit !== undefined) return hit;
  }
  const best = {};
  const start = crew.hall;
  const room = {};
  const cap = capacity(state);
  const counts = hallCounts(state);
  for (const h of HALL_IDS) room[h] = counts[h] < cap;
  const gridKey = (path) => path.map((h) => GRID_OF[h]).join(',');
  const visit = (path, ushers) => {
    const here = path[path.length - 1];
    if (path.length > 1) {
      const cur = best[here];
      if (!cur || ushers > cur.ushers || (ushers === cur.ushers && gridKey(path) < gridKey(cur.path))) {
        best[here] = { path: path.slice(), ushers };
      }
    }
    if (path.length - 1 >= maxSteps) return;
    for (const next of ADJACENT[here]) {
      if (path.includes(next) || !room[next]) continue;
      const rope = ropeBetween(here, next);
      const paid = bonusSeat !== null && usherOwner(state, rope) === bonusSeat ? 1 : 0;
      path.push(next);
      visit(path, ushers + paid);
      path.pop();
    }
  };
  visit([start], 0);
  if (m !== null) m.paths.set(memoKey, best);
  return best;
}

/** Whether some Crew of the player could make at least one step (R10.6, R10.7 availability). */
export function hasAnyStep(state, seat, exclude = []) {
  for (const c of state.crew) {
    if (c.owner !== seat || c.hall === null || exclude.includes(c.id)) continue;
    if (ADJACENT[c.hall].some((h) => hasRoom(state, h))) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Celebrities and the schedule (R4.3, R5.4, R20)
// ---------------------------------------------------------------------------

/** The schedule entry of a slot ('1' .. '4', '5a', '5b'). */
export function scheduleSlot(state, slot) {
  return state.schedule.find((s) => s.slot === slot) ?? null;
}

/** The schedule entry holding a celebrity card, or null. */
export function scheduleOfCard(state, cardId) {
  return state.schedule.find((s) => s.card === cardId) ?? null;
}

/** Celebrities whose figure is on the board (R1.11), in schedule order. */
export function figuresOnBoard(state) {
  return state.schedule.filter((s) => s.status === 'onBoard' && s.figure !== null);
}

/** R6.2 - the slots that walk this Hour. */
export function slotsOfHour(state, hour) {
  return state.schedule.filter((s) => s.hour === hour);
}

/** R7.2 - this Hour's Coffee Break income: the celebrity's coffee value; in Hour 5 the sum of both. */
export function hourIncome(state, hour) {
  const K = getConstants(state);
  let sum = 0;
  for (const s of slotsOfHour(state, hour)) sum += K.CELEBRITIES.CELEBRITIES[s.card].COFFEE;
  return sum;
}

/** Celebrity figures standing in a hall where the player has a Crew (R14.1). */
export function selfieTargets(state, seat) {
  return figuresOnBoard(state).filter((s) => hasCrewIn(state, seat, s.figure));
}

// ---------------------------------------------------------------------------
// Volunteers (R13.7)
// ---------------------------------------------------------------------------

/** A player's Volunteers on the board, as space records. */
export function volunteersOf(state, seat, role = null) {
  return VOLUNTEER_SPACES.filter((s) => state.volunteers[s.id] === seat && (role === null || s.role === role));
}

/** Empty volunteer spaces (optionally of one role). */
export function emptySpaces(state, role = null) {
  const m = memoFor(state);
  if (m !== null && role === null) {
    if (m.empty === undefined) m.empty = VOLUNTEER_SPACES.filter((s) => state.volunteers[s.id] === null);
    return m.empty;
  }
  return VOLUNTEER_SPACES.filter((s) => state.volunteers[s.id] === null && (role === null || s.role === role));
}

/** R13.7.1 - a player's Volunteers counted "in" a hall (Ushers in both halls under usherInHall = both-halls). */
export function volunteersInHall(state, seat, hall) {
  let n = 0;
  for (const s of VOLUNTEER_SPACES) {
    if (state.volunteers[s.id] !== seat) continue;
    if (s.role === 'usher') {
      if (state.variants.usherInHall === 'both-halls' && s.halls.includes(hall)) n++;
    } else if (s.hall === hall) n++;
  }
  return n;
}

// ---------------------------------------------------------------------------
// Achievements in hand
// ---------------------------------------------------------------------------

/** R19.1 - a player's current Achievement hand size. */
export function handSize(state, seat) {
  return state.players[seat].handSize;
}

/** Whether every player has passed this Hour (R8.2). */
export function allPassed(state) {
  return state.players.every((p) => p.passSlot > 0);
}

// ---------------------------------------------------------------------------
// Little words
// ---------------------------------------------------------------------------

/** 1st, 2nd, 3rd, 4th ... */
export function ordinal(n) {
  const s = n % 100;
  if (s >= 11 && s <= 13) return `${n}th`;
  switch (n % 10) {
    case 1:
      return `${n}st`;
    case 2:
      return `${n}nd`;
    case 3:
      return `${n}rd`;
    default:
      return `${n}th`;
  }
}

/** "1 coffee", "3 coffee" (coffee is uncountable). */
export function coffeeText(n) {
  return `${n} coffee`;
}
