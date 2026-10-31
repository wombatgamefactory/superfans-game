// aggregate.mjs - turns the per-game records of ONE player count into the sections
// the report prints (and the HTML report charts).
//
//   aggregate(records, { levels }) -> { counts, length, scores, margin, seats, levels,
//                                       vpSources, pacing, leads, actions, branching,
//                                       economy, queues, cards, subsystems, allFinished, health }
//
// Statistics exclude turn-capped games (reported as a finding of their own in `counts`);
// `allFinished` repeats the headline figures with them included. Failed games (refused
// action, crash, bookkeeping mismatch, decision cap) are never analysed.
//
// Everything here reads records only; no engine state is needed.

import {
  MAIN_ACTION_TYPES, ACHIEVEMENT_CARDS, SWAG_CARDS, CLUB_CARDS, CELEBRITY_CARDS, HALL_IDS, HALLS, VP_SOURCES, VOLUNTEER_SPACES,
} from '../src/engine/index.js';
import { inc, addInto, sum, mean, describe, rateVs, rateVsEach, histogram, round } from './stats.mjs';
import { evaluateHealth } from './health.mjs';

const HALL_NAME = Object.fromEntries(HALLS.map((h) => [h.id, h.name]));
const BUCKET_NAMES = ['Hour 1', 'Hour 2', 'Hour 3', 'Hour 4', 'Hour 5', 'Final scoring'];
const ROLES = [...new Set(VOLUNTEER_SPACES.map((v) => v.role))];
const METHODS = [...new Set(CELEBRITY_CARDS.map((c) => c.scoring.method))];
const COLOURS = ['green', 'red', 'orange'];

/** Per-seat, per-game rows: calls fn(record, seat) for every seat of every game. */
function eachSeat(games, fn) {
  for (const r of games) for (let s = 0; s < r.players; s++) fn(r, s);
}

/** Sums a per-seat list of flat counters across seats and games; divides by player-games for a mean per player per game. */
function perPlayer(games, pick) {
  const tot = {};
  let n = 0;
  eachSeat(games, (r, s) => {
    addInto(tot, pick(r, s));
    n++;
  });
  const out = {};
  for (const k of Object.keys(tot).sort()) out[k] = n ? tot[k] / n : 0;
  return { perPlayer: out, total: tot, playerGames: n };
}

function shares(obj) {
  const total = sum(Object.values(obj));
  const out = {};
  for (const k of Object.keys(obj)) out[k] = total ? obj[k] / total : 0;
  return out;
}

// --------------------------------------------------------------------------------------
// subsystem usage: which rules were used in what fraction of games
// --------------------------------------------------------------------------------------

function actionUsed(type) {
  return (r) => r.actions.some((a) => (a[type] ?? 0) > 0);
}
function counterUsed(key) {
  return (r) => (r.counters[key] ?? 0) > 0;
}
function conversionUsed(kind) {
  return (r) => r.conversions.some((c) => (c[kind] ?? 0) > 0);
}
function vpSourceUsed(source) {
  return (r) => r.vp.some((v) => (v[source] ?? 0) > 0);
}

