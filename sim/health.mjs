// health.mjs - the health-threshold table of the web-board-game skill, as data.
//
// THE THRESHOLDS LIVE HERE AND NOWHERE ELSE. Edit this table to move a limit; the
// terminal report, the JSON summary and the HTML report all read the result.
//
// A rule is one of:
//   { kind: 'range', min, max }   OK when min <= value <= max (either end may be null = open)
//   { kind: 'below', max }        OK when value < max (the skill's "any single source < 45%")
//   { kind: 'sigma', max }        OK when |sigma| < max
//   { kind: 'zero' }              OK when value === 0 (counts of failures)
//   { kind: 'info' }              no target yet: shown, status 'n/a'
// Status is 'OK', 'WARN' or 'n/a' (no figure, or no target).
//
// Source: skills/web-board-game "Health thresholds". How this table reads them for Superfans:
//  - "legal actions per turn" is the number of legal actions at the FIRST decision of a turn.
//    The engine lists one action per (Crew, destination) for Move 2 and per (Volunteer space) for
//    Volunteer, so this number is large by construction; see the 'options by type' table.
//  - "VP in the final quarter" is Hour 5 plus final scoring (R22), the last of five Hours.
//  - The seat check is 2.5 sigma for "any seat" (five seats make a 2-sigma outlier likely by
//    chance) and 2 sigma for the first player, as the skill says.

export const HEALTH_TABLE = [
  {
    id: 'winningScore',
    label: 'Winning score',
    unit: 'VP',
    rule: { kind: 'info' }, // no design target score yet: set { kind: 'range', min, max } when the designer has one
    bad: 'Inflation is usually a per-piece multiplier.',
    value: (a) => a.scores?.winning.mean ?? null,
  },
  {
    id: 'margin',
    label: 'Margin as % of winner',
    unit: '%',
    rule: { kind: 'range', min: 15, max: 22 },
    bad: 'Above 25: blowouts.',
    value: (a) => a.margin?.marginPct.mean ?? null,
  },
  {
    id: 'within10',
    label: 'Games decided inside 10% of the winner',
    unit: '%',
    rule: { kind: 'range', min: 25, max: null },
    bad: 'Endings are not close.',
    value: (a) => (a.margin ? a.margin.within10.value * 100 : null),
  },
  {
    id: 'firstPlayer',
    label: 'First-player win rate (Hour 1 first player)',
    unit: '%',
    rule: { kind: 'sigma', max: 2 },
    bad: 'A positional problem. Never read it without --jitter for deterministic bots.',
    value: (a) => (a.seats ? a.seats.firstPlayer.rate * 100 : null),
    sigma: (a) => a.seats?.firstPlayer.sigma ?? null,
  },
  {
    id: 'seatBias',
    label: 'Largest seat win-rate deviation',
    unit: 'sigma',
    rule: { kind: 'sigma-value', max: 2.5 },
    bad: 'A seat wins more or less than its share: seat order, setup or a bot artefact.',
    value: (a) => a.seats?.maxSeatSigma ?? null,
  },
  {
    id: 'leadChanges',
    label: 'Lead changes per game',
    unit: '',
    rule: { kind: 'range', min: 5, max: null },
    bad: 'Under 2: the leader is never challenged.',
    value: (a) => a.leads?.leadChanges.mean ?? null,
  },
  {
    id: 'finalQuarter',
    label: 'VP earned in the final Hour (Hour 5 plus final scoring)',
    unit: '%',
    rule: { kind: 'range', min: 30, max: null },
    bad: 'Flat pacing, no climax.',
    value: (a) => (a.pacing ? a.pacing.finalHourWithEndScoring * 100 : null),
  },
  {
    id: 'legalActions',
    label: 'Legal actions at a turn\'s first decision',
    unit: '',
    rule: { kind: 'range', min: 8, max: 12 },
    bad: 'Under 5: forced moves. Over 20: analysis paralysis (but see the note: one action per Crew x destination).',
    value: (a) => a.branching?.atTurnStart.options ?? null,
  },
  {
    id: 'distinctTypes',
    label: 'Distinct action types offered at a turn\'s first decision',
    unit: '',
    rule: { kind: 'range', min: 2.5, max: null },
    bad: 'One obvious move.',
    value: (a) => a.branching?.atTurnStart.types ?? null,
  },
  {
    id: 'singleSource',
    label: 'Largest single VP source (share of all VP)',
    unit: '%',
    rule: { kind: 'below', max: 45 },
    bad: 'The other sources are decoration.',
    value: (a) => (a.vpSources?.largest ? a.vpSources.largest.share * 100 : null),
    detail: (a) => a.vpSources?.largest?.source ?? null,
  },
  {
    id: 'turnLimit',
    label: 'Games ending by a safety stop (turn-capped)',
    unit: 'games',
    rule: { kind: 'zero' },
    bad: 'Livelock or dead end: investigate, never average away. These games are excluded from the means.',
    value: (a) => a.counts.turnLimit,
  },
  {
    id: 'decisionCap',
    label: 'Games hitting the harness decision cap',
    unit: 'games',
    rule: { kind: 'zero' },
    bad: 'A livelock the harness caught.',
    value: (a) => a.counts.decisionCapHits,
  },
  {
    id: 'refusals',
    label: 'Refused bot actions, crashes and bookkeeping mismatches',
    unit: 'games',
    rule: { kind: 'zero' },
    bad: 'The engine\'s action list and its mutators disagree, or events and scores disagree: an engine or harness bug.',
    value: (a) => a.counts.refusals + a.counts.errors + a.counts.integrity,
  },
  {
    id: 'usage',
    label: 'Subsystems never used in any game',
    unit: 'subsystems',
    rule: { kind: 'zero' },
    bad: 'Zero usage is a plumbing bug first, a design finding second.',
    value: (a) => (a.subsystems ? a.subsystems.filter((s) => !s.rare && s.games === 0).length : null),
    detail: (a) => (a.subsystems ? a.subsystems.filter((s) => !s.rare && s.games === 0).map((s) => s.id).join(', ') : null),
  },
];

