// sim-report.mjs - prints the designer report for one or more simulator outputs.
//
//   node sim/sim-report.mjs <output.json> [<output.json> ...] [--section=cards] [--top=20]
//
// The report is recomputed from the per-game records in the file with sim/aggregate.mjs, so it
// always reflects the current aggregator. Also used by sim.mjs at the end of a run.
// Health rows are marked OK or WARN against sim/health.mjs.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { aggregate } from './aggregate.mjs';

const SECTIONS = ['health', 'integrity', 'length', 'scores', 'seats', 'vp', 'pacing', 'leads', 'actions', 'branching', 'economy', 'queues', 'achievements', 'swag', 'clubs', 'celebrities', 'subsystems'];

// ---- formatting ----------------------------------------------------------------------

const f = (x, d = 1) => (x === null || x === undefined || Number.isNaN(x) ? '-' : Number(x).toFixed(d));
const pc = (x, d = 0) => (x === null || x === undefined || Number.isNaN(x) ? '-' : `${(x * 100).toFixed(d)}%`);
const sg = (x) => (x === null || x === undefined || Number.isNaN(x) ? '' : `${x >= 0 ? '+' : ''}${x.toFixed(1)}σ`);

function table(head, rows, { left = 1 } = {}) {
  const all = [head, ...rows].map((r) => r.map((c) => String(c ?? '')));
  const widths = head.map((_, i) => Math.max(...all.map((r) => (r[i] ?? '').length)));
  const line = (r) => r.map((c, i) => (i < left ? c.padEnd(widths[i]) : c.padStart(widths[i]))).join('  ');
  const out = [line(all[0]), widths.map((w) => '-'.repeat(w)).join('  ')];
  for (let i = 1; i < all.length; i++) out.push(line(all[i]));
  return out.map((l) => '  ' + l).join('\n');
}

function title(text) {
  return `\n${text}\n${'='.repeat(text.length)}`;
}

function bar(share, width = 24) {
  const n = Math.max(0, Math.min(width, Math.round(share * width)));
  return '#'.repeat(n);
}

function winCell(rate, sigma) {
  if (rate === null || rate === undefined) return '-';
  const flag = sigma !== null && sigma !== undefined && Math.abs(sigma) >= 2 ? ' *' : '';
  return `${pc(rate)} ${sg(sigma)}${flag}`;
}

function desc(d, digits = 1) {
  if (!d || d.n === 0) return '-';
  return `mean ${f(d.mean, digits)}  sd ${f(d.sd, digits)}  min ${f(d.min, 0)}  median ${f(d.median, digits)}  max ${f(d.max, 0)}`;
}

// ---- sections ------------------------------------------------------------------------

function sHealth(a) {
  const rows = a.health.map((h) => {
    const val = h.value === null || h.value === undefined ? '-' : h.unit === '%' ? `${f(h.value, 1)}%` : f(h.value, h.unit === 'games' || h.unit === 'subsystems' ? 0 : 2);
    const extra = h.sigma !== undefined && h.sigma !== null ? ` (${sg(h.sigma)})` : '';
    return [h.status, h.label, val + extra, h.healthy, h.detail && String(h.detail).length <= 24 ? String(h.detail) : ''];
  });
  const warns = a.health.filter((h) => h.status === 'WARN');
  const lines = [title('1. Health vs thresholds (web-board-game skill)'), table(['', 'metric', 'value', 'healthy', 'note'], rows, { left: 2 })];
  if (warns.length) {
    lines.push('\n  WARN notes:');
    for (const w of warns) {
      lines.push(`   - ${w.label}: ${w.bad}`);
      if (w.detail && String(w.detail).length > 24) lines.push(`       ${w.detail}`);
    }
  }
  return lines.join('\n');
}