/** [id, label, predicate(record), rare?]. rare = expected to be uncommon, listed but not warned about. */
function subsystemDefs() {
  const defs = [];
  const act = (type, label) => defs.push([`action.${type}`, label, actionUsed(type)]);
  act('move2', 'Move 2');
  act('move3', 'Move 1 Crew x3 (Move 3)');
  act('newNoob', 'New N00b');
  act('upgrade', 'Upgrade Crew');
  act('volunteer', 'Volunteer');
  act('takeSelfie', 'Take a Selfie');
  act('buySwag', 'Buy Swag');
  act('clubPower', 'Club power (main action)');
  act('pass', 'Pass');
  act('scoreAchievement', 'Score an Achievement on passing');
  act('discardAchievement', 'Discard an Achievement for coffee');
  defs.push(['conv.E1', 'Selfie Exchange E1 (selfies to coffee)', conversionUsed('E1')]);
  defs.push(['conv.E2', 'Selfie Exchange E2 (change colour)', conversionUsed('E2')]);
  defs.push(['conv.E3', 'Selfie Exchange E3 (selfies to VP)', conversionUsed('E3')]);
  defs.push(['conv.strike-a-pose', 'Strike a Pose (Selfie Stick Squad)', conversionUsed('strike-a-pose')]);
  defs.push(['conv.rare-finds', 'Rare Finds (TCG Traders)', conversionUsed('rare-finds')]);
  defs.push(['passReward.coffee', 'Pass-ladder reward taken as coffee', (r) => r.passRewards.some((p) => (p.coffee ?? 0) > 0)]);
  defs.push(['passReward.vp', 'Pass-ladder reward taken as VP', (r) => r.passRewards.some((p) => (p.vp ?? 0) > 0)]);
  defs.push(['usher.crossings', 'Usher rope crossings (R10.4)', counterUsed('usherCrossings')]);
  defs.push(['usher.coffee', 'Coffee earned from Ushers', counterUsed('usherCoffee')]);
  defs.push(['walk.prime', 'Walk: Prime Position selfie', counterUsed('primeSelfies')]);
  defs.push(['walk.photographer', 'Walk: Photographer selfie', counterUsed('photographerSelfies')]);
  for (const role of ROLES) defs.push([`volunteer.${role}`, `Volunteer placed as ${role}`, counterUsed(`volunteer.${role}`)]);
  defs.push(['upgrade.VIP', 'Crew upgraded to VIP', counterUsed('upgrade.VIP')]);
  defs.push(['upgrade.AAA', 'Crew upgraded to AAA', counterUsed('upgrade.AAA')]);
  defs.push(['jump', 'Jump moves (Swag/Club teleports)', counterUsed('jumps')]);
  for (const m of METHODS) defs.push([`method.${m}`, `Celebrity destination scoring: ${m}`, (r) => r.celebrities.some((c) => c.method === m)]);
  for (const src of VP_SOURCES) defs.push([`vp.${src}`, `VP source: ${src}`, vpSourceUsed(src)]);
  defs.push(['achievement.tripled', 'Last Achievement tripled (R22.3)', counterUsed('achievementTripled')]);
  defs.push(['achievement.discarded', 'Achievements discarded (any cause)', (r) => r.achDiscarded.length > 0]);
  defs.push(['coffee.first-pass', 'First-pass coffee bonus (R18.2.2)', (r) => r.coffee.some((c) => (c.earned['first-pass'] ?? 0) > 0)]);
  for (const c of COLOURS) defs.push([`swag.${c}`, `Swag bought: ${c} set`, (r) => r.swag.some((s) => s.colour === c)]);
  for (const club of CLUB_CARDS) defs.push([`club.${club.id}`, `Club used: ${club.name}`, (r) => r.clubUses.some((u) => u.club === club.id)
    || (club.id === 'club_07' && r.conversions.some((c) => (c['rare-finds'] ?? 0) > 0))
    || (club.id === 'club_09' && r.conversions.some((c) => (c['strike-a-pose'] ?? 0) > 0))]);
  defs.push(['reshuffle.swag', 'Swag deck reshuffled', counterUsed('reshuffle.swag'), true]);
  defs.push(['reshuffle.achievement', 'Achievement deck reshuffled', counterUsed('reshuffle.achievement'), true]);
  defs.push(['safety.main-actions', 'Safety stop: main-action cap hit', counterUsed('safety.main-actions'), true]);
  return defs;
}

// --------------------------------------------------------------------------------------
// sections
// --------------------------------------------------------------------------------------

function headline(games) {
  const win = games.map((r) => r.scores[r.winner]);
  const within = games.length ? games.filter((r) => r.marginPct <= 10).length / games.length : null;
  return {
    games: games.length,
    winningScore: describe(win),
    marginPct: describe(games.map((r) => r.marginPct)),
    within10: { value: within, n: games.length },
    decisions: describe(games.map((r) => r.decisions)),
    leadChanges: describe(games.map((r) => r.leadChanges)),
  };
}

function lengthSection(games, P) {
  const mainSet = new Set(MAIN_ACTION_TYPES);
  const turnsPerHour = Array.from({ length: 6 }, () => []);
  const passTurnsPerHour = Array.from({ length: 6 }, () => []);
  for (const r of games) {
    for (let h = 0; h < 6; h++) {
      turnsPerHour[h].push(sum(r.turns.map((t) => t[h])));
      passTurnsPerHour[h].push(sum(r.passTurns.map((t) => t[h])));
    }
  }
  const mainActions = [];
  const mainActionsPerHour = [];
  for (const r of games) {
    let total = 0;
    for (let s = 0; s < r.players; s++) {
      for (const t of Object.keys(r.actions[s])) if (mainSet.has(t) && t !== 'pass') total += r.actions[s][t];
    }
    mainActions.push(total / r.players);
    mainActionsPerHour.push(total / r.players / 5);
  }
  return {
    players: P,
    decisions: describe(games.map((r) => r.decisions)),
    engineActions: describe(games.map((r) => r.engineActions)),
    autoShare: mean(games.map((r) => (r.engineActions ? r.autos / r.engineActions : 0))),
    mainActionsPerPlayer: describe(mainActions),
    mainActionsPerPlayerPerHour: describe(mainActionsPerHour),
    turnsPerHour: turnsPerHour.slice(0, 5).map((xs) => mean(xs)),
    passTurnsPerHour: passTurnsPerHour.slice(0, 5).map((xs) => mean(xs)),
    turnsPerGame: describe(games.map((r) => sum(r.turns.map((t) => sum(t))))),
    msPerGame: describe(games.map((r) => r.timing.ms)),
  };
}

