// metrics.mjs - the per-game tally, built ONLY from engine events (never inferred
// from state), plus the bookkeeping checks.
//
// The driver (run-game.mjs) feeds every event of every applied action, including
// the setup events returned by createGame, to `tallyEvents`. Hour bookkeeping is
// event-driven too: HOUR_START and PHASE_START move the tally's clock, so a VP
// event is filed under the Hour in which the engine awarded it.
//
// BUCKETS: index 0..4 = Hours 1..5 (Coffee Break, On the Floor and Walk of that
// Hour), index 5 = Final scoring (R22: the last Achievement tripled, leftover selfies).

import { EVENTS } from '../src/engine/index.js';
import { inc } from './stats.mjs';

export const BUCKETS = 6;
export const BUCKET_LABELS = ['Hour 1', 'Hour 2', 'Hour 3', 'Hour 4', 'Hour 5', 'Final'];

const zeros = (n) => Array.from({ length: n }, () => 0);
const objs = (n) => Array.from({ length: n }, () => ({}));

export function createTally(P) {
  return {
    P,
    hour: 1,
    phase: 'setup',
    // VP
    vp: objs(P), // seat -> source -> VP
    vpBucket: Array.from({ length: BUCKETS }, () => zeros(P)),
    vpBucketSource: Array.from({ length: BUCKETS }, () => ({})),
    running: zeros(P),
    leader: -1,
    leadChanges: 0,
    // coffee and selfies (net columns exist for the bookkeeping check)
    coffeeEarned: objs(P), // seat -> cause -> coffee kept
    coffeeLost: objs(P), // seat -> cause -> coffee lost over the cap
    coffeeSpent: objs(P), // seat -> cause (action type) -> coffee
    coffeeNet: zeros(P),
    selfieGainColour: objs(P),
    selfieGainCause: objs(P),
    selfieSpendColour: objs(P),
    selfieSpendCause: objs(P),
    selfieNet: Array.from({ length: P }, () => ({ green: 0, red: 0, orange: 0 })),
    conversions: objs(P), // seat -> E1|E2|E3|strike-a-pose|rare-finds -> count
    // actions
    chosen: objs(P),
    auto: objs(P),
    actionHour: Array.from({ length: P }, () => Array.from({ length: BUCKETS }, () => ({}))),
    turns: Array.from({ length: P }, () => zeros(BUCKETS)),
    passTurns: Array.from({ length: P }, () => zeros(BUCKETS)),
    // passing
    passOrder: Array.from({ length: 5 }, () => []),
    passRewards: objs(P),
    // cards
    achievements: [],
    achDrawn: Array.from({ length: P }, () => new Set()),
    achDiscarded: [],
    swag: [],
    swagSeen: new Set(),
    clubUses: [],
    celebrities: [],
    counters: {},
    clubVp: {}, // club card -> VP its power gave (VP sources club and militia)
    swagVp: {}, // swag card -> VP it gave (VP source swag)
    floorEnd: Array(5).fill(null), // filled by the driver from the last Floor decision
    ended: null,
    unknownEvents: {},
  };
}

function bucketOf(t) {
  if (t.phase === 'final') return 5;
  return Math.min(Math.max(t.hour, 1), 5) - 1;
}

function addSelfies(into, obj) {
  let total = 0;
  for (const c of Object.keys(obj)) {
    if (obj[c]) {
      inc(into, c, obj[c]);
      total += obj[c];
    }
  }
  return total;
}