function sIntegrity(a) {
  const c = a.counts;
  const lines = [title('2. Run integrity')];
  lines.push(`  games ${c.games}   finished ${c.finished}   analysed ${c.analysed} (turn-capped games are excluded from every mean below)`);
  lines.push(`  turn-capped (safety stop) ${c.turnLimit}   engine-action cap ${c.engineActionCap}   harness decision cap ${c.decisionCapHits}`);
  lines.push(`  refused actions ${c.refusals}   crashes ${c.errors}   bookkeeping mismatches ${c.integrity}   (bookkeeping = VP, coffee and selfies from events == engine totals, per seat)`);
  for (const x of c.failures) lines.push(`   FAILED game ${x.index} (seed ${x.seed}) ${x.type}: ${String(x.reason).slice(0, 300)}`);
  if (a.allFinished) {
    const h = a.allFinished;
    lines.push(`  With the ${c.turnLimit} turn-capped game(s) included: winning score mean ${f(h.winningScore.mean)}, margin ${f(h.marginPct.mean)}%, within 10% ${pc(h.within10.value)}, decisions mean ${f(h.decisions.mean, 0)}`);
  }
  return lines.join('\n');
}

function sLength(a) {
  const L = a.length;
  const lines = [title('3. Game length')];
  lines.push(`  decisions per game      ${desc(L.decisions, 0)}`);
  lines.push(`  engine actions          ${desc(L.engineActions, 0)}   (auto-applied forced choices: ${pc(L.autoShare)})`);
  lines.push(`  turns per game (all seats, On the Floor) ${desc(L.turnsPerGame, 0)}`);
  lines.push(`  main actions per player ${desc(L.mainActionsPerPlayer)}  (per Hour ${f(L.mainActionsPerPlayerPerHour.mean)})`);
  lines.push(`  milliseconds per game   ${desc(L.msPerGame, 0)}`);
  lines.push(table(['', 'Hour 1', 'Hour 2', 'Hour 3', 'Hour 4', 'Hour 5'], [
    ['turns (all seats)', ...L.turnsPerHour.map((x) => f(x))],
    ['pass-turns (after passing)', ...L.passTurnsPerHour.map((x) => f(x))],
  ]));
  return lines.join('\n');
}

function sScores(a) {
  const S = a.scores;
  const M = a.margin;
  const lines = [title('4. Scores and closeness')];
  lines.push(`  winning score  ${desc(S.winning)}`);
  lines.push(`  all scores     ${desc(S.all)}`);
  lines.push(`  top - bottom   ${desc(S.spread)}`);
  lines.push(`  margin (winner - 2nd) as % of winner  ${desc(M.marginPct)}   [healthy 15-22%]`);
  lines.push(`  games decided inside 10%: ${pc(M.within10.value)} (n=${M.within10.n})   [healthy 25%+]    tied on VP at the top: ${pc(M.tiedOnVp.value)}`);
  lines.push(table(['rank', 'mean score', 'sd', 'min', 'max'], S.byRank.map((r) => [r.rank, f(r.mean), f(r.sd), f(r.min, 0), f(r.max, 0)])));
  lines.push(`  winning-score histogram (bin width ${S.histogramStep}):`);
  const total = S.winningHistogram.reduce((x, b) => x + b.n, 0) || 1;
  for (const b of S.winningHistogram) if (b.n > 0) lines.push(`   ${String(b.lo).padStart(4)}+ ${String(b.n).padStart(4)} ${bar(b.n / total, 40)}`);
  return lines.join('\n');
}

function sSeats(a) {
  const X = a.seats;
  const lines = [title('5. Who wins: seats, turn order and bot levels')];
  lines.push(`  fair share ${pc(1 / a.players, 1)};  * = at least 2 sigma from fair.  Win = rank 1 after the R22.6 tie-break.`);
  lines.push('  By seat:');
  lines.push(table(['seat', 'wins', 'win rate (sigma)', 'mean rank', 'mean score'], X.seat.map((s, i) => [s.seat, s.wins, winCell(s.rate, s.sigma), f(s.meanRank, 2), f(a.scores.bySeat[i].mean)])));
  lines.push('  By turn-order position (1 = first player in Hour 1):');
  lines.push(table(['position', 'wins', 'win rate (sigma)', 'mean score'], X.position.map((s) => [s.position, s.wins, winCell(s.rate, s.sigma), f(s.meanScore)])));
  if (a.levels.mixed) {
    lines.push('  By bot level (expected share = seats held / players):');
    lines.push(table(['level', 'seats', 'wins', 'win rate vs expected', 'expected', 'mean score', 'mean rank'], a.levels.rows.map((r) => [r.level, r.seats, r.wins, winCell(r.rate, r.sigma), pc(r.expected), f(r.meanScore), f(r.meanRank, 2)])));
  }
  return lines.join('\n');
}