function scoresSection(games, P) {
  const winning = games.map((r) => r.scores[r.winner]);
  const all = games.flatMap((r) => r.scores);
  const byRank = Array.from({ length: P }, () => []);
  const bySeat = Array.from({ length: P }, () => []);
  for (const r of games) {
    for (let s = 0; s < P; s++) {
      byRank[r.rank[s] - 1].push(r.scores[s]);
      bySeat[s].push(r.scores[s]);
    }
  }
  const spread = games.map((r) => Math.max(...r.scores) - Math.min(...r.scores));
  const edges = [];
  const hi = winning.length ? Math.max(...winning) : 0;
  const step = hi > 150 ? 20 : hi > 60 ? 10 : 5;
  for (let x = 0; x <= hi; x += step) edges.push(x);
  if (edges.length === 0) edges.push(0);
  return {
    winning: describe(winning),
    all: describe(all),
    spread: describe(spread),
    byRank: byRank.map((xs, i) => ({ rank: i + 1, ...describe(xs) })),
    bySeat: bySeat.map((xs, i) => ({ seat: i + 1, ...describe(xs) })),
    winningHistogram: histogram(winning, edges),
    histogramStep: step,
  };
}

function marginSection(games) {
  return {
    marginPct: describe(games.map((r) => r.marginPct)),
    marginVp: describe(games.map((r) => r.margin)),
    within10: { value: games.length ? games.filter((r) => r.marginPct <= 10).length / games.length : null, n: games.length },
    tiedOnVp: { value: games.length ? games.filter((r) => r.sharedTop.length > 1).length / games.length : null, n: games.length },
  };
}

function seatsSection(games, P) {
  const bySeatWins = Array(P).fill(0);
  const byPosWins = Array(P).fill(0);
  const posScores = Array.from({ length: P }, () => []);
  const seatRanks = Array.from({ length: P }, () => []);
  for (const r of games) {
    bySeatWins[r.winner]++;
    const pos = (r.winner - r.startPlayer + P) % P;
    byPosWins[pos]++;
    for (let s = 0; s < P; s++) posScores[(s - r.startPlayer + P) % P].push(r.scores[s]);
    for (let s = 0; s < P; s++) seatRanks[s].push(r.rank[s]);
  }
  const n = games.length;
  const seat = bySeatWins.map((w, i) => ({ seat: i + 1, wins: w, ...rateVs(w, n, 1 / P), meanRank: mean(seatRanks[i]) }));
  const position = byPosWins.map((w, i) => ({ position: i + 1, wins: w, ...rateVs(w, n, 1 / P), meanScore: mean(posScores[i]) }));
  return {
    seat,
    position, // 1 = Hour 1 first player
    firstPlayer: position[0],
    maxSeatSigma: Math.max(0, ...seat.map((s) => Math.abs(s.sigma ?? 0))),
  };
}

function levelsSection(games, P) {
  const names = [...new Set(games.flatMap((r) => r.levels))];
  if (names.length < 2) return { mixed: false, levels: names, rows: [] };
  const rows = names.map((level) => {
    let wins = 0;
    let seatsTotal = 0;
    const ps = [];
    const scores = [];
    const ranks = [];
    for (const r of games) {
      const seats = r.levels.map((l, s) => (l === level ? s : -1)).filter((s) => s >= 0);
      ps.push(seats.length / P);
      seatsTotal += seats.length;
      if (seats.includes(r.winner)) wins++;
      for (const s of seats) {
        scores.push(r.scores[s]);
        ranks.push(r.rank[s]);
      }
    }
    return { level, seats: seatsTotal, wins, ...rateVsEach(wins, ps), meanScore: mean(scores), meanRank: mean(ranks) };
  });
  return { mixed: true, levels: names, rows };
}

