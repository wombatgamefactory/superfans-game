// achievements.js - the 40 Achievement count conditions (spec R19.10) as DATA,
// and the one evaluator that reads them.
//
// A spec is `{ metric, ...params }`. Numeric parameters written `'$NAME'` are
// read from the constants (`ACHIEVEMENTS.ACHIEVEMENT_PARAMS[cardId].NAME`,
// R27.14), so the simulator can probe them. A metric the evaluator does not
// know counts 0 and reports `implemented: false`: an unknown condition must
// never pay (web-board-game skill, "Declarative Objective Cards").
//
// Counting is always for the scoring seat, on the live state (R19.3).

import { getConstants } from './state.js';
import {
  HALL_IDS,
  LINES,
  ROPES,
  CORNER_HALLS,
  EDGE_HALLS,
  areAdjacent,
  VOLUNTEER_SPACES,
} from './board.js';
import { queue, figuresOnBoard, volunteersInHall, selfieTotal } from './queries.js';

/** Hall conditions used by the `halls` metric (every listed condition must hold). */
const HALL_CONDITIONS = {
  ownCrewAtLeast: (h, n) => h.own >= n,
  crewAtLeast: (h, n) => h.total >= n,
  ownBadgeKindsAtLeast: (h, n) => h.badgeKinds >= n,
  ownVipOrAaaAtLeast: (h, n) => h.ownVip >= n,
  ownVolunteersAtLeast: (h, n) => h.ownVolunteers >= n,
  prime: (h, want) => (want === 'own' ? h.primeOwn : !h.primeOwn),
  lastOwn: (h) => h.lastOwn,
  positionOwn: (h, pos) => h.queue.length >= pos && h.queue[pos - 1].owner === h.seat,
  allOwn: (h) => h.total > 0 && h.own === h.total,
  noCelebrity: (h) => h.figures === 0,
  destinationMarker: (h) => h.markers > 0,
  mostCrew: (h) => h.own > 0 && h.maxOther <= h.own,
  tiesAnother: (h) => h.own > 0 && h.otherCounts.includes(h.own),
  majority: (h) => h.own > h.total - h.own,
};

/**
 * R19.10 - the count of each card. Variant-dependent cards give one spec per
 * variant value under `byVariant`.
 */
export const ACHIEVEMENT_SPECS = Object.freeze({
  scoring_01: { metric: 'ownCrew', badges: ['VIP', 'AAA'] }, // Media
  scoring_02: { metric: 'bestLine', lines: 'rows' }, // Row (R19.5)
  scoring_03: { metric: 'selfiePairs', size: '$PAIR_SIZE', max: '$MAX_PAIRS' }, // Look at Me!
  scoring_04: { metric: 'halls', where: { prime: 'own' } }, // Premiere
  scoring_05: { metric: 'halls', where: { ownCrewAtLeast: '$MIN_CREW' } }, // Chums
  scoring_06: { metric: 'ownVolunteers', role: null }, // Volunteers
  scoring_07: { metric: 'halls', where: { ownCrewAtLeast: 1 } }, // Spread Out
  scoring_08: { metric: 'volunteerPairs', role: 'usher' }, // Corridor (R13.7.2-3)
  scoring_09: { metric: 'volunteerPairs', role: 'photographer' }, // Resale!
  scoring_10: { metric: 'volunteerPairs', role: 'security' }, // Jumpers
  scoring_11: { metric: 'ownCrew', badges: null }, // Party
  scoring_12: { metric: 'halls', where: { noCelebrity: true, mostCrew: true } }, // Cult Classic (Q21)
  scoring_13: { metric: 'halls', where: { ownVolunteersAtLeast: '$MIN_VOLUNTEERS' } }, // Passion (R13.7.1)
  scoring_14: { metric: 'volunteerSets' }, // Insiders
  scoring_15: { metric: 'bestLine', lines: 'columns' }, // Column
  scoring_16: { metric: 'halls', where: { ownCrewAtLeast: '$MIN_CREW' } }, // The Gang
  scoring_17: { metric: 'selfieSets', max: '$MAX_SETS' }, // Collector
  scoring_18: { metric: 'halls', where: { lastOwn: true } }, // Late Arrival (Q21)
  scoring_19: { metric: 'halls', where: { allOwn: true } }, // Sleep Out (Q21)
  scoring_20: { metric: 'halls', where: { crewAtLeast: '$MIN_CREW', prime: 'own', lastOwn: true } }, // Bookends
  scoring_21: { metric: 'celebritiesWithOwnCrew' }, // Starstruck (Q21)
  scoring_22: { metric: 'halls', where: { destinationMarker: true, ownCrewAtLeast: '$MIN_CREW' } }, // Photo Op
  scoring_23: { metric: 'ownVolunteers', role: 'security' }, // Security
  scoring_24: { metric: 'ownVolunteers', role: 'usher' }, // Tour Guides
  scoring_25: { metric: 'ownVolunteers', role: 'photographer' }, // Paparazzi
  scoring_26: { metric: 'halls', where: { ownBadgeKindsAtLeast: '$MIN_BADGES' } }, // Mixed Ranks
  scoring_27: { metric: 'halls', kind: 'corner', where: { ownCrewAtLeast: 1 } }, // Corner Him!
  scoring_28: { metric: 'bestLine', lines: 'diagonals' }, // Diagonal Line
  scoring_29: { metric: 'halls', kind: 'edge', where: { ownCrewAtLeast: 1 } }, // Perimeter
  scoring_30: { metric: 'halls', where: { ownVipOrAaaAtLeast: 1, ownVolunteersAtLeast: 1 } }, // Obsessed (Q8)
  scoring_31: {
    // Home Base (Q9, variant homeBase)
    byVariant: 'homeBase',
    values: {
      'three-crew': { metric: 'halls', where: { ownCrewAtLeast: '$MIN_CREW', ownVolunteersAtLeast: 1 } },
      'as-printed': { metric: 'halls', where: { ownVipOrAaaAtLeast: 1, ownVolunteersAtLeast: 1 } },
    },
  },
  scoring_32: { metric: 'ownCrew', badges: ['N00b'] }, // Grass Roots
  scoring_33: { metric: 'halls', where: { positionOwn: '$POSITION' } }, // Runner-Up
  scoring_34: { metric: 'surrounded' }, // Surrounded (Q21)
  scoring_35: { metric: 'halls', where: { ownCrewAtLeast: '$MIN_CREW', prime: 'notOwn' } }, // Underdog
  scoring_36: { metric: 'halls', where: { tiesAnother: true } }, // Rivalry (Q21)
  scoring_37: { metric: 'halls', where: { majority: true } }, // Dominance
  scoring_38: { metric: 'connectedPairs' }, // Connected (Q21)
  scoring_39: { metric: 'coffeePer', per: '$PER_COFFEE' }, // Caffinated
  scoring_40: { metric: 'relaxed', minCoffee: '$MIN_COFFEE' }, // Relaxed (Q21)
});