function sVp(a) {
  const V = a.vpSources;
  const lines = [title('6. Where the points come from (VP events by source)')];
  lines.push(`  mean VP per player per game ${f(V.grandMeanPerPlayer)}`);
  lines.push(table(['source', 'share', '', 'VP/player', 'winner mean', 'others mean'], V.rows.map((r) => [r.source, pc(r.share, 1), bar(r.share), f(r.meanPerPlayer), f(r.winnerMean), f(r.otherMean)])));
  lines.push('  Share of each Hour\'s VP by source:');
  const sources = V.rows.map((r) => r.source);
  const short = (s) => s.replace('achievement', 'ach').replace('final-selfies', 'fin-selfie');
  lines.push(table(['', ...sources.map(short)], V.byBucket.map((b) => [b.bucket, ...sources.map((s) => pc(b.shares[s] ?? 0))])));
  return lines.join('\n');
}

function sPacing(a) {
  const P = a.pacing;
  const lines = [title('7. Pacing')];
  lines.push(table(['', 'VP share', '', 'VP/player'], P.buckets.map((b) => [b.name, pc(b.share, 1), bar(b.share, 30), f(b.meanPerPlayer)])));
  lines.push(`  Final Hour with end scoring: ${pc(P.finalHourWithEndScoring, 1)}   [healthy 30%+]   (Hour 5 alone ${pc(P.hour5Share, 1)}, final scoring alone ${pc(P.finalScoringShare, 1)})`);
  lines.push('  Does the sole leader after Hour h go on to win? (fair = 1/players)');
  lines.push(table(['after', 'n', 'leader wins (sigma)'], P.leaderAfterHourWins.map((l) => [`Hour ${l.afterHour}`, l.n, winCell(l.rate, l.sigma)])));
  return lines.join('\n');
}

function sLeads(a) {
  const L = a.leads;
  const lines = [title('8. Lead changes')];
  lines.push(`  per game ${desc(L.leadChanges)}   [healthy 5+; under 2 = leader never challenged]`);
  const total = L.histogram.reduce((x, b) => x + b.n, 0) || 1;
  for (const b of L.histogram) lines.push(`   ${String(b.lo).padStart(3)}${b.hi === null ? '+' : b.hi - b.lo > 1 ? `-${b.hi - 1}` : ' '} ${String(b.n).padStart(4)} ${bar(b.n / total, 40)}`);
  return lines.join('\n');
}

function sActions(a) {
  const A = a.actions;
  const lines = [title('9. Action mix (chosen actions per player per game)')];
  lines.push(table(['action', 'per player', 'share', '', 'auto', 'kind'], A.rows.map((r) => [r.type, f(r.perPlayer, 2), pc(r.share, 1), bar(r.share * 2, 20), f(r.auto, 2), r.main ? 'main' : '']), { left: 1 }));
  const types = Object.keys(A.byHour);
  lines.push('  Per Hour (per player per game):');
  lines.push(table(['action', 'H1', 'H2', 'H3', 'H4', 'H5', 'Final'], types.map((t) => [t, ...A.byHour[t].map((x) => f(x, 2))])));
  const conv = Object.entries(A.conversionsPerPlayer).map(([k, v]) => `${k} ${f(v, 2)}`).join('   ');
  lines.push(`  Free conversions per player per game: ${conv || 'none'}`);
  return lines.join('\n');
}