function vpSourcesSection(games, P) {
  const total = {};
  const winners = {};
  const others = {};
  let winnerSeats = 0;
  let otherSeats = 0;
  for (const r of games) {
    for (let s = 0; s < r.players; s++) {
      addInto(total, r.vp[s]);
      if (s === r.winner) {
        addInto(winners, r.vp[s]);
        winnerSeats++;
      } else {
        addInto(others, r.vp[s]);
        otherSeats++;
      }
    }
  }
  const grand = sum(Object.values(total));
  const rows = Object.keys(total)
    .sort((a, b) => total[b] - total[a])
    .map((source) => ({
      source,
      meanPerPlayer: games.length ? total[source] / (games.length * P) : 0,
      share: grand ? total[source] / grand : 0,
      winnerMean: winnerSeats ? (winners[source] ?? 0) / winnerSeats : 0,
      otherMean: otherSeats ? (others[source] ?? 0) / otherSeats : 0,
    }));
  // per Hour bucket
  const bucketSource = Array.from({ length: 6 }, () => ({}));
  for (const r of games) for (let b = 0; b < 6; b++) addInto(bucketSource[b], r.vpBucketSource[b]);
  const bucketTotals = bucketSource.map((o) => sum(Object.values(o)));
  return {
    rows,
    grandMeanPerPlayer: games.length ? grand / (games.length * P) : 0,
    largest: rows.length ? { source: rows[0].source, share: rows[0].share } : null,
    byBucket: bucketSource.map((o, b) => ({ bucket: BUCKET_NAMES[b], total: bucketTotals[b], shares: shares(o) })),
  };
}

function pacingSection(games, P) {
  const bucketVp = Array(6).fill(0);
  for (const r of games) for (let b = 0; b < 6; b++) bucketVp[b] += sum(r.vpBucket[b]);
  const grand = sum(bucketVp);
  const share = bucketVp.map((v) => (grand ? v / grand : 0));
  // Does the leader after Hour h go on to win?
  const leaderWins = [];
  for (let h = 0; h < 5; h++) {
    let n = 0;
    let wins = 0;
    for (const r of games) {
      const cum = Array(r.players).fill(0);
      for (let b = 0; b <= h; b++) for (let s = 0; s < r.players; s++) cum[s] += r.vpBucket[b][s];
      const top = Math.max(...cum);
      const leaders = cum.map((v, s) => (v === top ? s : -1)).filter((s) => s >= 0);
      if (leaders.length !== 1 || top === 0) continue;
      n++;
      if (leaders[0] === r.winner) wins++;
    }
    leaderWins.push({ afterHour: h + 1, ...rateVs(wins, n, 1 / P), n });
  }
  return {
    buckets: BUCKET_NAMES.map((name, i) => ({ name, vp: bucketVp[i], share: share[i], meanPerPlayer: games.length ? bucketVp[i] / (games.length * P) : 0 })),
    hour5Share: share[4],
    finalScoringShare: share[5],
    finalHourWithEndScoring: share[4] + share[5],
    leaderAfterHourWins: leaderWins,
  };
}

function leadsSection(games) {
  const changes = games.map((r) => r.leadChanges);
  return {
    leadChanges: describe(changes),
    histogram: histogram(changes, [0, 1, 2, 3, 4, 5, 6, 8, 10, 15]),
  };
}

function actionsSection(games, P) {
  const { perPlayer: mixPer, total, playerGames } = perPlayer(games, (r, s) => r.actions[s]);
  const autoPer = perPlayer(games, (r, s) => r.autoActions[s]);
  const grand = sum(Object.values(total));
  const rows = Object.keys(total)
    .sort((a, b) => total[b] - total[a])
    .map((type) => ({ type, perPlayer: mixPer[type], share: grand ? total[type] / grand : 0, auto: autoPer.perPlayer[type] ?? 0, main: MAIN_ACTION_TYPES.includes(type) }));
  // by Hour: type -> [mean per player per game x 6]
  const hourTotals = {};
  eachSeat(games, (r, s) => {
    for (let b = 0; b < 6; b++) {
      for (const [type, n] of Object.entries(r.actionHour[s][b])) (hourTotals[type] ??= Array(6).fill(0))[b] += n;
    }
  });
  const byHour = {};
  for (const type of Object.keys(hourTotals).sort()) byHour[type] = hourTotals[type].map((v) => (playerGames ? v / playerGames : 0));
  // main-action mix (the nine main actions only, shares of main actions)
  const mainTotal = sum(MAIN_ACTION_TYPES.map((t) => total[t] ?? 0));
  const mainMix = MAIN_ACTION_TYPES.map((type) => ({ type, perPlayer: mixPer[type] ?? 0, share: mainTotal ? (total[type] ?? 0) / mainTotal : 0 }));
  const conv = perPlayer(games, (r, s) => r.conversions[s]);
  return { rows, byHour, mainMix, conversionsPerPlayer: conv.perPlayer, playerGames };
}