/** Folds the events of one applied action (or of setup) into the tally. */
export function tallyEvents(t, events) {
  if (!events) return;
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    switch (e.type) {
      case EVENTS.HOUR_START:
        t.hour = e.hour;
        t.phase = 'coffeeBreak';
        break;
      case EVENTS.PHASE_START:
        t.hour = e.hour;
        t.phase = e.phase;
        break;
      case EVENTS.TURN_START:
        (e.kind === 'pass' ? t.passTurns : t.turns)[e.player][bucketOf(t)]++;
        break;
      case EVENTS.ACTION: {
        const type = e.action.type;
        if (e.auto) inc(t.auto[e.player], type);
        else {
          inc(t.chosen[e.player], type);
          inc(t.actionHour[e.player][bucketOf(t)], type);
        }
        break;
      }
      case EVENTS.COFFEE_GAIN:
        inc(t.coffeeEarned[e.player], e.cause, e.amount);
        if (e.lost) inc(t.coffeeLost[e.player], e.cause, e.lost);
        t.coffeeNet[e.player] += e.amount;
        if (e.cause === 'usher') inc(t.counters, 'usherCoffee', e.amount);
        break;
      case EVENTS.COFFEE_SPEND:
        inc(t.coffeeSpent[e.player], e.cause, e.amount);
        t.coffeeNet[e.player] -= e.amount;
        break;
      case EVENTS.SELFIE_GAIN: {
        const n = addSelfies(t.selfieGainColour[e.player], e.gain);
        inc(t.selfieGainCause[e.player], e.cause, n);
        if (e.cause === 'walk-prime') inc(t.counters, 'primeSelfies', n);
        else if (e.cause === 'walk-photographer') inc(t.counters, 'photographerSelfies', n);
        for (const c of Object.keys(e.gain)) t.selfieNet[e.player][c] = (t.selfieNet[e.player][c] ?? 0) + (e.gain[c] ?? 0);
        break;
      }
      case EVENTS.SELFIE_SPEND: {
        const n = addSelfies(t.selfieSpendColour[e.player], e.pay);
        inc(t.selfieSpendCause[e.player], e.cause, n);
        for (const c of Object.keys(e.pay)) t.selfieNet[e.player][c] = (t.selfieNet[e.player][c] ?? 0) - (e.pay[c] ?? 0);
        break;
      }
      case EVENTS.VP: {
        const b = bucketOf(t);
        inc(t.vp[e.player], e.source, e.amount);
        t.vpBucket[b][e.player] += e.amount;
        inc(t.vpBucketSource[b], e.source, e.amount);
        t.running[e.player] += e.amount;
        if ((e.source === 'club' || e.source === 'militia') && e.detail && e.detail.club) inc(t.clubVp, e.detail.club, e.amount);
        else if (e.source === 'swag' && e.detail && e.detail.card) inc(t.swagVp, e.detail.card, e.amount);
        // Lead changes: a new SOLE leader who is not the previous sole leader. Ties keep the old leader.
        let top = -1;
        let tied = false;
        for (let s = 0; s < t.P; s++) {
          if (top === -1 || t.running[s] > t.running[top]) {
            top = s;
            tied = false;
          } else if (t.running[s] === t.running[top]) tied = true;
        }
        if (!tied && top !== t.leader) {
          if (t.leader !== -1) t.leadChanges++;
          t.leader = top;
        }
        break;
      }
      case EVENTS.CONVERSION:
        inc(t.conversions[e.player], e.kind);
        break;
      case EVENTS.CREW_PLACED:
        inc(t.counters, `placed.${e.cause}`);
        break;
      case EVENTS.CREW_MOVED:
        inc(t.counters, 'crewMoves');
        if (e.ushersCrossed) inc(t.counters, 'usherCrossings', e.ushersCrossed);
        if (e.ushersPaid) inc(t.counters, 'usherPaid', e.ushersPaid);
        if (e.jump) inc(t.counters, 'jumps');
        break;
      case EVENTS.CREW_UPGRADED:
        inc(t.counters, `upgrade.${e.to}`);
        break;
      case EVENTS.VOLUNTEER_PLACED:
        inc(t.counters, `volunteer.${e.role}`);
        break;
      case EVENTS.VOLUNTEER_MOVED:
        inc(t.counters, 'volunteerMoved');
        break;
      case EVENTS.PASSED:
        t.passOrder[Math.min(Math.max(e.hour, 1), 5) - 1].push(e.player);
        break;
      case EVENTS.PASS_REWARD:
        inc(t.passRewards[e.player], e.reward, e.amount);
        break;
      case EVENTS.ACHIEVEMENT_DRAWN:
        t.achDrawn[e.player].add(e.card);
        break;
      case EVENTS.ACHIEVEMENT_SCORED:
        t.achievements.push({ seat: e.player, card: e.card, hour: bucketOf(t) + 1, when: e.when, count: e.count, multiplier: e.multiplier, vp: e.vp, tripled: Boolean(e.tripled) });
        if (e.tripled) inc(t.counters, 'achievementTripled');
        break;
      case EVENTS.ACHIEVEMENT_DISCARDED:
        t.achDiscarded.push({ seat: e.player, card: e.card, cause: e.cause, hour: bucketOf(t) + 1 });
        break;
      case EVENTS.DECK_RESHUFFLED:
        inc(t.counters, `reshuffle.${e.deck}`);
        break;
      case EVENTS.SWAG_BOUGHT:
        t.swag.push({ seat: e.player, card: e.card, colour: e.colour, cost: e.cost, hour: bucketOf(t) + 1, slot: e.slot });
        break;
      case EVENTS.SWAG_DEALT:
        if (e.card) t.swagSeen.add(e.card);
        break;
      case EVENTS.CLUB_USED:
        t.clubUses.push({ seat: e.player, club: e.club, option: e.option, hour: bucketOf(t) + 1 });
        break;
      case EVENTS.CELEBRITY_ENTERED:
        inc(t.counters, 'walkSteps');
        break;
      case EVENTS.CELEBRITY_SCORED:
        t.celebrities.push({
          hour: e.hour,
          slot: e.slot,
          card: e.celebrity,
          colour: e.colour,
          hall: e.hall,
          method: e.method,
          queueLen: e.payouts.length,
          scoring: e.payouts.filter((p) => p.vp > 0).length,
          totals: e.totals.slice(),
        });
        break;
      case EVENTS.SAFETY_STOP:
        inc(t.counters, `safety.${e.kind}`);
        break;
      case EVENTS.GAME_END:
        t.ended = { reason: e.reason, turnCapped: Boolean(e.turnCapped) };
        break;
      default:
        // CELEBRITY_PLACED / REMOVED, FIRST_PLAYER_MOVED: no designer metric.
        break;
    }
  }
}