function sBranching(a) {
  const B = a.branching;
  const lines = [title('10. Decision space (legal actions the engine offers)')];
  lines.push(`  decisions ${B.decisions}   mean legal ${f(B.perDecision)} (distinct types ${f(B.distinctPerDecision, 2)})   largest ${B.max}`);
  lines.push(`  At a turn's first decision: mean ${f(B.atTurnStart.options)} options, ${f(B.atTurnStart.types, 2)} distinct types   [healthy 8-12 / 2.5+; Move 2 and Volunteer list one action per Crew x hall or space]`);
  lines.push(table(['Hour', 'decisions', 'mean legal', 'types', 'turn-start legal', 'turn-start types'], B.byHour.map((h, i) => [h.name, h.n, f(h.options), f(h.types, 2), f(B.turnStartByHour[i].options), f(B.turnStartByHour[i].types, 2)])));
  lines.push('  By decision frame:');
  lines.push(table(['frame', 'decisions', 'mean legal', 'types'], B.byFrame.map((k) => [k.frame, k.n, f(k.options), f(k.types, 2)])));
  lines.push('  At a turn\'s first decision, per action type:');
  lines.push(table(['type', 'offered in', 'options when offered'], B.turnStartByType.map((t) => [t.type, pc(t.offeredShare), f(t.optionsWhenOffered)])));
  return lines.join('\n');
}

function kv(obj, d = 2) {
  return Object.entries(obj).filter(([, v]) => v > 0).sort((x, y) => y[1] - x[1]).map(([k, v]) => `${k} ${f(v, d)}`).join('   ');
}

function sEconomy(a) {
  const E = a.economy;
  const lines = [title('11. Economy (per player per game)')];
  lines.push(`  coffee earned ${f(E.coffeeEarnedTotal)}   lost over the cap ${f(E.coffeeLostTotal)} (${pc(E.coffeeWasteShare)} of coffee offered)   spent ${f(E.coffeeSpentTotal)}`);
  lines.push(`   earned by cause: ${kv(E.coffeeEarned)}`);
  lines.push(`   lost by cause:   ${kv(E.coffeeLostToCap)}`);
  lines.push(`   spent on:        ${kv(E.coffeeSpent)}`);
  lines.push(`  selfies gained ${f(E.selfiesGainedTotal)}   spent ${f(E.selfiesSpentTotal)}   (colour gained: ${kv(E.selfiesGainedByColour)})`);
  lines.push(`   gained by cause: ${kv(E.selfiesGainedByCause)}`);
  lines.push(`   spent by cause:  ${kv(E.selfiesSpentByCause)}`);
  lines.push(`   spent by colour: ${kv(E.selfiesSpentByColour)}`);
  lines.push(`  pass-ladder rewards taken: ${kv(E.passRewards)}`);
  lines.push(table(['mean held at the end of the Floor', 'H1', 'H2', 'H3', 'H4', 'H5'], [
    ['coffee', ...E.coffeeHeldAtFloorEnd.map((x) => f(x))],
    ['selfies (all colours)', ...E.selfiesHeldAtFloorEnd.map((x) => f(x))],
  ]));
  lines.push(`  at the very end: coffee ${f(E.atGameEnd.coffee)}   Achievements still in hand ${f(E.atGameEnd.handLeft, 2)}`);
  return lines.join('\n');
}

function sQueues(a) {
  const Q = a.queues;
  const lines = [title('12. Board: queues and contention')];
  lines.push(`  hall capacity ${Q.capacity}.  "full" and "contested" (two or more owners present) are shares of end-of-Floor snapshots. Destination columns are for the celebrity's final hall each Hour.`);
  lines.push(table(['hall', 'crew', 'full', 'contested', 'is destination', 'queue at scoring', 'scoring crew', 'VP paid'], Q.halls.map((h) => [h.name, f(h.meanCrewAtFloorEnd, 2), pc(h.fullShare), pc(h.contestedShare), pc(h.destinationShare), f(h.meanQueueAtScoring, 2), f(h.meanScoringCrew, 2), f(h.meanVpPaid)])));
  lines.push(table(['', 'crew on board', 'halls full', 'halls contested'], Q.byHour.map((h) => [h.name, f(h.crewOnBoard), pc(h.fullShare), pc(h.contestedShare)])));
  lines.push(`  queue length at the destination when it scores: ${desc(Q.destinationQueue)}`);
  return lines.join('\n');
}