function branchingSection(games) {
  const t = { n: 0, sum: 0, distinct: 0, max: 0 };
  const ts = [0, 0, 0];
  const hour = Array.from({ length: 6 }, () => [0, 0, 0]);
  const tsHour = Array.from({ length: 6 }, () => [0, 0, 0]);
  const kind = {};
  const tsType = {};
  const offered = {};
  for (const r of games) {
    const b = r.branching;
    t.n += b.n;
    t.sum += b.sum;
    t.distinct += b.distinct;
    t.max = Math.max(t.max, b.max);
    for (let i = 0; i < 3; i++) ts[i] += b.turnStart[i];
    for (let h = 0; h < 6; h++) for (let i = 0; i < 3; i++) {
      hour[h][i] += b.hour[h][i];
      tsHour[h][i] += b.turnStartHour[h][i];
    }
    for (const [k, v] of Object.entries(b.kind)) {
      const a = (kind[k] ??= [0, 0, 0]);
      for (let i = 0; i < 3; i++) a[i] += v[i];
    }
    for (const [k, v] of Object.entries(b.turnStartByType)) {
      const a = (tsType[k] ??= [0, 0]);
      a[0] += v[0];
      a[1] += v[1];
    }
    addInto(offered, b.offered);
  }
  const avg = (a) => (a[0] ? { n: a[0], options: a[1] / a[0], types: a[2] / a[0] } : { n: 0, options: null, types: null });
  return {
    decisions: t.n,
    perDecision: t.n ? t.sum / t.n : null,
    distinctPerDecision: t.n ? t.distinct / t.n : null,
    max: t.max,
    atTurnStart: avg(ts),
    byHour: hour.map((a, i) => ({ name: BUCKET_NAMES[i], ...avg(a) })),
    turnStartByHour: tsHour.map((a, i) => ({ name: BUCKET_NAMES[i], ...avg(a) })),
    byFrame: Object.keys(kind).sort().map((k) => ({ frame: k, ...avg(kind[k]) })),
    turnStartByType: Object.keys(tsType).sort().map((type) => ({ type, offeredShare: ts[0] ? tsType[type][0] / ts[0] : 0, optionsWhenOffered: tsType[type][1] / tsType[type][0] })),
    offeredShare: Object.keys(offered).sort().map((type) => ({ type, share: t.n ? offered[type] / t.n : 0 })),
  };
}

function economySection(games, P) {
  const earned = perPlayer(games, (r, s) => r.coffee[s].earned);
  const lost = perPlayer(games, (r, s) => r.coffee[s].lost);
  const spent = perPlayer(games, (r, s) => r.coffee[s].spent);
  const gainC = perPlayer(games, (r, s) => r.selfies[s].gainedByColour);
  const gainK = perPlayer(games, (r, s) => r.selfies[s].gainedByCause);
  const spendC = perPlayer(games, (r, s) => r.selfies[s].spentByColour);
  const spendK = perPlayer(games, (r, s) => r.selfies[s].spentByCause);
  const earnedTotal = sum(Object.values(earned.perPlayer));
  const lostTotal = sum(Object.values(lost.perPlayer));
  const spentTotal = sum(Object.values(spent.perPlayer));
  const gainedSelfies = sum(Object.values(gainK.perPlayer));
  const spentSelfies = sum(Object.values(spendK.perPlayer));
  // Floor-end coffee and selfies held, per Hour (mean over seats and games).
  const coffeeHour = [];
  const selfieHour = [];
  const fullHallShare = [];
  for (let h = 0; h < 5; h++) {
    const cs = [];
    const ss = [];
    for (const r of games) {
      const f = r.floorEnd[h];
      if (!f) continue;
      cs.push(...f.coffee);
      ss.push(...f.selfies);
    }
    coffeeHour.push(mean(cs));
    selfieHour.push(mean(ss));
  }
  const final = {
    coffee: mean(games.flatMap((r) => r.final.map((f) => f.coffee))),
    handLeft: mean(games.flatMap((r) => r.final.map((f) => f.handLeft))),
  };
  return {
    coffeeEarned: earned.perPlayer,
    coffeeLostToCap: lost.perPlayer,
    coffeeSpent: spent.perPlayer,
    coffeeEarnedTotal: earnedTotal,
    coffeeLostTotal: lostTotal,
    coffeeSpentTotal: spentTotal,
    coffeeWasteShare: earnedTotal + lostTotal ? lostTotal / (earnedTotal + lostTotal) : 0,
    selfiesGainedByColour: gainC.perPlayer,
    selfiesGainedByCause: gainK.perPlayer,
    selfiesSpentByColour: spendC.perPlayer,
    selfiesSpentByCause: spendK.perPlayer,
    selfiesGainedTotal: gainedSelfies,
    selfiesSpentTotal: spentSelfies,
    coffeeHeldAtFloorEnd: coffeeHour,
    selfiesHeldAtFloorEnd: selfieHour,
    atGameEnd: final,
    passRewards: perPlayer(games, (r, s) => r.passRewards[s]).perPlayer,
    players: P,
  };
}

