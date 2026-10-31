// stats.js - the real-player stats of one game, built ONLY from engine events
// (the same events, and the same tally, the simulator uses: sim/metrics.mjs).
// Nothing here infers a figure from a change in score.
//
// Pure: no DOM, no storage, no clock. It runs in the browser (end screen, game
// record) and in Node (tests, tools/replay.mjs).
//
// BUCKETS (as in the simulator): index 0..4 = Hours 1..5, index 5 = Final
// scoring (R22). Every figure is filed under the Hour in which the engine
// awarded it.

import { EVENTS, achievementCard, swagCard, clubCard, celebrityCard } from '../engine/index.js';
import { createTally, tallyEvents, BUCKET_LABELS, BUCKETS } from '../../sim/metrics.mjs';

export { BUCKET_LABELS };

const sumValues = (o) => Object.values(o || {}).reduce((a, b) => a + b, 0);

/**
 * Builds the stats of a game.
 * @param {object[]} events every event of the game from createGame on (setup events included)
 * @param {{ name: string, colour: string }[]} players state.players (names and colours)
 * @param {{ kind: string, level?: string|null }[]} seats
 * @returns {object} see the fields below; plain JSON
 */
export function collectStats(events, players, seats = []) {
  const P = players.length;
  const t = createTally(P);
  tallyEvents(t, events);

  // Running VP at the end of each bucket (cumulative), for the lead chart.
  const cumulative = [];
  const run = Array(P).fill(0);
  for (let b = 0; b < BUCKETS; b++) {
    for (let s = 0; s < P; s++) run[s] += t.vpBucket[b][s];
    cumulative.push(run.slice());
  }
  // Which seat led after each bucket (null = tied on top).
  const leaders = cumulative.map((vps) => {
    const top = Math.max(...vps);
    const at = vps.map((v, s) => (v === top ? s : -1)).filter((s) => s >= 0);
    return at.length === 1 ? at[0] : null;
  });

  // Celebrity scoring per Hour per seat (CELEBRITY_SCORED totals), plus the best single payout.
  const celebrityByHour = Array.from({ length: P }, () => Array(5).fill(0));
  let biggest = null;
  for (const c of t.celebrities) {
    const h = Math.min(Math.max(c.hour, 1), 5) - 1;
    c.totals.forEach((vp, seat) => {
      celebrityByHour[seat][h] += vp;
      if (vp > 0 && (!biggest || vp > biggest.vp)) biggest = { seat, vp, hour: c.hour, hall: c.hall, card: c.card };
    });
  }

  const seatsOut = [];
  for (let s = 0; s < P; s++) {
    const vpBySource = { ...t.vp[s] };
    const vpTotal = sumValues(vpBySource);
    const coffeeEarnedByCause = { ...t.coffeeEarned[s] };
    const coffeeSpentByCause = { ...t.coffeeSpent[s] };
    const selfiesGained = { green: 0, red: 0, orange: 0, ...t.selfieGainColour[s] };
    const selfiesSpent = { green: 0, red: 0, orange: 0, ...t.selfieSpendColour[s] };
    // "Selfies taken" = the ones photographed (action + walk), as the end-screen tile counts them.
    const taken = { green: 0, red: 0, orange: 0 };
    for (const e of events) {
      if (e.type === EVENTS.SELFIE_GAIN && e.player === s && ['take-selfie', 'walk-prime', 'walk-photographer'].includes(e.cause)) {
        for (const c of ['green', 'red', 'orange']) taken[c] += e.gain[c] || 0;
      }
    }
    const achievements = t.achievements
      .filter((a) => a.seat === s)
      .map((a) => ({ card: a.card, name: safeName(achievementCard, a.card), when: a.when, hour: a.hour, count: a.count, multiplier: a.multiplier, vp: a.vp, tripled: a.tripled }));
    const swag = t.swag
      .filter((w) => w.seat === s)
      .map((w) => ({ card: w.card, name: safeName(swagCard, w.card), colour: w.colour, cost: w.cost, hour: w.hour, vp: 0 }));
    const clubUses = t.clubUses.filter((u) => u.seat === s);
    const clubId = players[s].club ?? null;
    seatsOut.push({
      seat: s,
      name: players[s].name,
      colour: players[s].colour,
      kind: seats[s] ? seats[s].kind : null,
      level: seats[s] ? seats[s].level ?? null : null,
      vp: { total: vpTotal, bySource: vpBySource, byHour: t.vpBucket.map((b) => b[s]) },
      coffee: {
        earned: sumValues(coffeeEarnedByCause),
        earnedByCause: coffeeEarnedByCause,
        spent: sumValues(coffeeSpentByCause),
        spentByCause: coffeeSpentByCause,
        lostToCap: sumValues(t.coffeeLost[s]),
        lostByCause: { ...t.coffeeLost[s] },
      },
      selfies: {
        gainedByColour: selfiesGained,
        spentByColour: selfiesSpent,
        gained: sumValues(selfiesGained),
        spent: sumValues(selfiesSpent),
        takenByColour: taken,
        taken: sumValues(taken),
        conversions: { ...t.conversions[s] },
      },
      actions: { ...t.chosen[s] },
      actionsTotal: sumValues(t.chosen[s]),
      autoActions: sumValues(t.auto[s]),
      turns: t.turns[s].reduce((a, b) => a + b, 0),
      achievements,
      achievementsCompleted: achievements.filter((a) => a.vp > 0).length,
      swag,
      club: clubId ? { id: clubId, name: safeName(clubCard, clubId), uses: clubUses.length, options: countBy(clubUses.map((u) => u.option)), vp: (vpBySource.club || 0) + (vpBySource.militia || 0) } : null,
      celebrityByHour: celebrityByHour[s],
    });
  }
  // VP that swag cards gave, attributed to the owner of the card (swagVp is by card id; one owner per card per game).
  for (const w of t.swag) {
    const gave = t.swagVp[w.card];
    if (gave) {
      const row = seatsOut[w.seat].swag.find((x) => x.card === w.card);
      if (row) row.vp = gave;
    }
  }

  return {
    schema: 'superfans-stats-v1',
    labels: BUCKET_LABELS.slice(),
    seats: seatsOut,
    cumulativeVp: cumulative,
    leaders,
    leadChanges: t.leadChanges,
    celebrities: t.celebrities.map((c) => ({ hour: c.hour, slot: c.slot, card: c.card, name: safeName(celebrityCard, c.card), colour: c.colour, hall: c.hall, method: c.method, queueLen: c.queueLen, scoring: c.scoring, totals: c.totals })),
    biggestPayout: biggest,
    passOrder: t.passOrder.map((o) => o.slice()),
    counters: { ...t.counters },
    ended: t.ended,
    achievementsCompletedTotal: seatsOut.reduce((n, p) => n + p.achievementsCompleted, 0),
  };
}

function countBy(list) {
  const out = {};
  for (const x of list) out[x] = (out[x] || 0) + 1;
  return out;
}

function safeName(fn, id) {
  try {
    const c = fn(id);
    return c && c.name ? c.name : String(id);
  } catch {
    return String(id);
  }
}

/** VP by source for the first-ranked seat (feeds top_vp_source in analytics). */
export function winnerSources(stats, scores) {
  const first = [...scores.players].sort((a, b) => a.rank - b.rank)[0];
  return first ? stats.seats[first.seat].vp.bySource : {};
}