function topN(rows, n) {
  return n && rows.length > n ? rows.slice(0, n) : rows;
}

function sAchievements(a, top) {
  const rows = a.cards.achievements;
  const lines = [title('13. Achievements (per card)')];
  lines.push('  held = dealt to a seat at any time; completed = scored for 1+ VP; win% = share of completions by the eventual winner (fair = 1/players, * = 2 sigma)');
  lines.push(table(['card', 'name', 'laurel', 'held', 'completed', 'rate', 'mean VP', 'tripled', 'discarded', 'n', 'win%'], topN(rows, top).map((r) => [r.id.replace('scoring_', ''), r.name.slice(0, 28), r.laurel, r.held, r.completed, pc(r.completionRate), f(r.meanVp), r.tripled, r.discarded, r.winN, winCell(r.winRate, r.winSigma)]), { left: 2 }));
  const zero = rows.filter((r) => r.held > 0 && r.completed === 0);
  if (zero.length) lines.push(`  NEVER completed although held: ${zero.map((r) => r.id.replace('scoring_', '#')).join(', ')}`);
  return lines.join('\n');
}

function sSwag(a, top) {
  const rows = a.cards.swag;
  const lines = [title('14. Swag (per card)')];
  lines.push('  seen = games in which it appeared in the market; buy rate = purchases per game seen; win% = share of buyers who won (fair = 1/players)');
  lines.push(table(['card', 'name', 'cost', 'seen', 'bought', 'buy rate', 'mean Hour', 'VP', 'n', 'buyer win%'], topN(rows, top).map((r) => [r.id.replace('swag_', ''), r.name.slice(0, 22), `${r.cost} ${r.colour.slice(0, 1)}`, r.gamesSeen, r.bought, pc(r.buyRate), f(r.meanHour), r.vp, r.winN, winCell(r.winRate, r.winSigma)]), { left: 2 }));
  const zero = rows.filter((r) => r.gamesSeen > 0 && r.bought === 0);
  if (zero.length) lines.push(`  NEVER bought although seen: ${zero.map((r) => r.id.replace('swag_', '')).join(', ')}`);
  return lines.join('\n');
}

function sClubs(a) {
  const rows = a.cards.clubs;
  const lines = [title('15. Clubs (per card)')];
  lines.push('  holder win% = share of games in which the seat holding this Club won (fair = 1/players)');
  lines.push(table(['club', 'name', 'held', 'uses/holder', 'used in', 'VP', 'holder mean score', 'holder win%'], rows.map((r) => [r.id.replace('club_', ''), r.name, r.holders, f(r.usesPerHolder, 2), pc(r.usedInGameShare), r.vp, f(r.meanScoreHolder), winCell(r.winRate, r.winSigma)]), { left: 2 }));
  return lines.join('\n');
}

function sCelebrities(a, top) {
  const rows = a.cards.celebrities;
  const R = a.cards.celebrityRollups;
  const lines = [title('16. Celebrities (per card, then by method, colour and Hour)')];
  lines.push(`  winner share = fraction of the card's VP won by the eventual winner (fair ${pc(R.fairWinnerShare)}); top-scorer wins = how often whoever scored most at it won the game`);
  lines.push(table(['card', 'name', 'rank', 'method', 'in schedule', 'scored', 'mean VP', 'queue', 'scoring crew', 'winner share', 'top wins'], topN(rows, top).map((r) => [r.id.replace('character_', ''), r.name.slice(0, 20), r.rank, r.method, r.appeared, r.scored, f(r.meanVp), f(r.meanQueue, 1), f(r.meanScoringCrew, 1), pc(r.winnerShare), r.topN ? `${pc(r.topScorerWins)} (n=${r.topN})` : '-']), { left: 2 }));
  const roll = (label, list) => {
    lines.push(`  By ${label}:`);
    lines.push(table([label, 'scorings', 'mean VP', 'queue', 'scoring crew', 'winner share'], list.map((x) => [x.key, x.n, f(x.meanVp), f(x.meanQueue, 2), f(x.meanScoringCrew, 2), pc(x.winnerShare)])));
  };
  roll('method', R.byMethod);
  roll('colour', R.byColour);
  roll('Hour', R.byHour);
  roll('hall', R.byHall);
  return lines.join('\n');
}