/** Per-hall facts for one seat, computed once per evaluation. */
function hallFacts(state, seat) {
  const out = [];
  const figures = figuresOnBoard(state);
  const n = state.players.length;
  for (const hall of HALL_IDS) {
    const q = queue(state, hall);
    const counts = new Array(n).fill(0);
    for (const c of q) counts[c.owner]++;
    const mine = q.filter((c) => c.owner === seat);
    const otherCounts = counts.filter((_, s) => s !== seat);
    out.push({
      hall,
      seat,
      queue: q,
      total: q.length,
      own: mine.length,
      otherCounts,
      maxOther: otherCounts.length ? Math.max(...otherCounts) : 0,
      primeOwn: q.length > 0 && q[0].owner === seat,
      lastOwn: q.length > 0 && q[q.length - 1].owner === seat,
      badgeKinds: new Set(mine.map((c) => c.badge)).size,
      ownVip: mine.filter((c) => c.badge !== 'N00b').length,
      ownVolunteers: volunteersInHall(state, seat, hall),
      figures: figures.filter((s) => s.figure === hall).length,
      markers: state.schedule.filter((s) => s.status === 'onBoard' && s.marker === hall).length,
    });
  }
  return out;
}

/** R13.7.2 - whether two of a player's Volunteers of one role are adjacent. */
function volunteersAdjacent(a, b) {
  if (a.role === 'usher') return a.halls.some((h) => b.halls.includes(h));
  return areAdjacent(a.hall, b.hall);
}

/** R13.7.3 - the largest set of disjoint adjacent pairs (a maximum matching; at most 6 nodes). */
function maxPairs(nodes) {
  const best = (i, used) => {
    while (i < nodes.length && used[i]) i++;
    if (i >= nodes.length) return 0;
    used[i] = true;
    let result = best(i + 1, used); // node i unpaired
    for (let j = i + 1; j < nodes.length; j++) {
      if (used[j] || !volunteersAdjacent(nodes[i], nodes[j])) continue;
      used[j] = true;
      result = Math.max(result, 1 + best(i + 1, used));
      used[j] = false;
    }
    used[i] = false;
    return result;
  };
  return best(0, new Array(nodes.length).fill(false));
}