export function describeRule(rule) {
  switch (rule.kind) {
    case 'range':
      if (rule.min !== null && rule.max !== null) return `${rule.min} to ${rule.max}`;
      if (rule.min !== null) return `at least ${rule.min}`;
      return `at most ${rule.max}`;
    case 'below':
      return `under ${rule.max}`;
    case 'sigma':
      return `within ${rule.max} sigma of 1/players`;
    case 'sigma-value':
      return `under ${rule.max} sigma`;
    case 'zero':
      return 'none (0)';
    default:
      return 'no target yet';
  }
}

function judge(rule, value, sigma) {
  if (rule.kind === 'info') return 'n/a';
  if (rule.kind === 'sigma') {
    if (sigma === null || sigma === undefined) return 'n/a';
    return Math.abs(sigma) < rule.max ? 'OK' : 'WARN';
  }
  if (value === null || value === undefined || Number.isNaN(value)) return 'n/a';
  switch (rule.kind) {
    case 'sigma-value':
      return Math.abs(value) < rule.max ? 'OK' : 'WARN';
    case 'zero':
      return value === 0 ? 'OK' : 'WARN';
    case 'below':
      return value < rule.max ? 'OK' : 'WARN';
    case 'range':
      if (rule.min !== null && value < rule.min) return 'WARN';
      if (rule.max !== null && value > rule.max) return 'WARN';
      return 'OK';
    default:
      return 'n/a';
  }
}

/** Evaluates the table against an aggregate. Rows: { id, label, value, unit, healthy, status, sigma?, detail?, bad }. */
export function evaluateHealth(agg) {
  return HEALTH_TABLE.map((def) => {
    const value = def.value(agg);
    const sigma = def.sigma ? def.sigma(agg) : null;
    const row = { id: def.id, label: def.label, unit: def.unit, healthy: describeRule(def.rule), value, status: judge(def.rule, value, sigma), bad: def.bad };
    if (def.sigma) row.sigma = sigma;
    if (def.detail) row.detail = def.detail(agg);
    return row;
  });
}