function sSubsystems(a) {
  const lines = [title('17. Subsystem usage (share of games; ZERO is flagged: plumbing bug first, design finding second)')];
  const rows = a.subsystems.map((s) => [s.games === 0 && !s.rare ? 'ZERO' : s.games === 0 ? 'rare' : '', s.id, s.label, s.games, pc(s.share)]);
  lines.push(table(['', 'id', 'subsystem', 'games', 'share'], rows, { left: 3 }));
  return lines.join('\n');
}

// ---- public --------------------------------------------------------------------------

const RENDER = {
  health: sHealth, integrity: sIntegrity, length: sLength, scores: sScores, seats: sSeats, vp: sVp, pacing: sPacing, leads: sLeads,
  actions: sActions, branching: sBranching, economy: sEconomy, queues: sQueues, achievements: sAchievements, swag: sSwag, clubs: sClubs,
  celebrities: sCelebrities, subsystems: sSubsystems,
};

/** Describes the run in a few lines. `plan` comes from the output file's `plan` (or meta). */
export function describeRun(plan, a) {
  const c = a.counts;
  const lines = [];
  lines.push(`SUPERFANS SIMULATION  ${a.players} players, ${c.games} games, bots ${[...new Set(plan.levels ?? [])].join('/')} (jitter ${plan.jitter}, ${plan.rotate ? 'rotating' : 'fixed'} seats), seed "${plan.seed}"`);
  const v = Object.entries(plan.variants ?? {}).map(([k, x]) => `${k}=${x}`);
  const k = plan.constantFlags ?? [];
  lines.push(`variants: ${v.length ? v.join(', ') : 'defaults'}   constants: ${k.length ? k.join(', ') : 'defaults'}${plan.label ? `   label: ${plan.label}` : ''}`);
  return lines.join('\n');
}

/** The whole report as text. `only` = list of section names, `top` = limit for per-card tables. */
export function renderReport(a, plan, { only = null, top = 0 } = {}) {
  const lines = [describeRun(plan, a)];
  if (a.empty) {
    lines.push(sIntegrity(a), sHealth(a));
    lines.push('\n  No analysable games (every game failed or was turn-capped).');
    return lines.join('\n');
  }
  for (const name of SECTIONS) {
    if (only && !only.includes(name)) continue;
    lines.push(RENDER[name](a, top));
  }
  return lines.join('\n') + '\n';
}

function main(argv) {
  const files = [];
  let only = null;
  let top = 0;
  for (const arg of argv) {
    if (arg.startsWith('--section=')) only = arg.slice(10).split(',');
    else if (arg.startsWith('--top=')) top = Number(arg.slice(6));
    else if (arg === '--help') {
      console.log(`node sim/sim-report.mjs <output.json> [more.json] [--section=${SECTIONS.join(',')}] [--top=N]`);
      return 0;
    } else if (arg.startsWith('--')) {
      console.error(`Unknown flag ${arg}`);
      return 2;
    } else files.push(arg);
  }
  if (files.length === 0) {
    console.error('Give one or more simulator output files (see sim.mjs --out).');
    return 2;
  }
  if (only) {
    const bad = only.filter((s) => !SECTIONS.includes(s));
    if (bad.length) {
      console.error(`Unknown section(s): ${bad.join(', ')}. Sections: ${SECTIONS.join(', ')}`);
      return 2;
    }
  }
  for (const file of files) {
    const data = JSON.parse(readFileSync(resolve(file), 'utf8'));
    const a = aggregate(data.games, { players: data.players });
    console.log(renderReport(a, data.plan, { only, top }));
  }
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(main(process.argv.slice(2)));