const METRICS = {
  ownCrew: (state, seat, spec) =>
    state.crew.filter((c) => c.owner === seat && c.hall !== null && (spec.badges === null || spec.badges.includes(c.badge))).length,
  halls: (state, seat, spec, ctx) => {
    let n = 0;
    for (const h of ctx.facts()) {
      if (spec.kind === 'corner' && !CORNER_HALLS.includes(h.hall)) continue;
      if (spec.kind === 'edge' && !EDGE_HALLS.includes(h.hall)) continue;
      let ok = true;
      for (const name of Object.keys(spec.where)) {
        const test = HALL_CONDITIONS[name];
        if (!test || !test(h, spec.where[name])) {
          ok = false;
          break;
        }
      }
      if (ok) n++;
    }
    return n;
  },
  bestLine: (state, seat, spec, ctx) => {
    const lines = LINES[spec.lines];
    let bestCount = -1;
    let bestIndex = 0;
    lines.forEach((line, i) => {
      const count = state.crew.filter((c) => c.owner === seat && line.includes(c.hall)).length;
      if (count > bestCount) {
        bestCount = count;
        bestIndex = i;
      }
    });
    ctx.choice = { lines: spec.lines, index: bestIndex, halls: lines[bestIndex].slice() }; // R19.5
    return bestCount;
  },
  selfiePairs: (state, seat, spec) => Math.min(spec.max, Math.floor(selfieTotal(state.players[seat].selfies) / spec.size)),
  selfieSets: (state, seat, spec) => {
    const s = state.players[seat].selfies;
    return Math.min(spec.max, s.green, s.red, s.orange);
  },
  ownVolunteers: (state, seat, spec) =>
    VOLUNTEER_SPACES.filter((s) => state.volunteers[s.id] === seat && (spec.role === null || s.role === spec.role)).length,
  volunteerPairs: (state, seat, spec) =>
    maxPairs(VOLUNTEER_SPACES.filter((s) => state.volunteers[s.id] === seat && s.role === spec.role)),
  volunteerSets: (state, seat) => {
    const count = (role) => VOLUNTEER_SPACES.filter((s) => state.volunteers[s.id] === seat && s.role === role).length;
    return Math.min(count('usher'), count('security'), count('photographer'));
  },
  celebritiesWithOwnCrew: (state, seat) =>
    figuresOnBoard(state).filter((s) => state.crew.some((c) => c.owner === seat && c.hall === s.figure)).length,
  surrounded: (state, seat, spec, ctx) => {
    let n = 0;
    for (const h of ctx.facts()) {
      const q = h.queue;
      for (let i = 1; i < q.length - 1; i++) {
        if (q[i].owner === seat && q[i - 1].owner !== seat && q[i + 1].owner !== seat) n++;
      }
    }
    return n;
  },
  connectedPairs: (state, seat) => {
    const has = (hall) => state.crew.some((c) => c.owner === seat && c.hall === hall);
    return ROPES.filter((r) => has(r.halls[0]) && has(r.halls[1])).length;
  },
  coffeePer: (state, seat, spec) => Math.floor(state.players[seat].coffee / spec.per),
  relaxed: (state, seat, spec) =>
    state.hourState.firstPasser === seat && state.players[seat].coffee >= spec.minCoffee ? 1 : 0,
};

/** The metrics this evaluator knows (for tests and the contract). */
export const ACHIEVEMENT_METRICS = Object.freeze(Object.keys(METRICS));

function resolveParams(value, params) {
  if (typeof value === 'string' && value.startsWith('$')) {
    const name = value.slice(1);
    if (!params || !(name in params)) return null;
    return params[name];
  }
  if (Array.isArray(value)) return value;
  if (value !== null && typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value)) out[k] = resolveParams(value[k], params);
    return out;
  }
  return value;
}

/** The spec in force for a card in this game (variant-resolved, parameters filled in), or null. */
export function achievementSpec(state, cardId) {
  let spec = ACHIEVEMENT_SPECS[cardId];
  if (!spec) return null;
  if (spec.byVariant) spec = spec.values[state.variants[spec.byVariant]] ?? null;
  if (!spec) return null;
  const K = getConstants(state);
  return resolveParams(spec, K.ACHIEVEMENTS.ACHIEVEMENT_PARAMS[cardId] ?? null);
}

/**
 * R19.3 - the count of an Achievement for a seat, now.
 * @returns {{ count: number, choice: object|null, implemented: boolean }}
 */
export function countAchievement(state, seat, cardId) {
  const spec = achievementSpec(state, cardId);
  if (!spec || !METRICS[spec.metric]) return { count: 0, choice: null, implemented: false };
  let facts = null;
  const ctx = {
    choice: null,
    facts: () => {
      if (facts === null) facts = hallFacts(state, seat);
      return facts;
    },
  };
  const count = METRICS[spec.metric](state, seat, spec, ctx);
  return { count: Number.isFinite(count) && count > 0 ? count : 0, choice: ctx.choice, implemented: true };
}

/** R19.4 - VP a card would score now at a multiplier (before it is scored). */
export function achievementValue(state, seat, cardId, multiplier = 1) {
  const K = getConstants(state);
  const { count } = countAchievement(state, seat, cardId);
  return count * K.ACHIEVEMENTS.ACHIEVEMENT_LAUREL[cardId] * multiplier;
}