function queuesSection(games, P) {
  const halls = HALL_IDS.map((id, i) => ({ hall: id, name: HALL_NAME[id], i, crew: [], full: 0, multi: 0, snaps: 0, destinations: 0, queueLen: [], scoring: [], vpPaid: [], byHour: Array(5).fill(0), byHourN: Array(5).fill(0) }));
  const fullByHour = Array(5).fill(0);
  const snapsByHour = Array(5).fill(0);
  const crewByHour = Array(5).fill(0);
  const multiByHour = Array(5).fill(0);
  for (const r of games) {
    const cap = r.capacity;
    for (let h = 0; h < 5; h++) {
      const f = r.floorEnd[h];
      if (!f) continue;
      let crewTotal = 0;
      for (let i = 0; i < HALL_IDS.length; i++) {
        const row = f.halls[i];
        const hall = halls[i];
        hall.crew.push(row[0]);
        hall.snaps++;
        hall.byHour[h] += row[0];
        hall.byHourN[h]++;
        crewTotal += row[0];
        const owners = row.slice(1).filter((n) => n > 0).length;
        if (owners >= 2) {
          hall.multi++;
          multiByHour[h]++;
        }
        if (row[0] >= cap) {
          hall.full++;
          fullByHour[h]++;
        }
        snapsByHour[h]++;
      }
      crewByHour[h] += crewTotal;
    }
    for (const c of r.celebrities) {
      const hall = halls[HALL_IDS.indexOf(c.hall)];
      hall.destinations++;
      hall.queueLen.push(c.queueLen);
      hall.scoring.push(c.scoring);
      hall.vpPaid.push(sum(c.totals));
    }
  }
  const nCel = sum(games.map((r) => r.celebrities.length));
  return {
    halls: halls.map((h) => ({
      hall: h.hall,
      name: h.name,
      meanCrewAtFloorEnd: mean(h.crew),
      fullShare: h.snaps ? h.full / h.snaps : null,
      contestedShare: h.snaps ? h.multi / h.snaps : null,
      destinationShare: nCel ? h.destinations / nCel : 0,
      meanQueueAtScoring: mean(h.queueLen),
      meanScoringCrew: mean(h.scoring),
      meanVpPaid: mean(h.vpPaid),
      meanCrewByHour: h.byHour.map((v, k) => (h.byHourN[k] ? v / h.byHourN[k] : null)),
    })),
    byHour: [0, 1, 2, 3, 4].map((h) => ({
      name: BUCKET_NAMES[h],
      crewOnBoard: games.length ? crewByHour[h] / games.length : null,
      fullShare: snapsByHour[h] ? fullByHour[h] / snapsByHour[h] : null,
      contestedShare: snapsByHour[h] ? multiByHour[h] / snapsByHour[h] : null,
    })),
    capacity: games.length ? games[0].capacity : null,
    destinationQueue: describe(games.flatMap((r) => r.celebrities.map((c) => c.queueLen))),
    players: P,
  };
}

// --------------------------------------------------------------------------------------
// cards
// --------------------------------------------------------------------------------------

function achievementCards(games, P) {
  const rows = ACHIEVEMENT_CARDS.map((card) => ({
    id: card.id, name: card.name, laurel: card.laurel, held: 0, scoredPass: 0, scoredFinal: 0, scoredSwag: 0, positive: 0, vp: 0,
    discarded: 0, tripled: 0, wins: 0, positiveInstances: 0, countSum: 0, scored: 0,
  }));
  const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
  for (const r of games) {
    for (let s = 0; s < r.players; s++) for (const c of r.achHeld[s]) if (byId[c]) byId[c].held++;
    for (const a of r.achievements) {
      const row = byId[a.card];
      if (!row) continue;
      row.scored++;
      if (a.when === 'pass') row.scoredPass++;
      else if (a.when === 'final') row.scoredFinal++;
      else row.scoredSwag++;
      row.countSum += a.count;
      row.vp += a.vp;
      if (a.vp > 0) {
        row.positive++;
        row.positiveInstances++;
        if (a.seat === r.winner) row.wins++;
      }
      if (a.tripled) row.tripled++;
    }
    for (const d of r.achDiscarded) if (byId[d.card]) byId[d.card].discarded++;
  }
  return rows.map((row) => ({
    id: row.id, name: row.name, laurel: row.laurel,
    held: row.held,
    scored: row.scored, // card was scored (any count, including 0)
    completed: row.positive, // scored for at least 1 VP
    completionRate: row.held ? row.positive / row.held : null,
    meanCount: row.scored ? row.countSum / row.scored : null,
    meanVp: row.scored ? row.vp / row.scored : null,
    tripled: row.tripled,
    discarded: row.discarded,
    atFinal: row.scoredFinal,
    ...winStats(row.wins, row.positiveInstances, P),
  }));
}