/**
 * The bookkeeping check. Returns a list of problems (empty = sound):
 *  - the VP the events announced equal scoreGame(), per seat and per source, and the seat totals equal state VP;
 *  - coffee and selfies at the end equal the start plus every gain minus every spend (the flow events are complete).
 */
export function checkBookkeeping(t, score, state, start) {
  const problems = [];
  for (let s = 0; s < t.P; s++) {
    const keys = new Set([...Object.keys(t.vp[s]), ...Object.keys(score.players[s].bySource)]);
    let eventTotal = 0;
    for (const key of keys) {
      const fromEvents = t.vp[s][key] ?? 0;
      const fromScore = score.players[s].bySource[key] ?? 0;
      eventTotal += fromEvents;
      if (fromEvents !== fromScore) problems.push(`seat ${s + 1} ${key}: ${fromEvents} VP in events, ${fromScore} in scoreGame`);
    }
    if (eventTotal !== score.players[s].vp) problems.push(`seat ${s + 1}: ${eventTotal} VP in events, ${score.players[s].vp} total in scoreGame`);
    if (state.players[s].vp !== score.players[s].vp) problems.push(`seat ${s + 1}: state VP ${state.players[s].vp} differs from scoreGame ${score.players[s].vp}`);
    const coffeeExpected = start.coffee + t.coffeeNet[s];
    if (state.players[s].coffee !== coffeeExpected) problems.push(`seat ${s + 1} coffee: ends on ${state.players[s].coffee} but start ${start.coffee} + events ${t.coffeeNet[s]} = ${coffeeExpected}`);
    for (const c of ['green', 'red', 'orange']) {
      const expected = start.selfies[c] + (t.selfieNet[s][c] ?? 0);
      if (state.players[s].selfies[c] !== expected) problems.push(`seat ${s + 1} ${c} selfies: end ${state.players[s].selfies[c]} but start ${start.selfies[c]} + events ${t.selfieNet[s][c] ?? 0} = ${expected}`);
    }
  }
  return problems;
}