function winStats(wins, n, P) {
  const v = rateVs(wins, n, 1 / P);
  return { winN: n, winRate: v.rate, winSigma: v.sigma };
}

function swagCards(games, P) {
  const rows = SWAG_CARDS.map((card) => ({
    id: card.id, name: card.name, colour: card.colour, cost: card.cost, seen: 0, bought: 0, boughtGamesSet: 0, wins: 0, hourSum: 0, vp: 0,
  }));
  const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
  for (const r of games) {
    for (const c of r.swagSeen) if (byId[c]) byId[c].seen++;
    for (const b of r.swag) {
      const row = byId[b.card];
      if (!row) continue;
      row.bought++;
      row.hourSum += b.hour;
      if (b.seat === r.winner) row.wins++;
    }
    for (const [card, vp] of Object.entries(r.swagVp)) if (byId[card]) byId[card].vp += vp;
  }
  return rows.map((row) => ({
    id: row.id, name: row.name, colour: row.colour, cost: row.cost,
    gamesSeen: row.seen, bought: row.bought,
    buyRate: row.seen ? row.bought / row.seen : null, // buys per game in which it appeared in the market
    meanHour: row.bought ? row.hourSum / row.bought : null,
    vp: row.vp,
    ...winStats(row.wins, row.bought, P),
  }));
}

function clubCards(games, P) {
  const rows = CLUB_CARDS.map((card) => ({
    id: card.id, name: card.name, holders: 0, wins: 0, uses: 0, usedGames: 0, vp: 0, scoreSum: 0,
  }));
  const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
  for (const r of games) {
    const usedHere = new Set();
    for (let s = 0; s < r.players; s++) {
      const club = r.clubs[s];
      if (!club || !byId[club]) continue;
      byId[club].holders++;
      byId[club].scoreSum += r.scores[s];
      if (s === r.winner) byId[club].wins++;
    }
    for (const u of r.clubUses) {
      if (byId[u.club]) byId[u.club].uses++;
      usedHere.add(u.club);
    }
    // Free-action Clubs are conversions, not main actions.
    for (let s = 0; s < r.players; s++) {
      const c = r.conversions[s];
      if (c['rare-finds']) {
        byId.club_07.uses += c['rare-finds'];
        usedHere.add('club_07');
      }
      if (c['strike-a-pose']) {
        byId.club_09.uses += c['strike-a-pose'];
        usedHere.add('club_09');
      }
    }
    for (const c of usedHere) if (byId[c]) byId[c].usedGames++;
    for (const [club, vp] of Object.entries(r.clubVp)) if (byId[club]) byId[club].vp += vp;
  }
  return rows.map((row) => ({
    id: row.id, name: row.name, holders: row.holders,
    usesPerHolder: row.holders ? row.uses / row.holders : null,
    usedInGameShare: row.holders ? row.usedGames / row.holders : null, // fraction of holder-games where it was used (approx: games it was used in / games held)
    vp: row.vp,
    meanScoreHolder: row.holders ? row.scoreSum / row.holders : null,
    ...winStats(row.wins, row.holders, P),
  }));
}

function celebrityCards(games, P) {
  const rows = CELEBRITY_CARDS.map((card) => ({
    id: card.id, name: card.name, rank: card.rank, method: card.scoring.method,
    appeared: 0, scored: 0, vp: 0, queueSum: 0, scoringSum: 0, winnerVp: 0, topIsWinner: 0, topDecided: 0, byHall: {},
  }));
  const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
  for (const r of games) {
    for (const s of r.schedule) if (byId[s.card]) byId[s.card].appeared++;
    for (const c of r.celebrities) {
      const row = byId[c.card];
      if (!row) continue;
      const total = sum(c.totals);
      row.scored++;
      row.vp += total;
      row.queueSum += c.queueLen;
      row.scoringSum += c.scoring;
      row.winnerVp += c.totals[r.winner];
      inc(row.byHall, c.hall);
      const top = Math.max(...c.totals);
      const tops = c.totals.map((v, s) => (v === top ? s : -1)).filter((s) => s >= 0);
      if (top > 0 && tops.length === 1) {
        row.topDecided++;
        if (tops[0] === r.winner) row.topIsWinner++;
      }
    }
  }
  return rows.map((row) => ({
    id: row.id, name: row.name, rank: row.rank, method: row.method,
    appeared: row.appeared,
    scored: row.scored,
    meanVp: row.scored ? row.vp / row.scored : null,
    meanQueue: row.scored ? row.queueSum / row.scored : null,
    meanScoringCrew: row.scored ? row.scoringSum / row.scored : null,
    winnerShare: row.vp ? row.winnerVp / row.vp : null, // share of the card's VP that went to the eventual winner (fair = 1/players)
    topScorerWins: row.topDecided ? row.topIsWinner / row.topDecided : null,
    topN: row.topDecided,
    topSigma: row.topDecided ? rateVs(row.topIsWinner, row.topDecided, 1 / P).sigma : null,
    destinations: row.byHall,
  }));
}

function celebrityRollups(games, P) {
  const groupBy = (keyOf) => {
    const g = {};
    for (const r of games) {
      for (const c of r.celebrities) {
        const k = keyOf(c, r);
        const a = (g[k] ??= { n: 0, vp: 0, q: 0, scoring: 0, winnerVp: 0 });
        a.n++;
        a.vp += sum(c.totals);
        a.q += c.queueLen;
        a.scoring += c.scoring;
        a.winnerVp += c.totals[r.winner];
      }
    }
    return Object.keys(g).sort().map((k) => ({ key: k, n: g[k].n, meanVp: g[k].vp / g[k].n, meanQueue: g[k].q / g[k].n, meanScoringCrew: g[k].scoring / g[k].n, winnerShare: g[k].vp ? g[k].winnerVp / g[k].vp : null }));
  };
  return {
    byMethod: groupBy((c) => c.method),
    byColour: groupBy((c) => c.colour),
    byHour: groupBy((c) => `Hour ${c.hour}`),
    bySlot: groupBy((c) => `slot ${c.slot}`),
    byHall: groupBy((c) => HALL_NAME[c.hall] ?? c.hall),
    fairWinnerShare: 1 / P,
  };
}

// --------------------------------------------------------------------------------------
// public
// --------------------------------------------------------------------------------------

/**
 * @param {object[]} records the per-game records of one player count (failed ones included)
 * @param {{ players?: number }} [opts]
 */
export function aggregate(records, opts = {}) {
  const P = opts.players ?? (records.length ? records[0].players : 0);
  const failedGames = records.filter((r) => r.failed);
  const finished = records.filter((r) => !r.failed);
  const capped = finished.filter((r) => r.turnCapped);
  const engineCapped = finished.filter((r) => r.end && r.end.reason === 'engine-action-cap');
  const games = finished.filter((r) => !r.turnCapped);
  const failedBy = (type) => failedGames.filter((r) => r.failed.type === type).length;

  const counts = {
    games: records.length,
    finished: finished.length,
    analysed: games.length,
    turnLimit: capped.length,
    engineActionCap: engineCapped.length,
    decisionCapHits: failedBy('cap'),
    refusals: failedBy('refusal'),
    errors: failedBy('error'),
    integrity: failedBy('integrity'),
    failures: failedGames.slice(0, 5).map((r) => ({ index: r.index, seed: r.seed, type: r.failed.type, reason: r.failed.reason })),
  };

  const out = { players: P, counts };
  if (games.length === 0) {
    out.empty = true;
    out.health = evaluateHealth(out);
    return out;
  }

  out.length = lengthSection(games, P);
  out.scores = scoresSection(games, P);
  out.margin = marginSection(games);
  out.seats = seatsSection(games, P);
  out.levels = levelsSection(games, P);
  out.vpSources = vpSourcesSection(games, P);
  out.pacing = pacingSection(games, P);
  out.leads = leadsSection(games);
  out.actions = actionsSection(games, P);
  out.branching = branchingSection(games);
  out.economy = economySection(games, P);
  out.queues = queuesSection(games, P);
  out.cards = {
    achievements: achievementCards(games, P),
    swag: swagCards(games, P),
    clubs: clubCards(games, P),
    celebrities: celebrityCards(games, P),
    celebrityRollups: celebrityRollups(games, P),
  };
  out.subsystems = subsystemDefs().map(([id, label, test, rare]) => {
    const n = games.filter(test).length;
    return { id, label, games: n, share: n / games.length, rare: Boolean(rare) };
  });
  out.allFinished = capped.length > 0 ? headline(finished) : null;
  out.health = evaluateHealth(out);
  return out;
}
