// args.mjs - command-line parsing for sim.mjs.
//
// The variant and constant flags are GENERATED from the engine tables, so a
// variant or constant added to src/engine/variants.js or rules.js is accepted
// here with no change to this file:
//
//   --variant.<name>=<value>           every VARIANTS entry (R26), values checked
//   --const.<GROUP>.<PATH>=<value>     every R27 constant, PATH = nested keys joined by "."
//
// Unknown flags, unknown variant names or values and unknown constants are errors that
// list what is allowed. Nothing is silently ignored.

import { VARIANTS, VARIANT_NAMES, resolveVariants, RULES, CONSTANT_GROUP_RULES } from '../src/engine/index.js';

export const DEFAULTS = Object.freeze({
  games: 200,
  players: '3',
  bots: null, // null = medium when available, else random
  jitter: 0.3, // the bot task measured with 0.3 (a tiebreak added to every action score, src/bots/heuristicBot.js)
  seed: '1',
  threads: 1,
  out: null,
  rotate: true,
  maxDecisions: 5000,
  report: true,
  quiet: false,
  label: '',
});

const KNOWN = new Set(['games', 'players', 'bots', 'jitter', 'seed', 'threads', 'out', 'rotate', 'max-decisions', 'report', 'quiet', 'label', 'section', 'top', 'help', 'list']);
const BOOLEAN = new Set(['rotate', 'report', 'quiet', 'help', 'list']);

function isPlain(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** Leaf constants as [{ group, path: [keys], key: "GROUP.a.b", value }]. Arrays and scalars are leaves. */
export function constantLeaves() {
  const out = [];
  const walk = (group, path, v) => {
    if (isPlain(v)) {
      for (const k of Object.keys(v)) walk(group, [...path, k], v[k]);
    } else {
      out.push({ group, path, key: [group, ...path].join('.'), value: v });
    }
  };
  for (const group of Object.keys(RULES)) walk(group, [], RULES[group]);
  return out;
}

function parseBool(name, text) {
  if (text === true || text === 'true' || text === '1' || text === 'yes') return true;
  if (text === 'false' || text === '0' || text === 'no') return false;
  throw new Error(`--${name} must be true or false, not "${text}".`);
}

function parseScalar(flag, base, text) {
  if (base === null) {
    if (text === 'null') return null;
    const n = Number(text);
    if (text !== '' && Number.isFinite(n)) return n;
    throw new Error(`${flag}: the default is null (no limit); give a number or "null", not "${text}".`);
  }
  switch (typeof base) {
    case 'number': {
      const n = Number(text);
      if (text === '' || !Number.isFinite(n)) throw new Error(`${flag}: "${text}" is not a number (default ${base}).`);
      return n;
    }
    case 'boolean':
      return parseBool(flag, text);
    case 'string':
      return text;
    default:
      throw new Error(`${flag}: cannot set a ${typeof base} constant from the command line.`);
  }
}

/** Resolves `--const.GROUP.a.b=text` against RULES; returns { group, path, value }. */
function parseConstant(flag, key, text) {
  const parts = key.split('.');
  const group = parts[0];
  if (!Object.prototype.hasOwnProperty.call(RULES, group)) {
    throw new Error(`${flag}: unknown constant group "${group}". Groups: ${Object.keys(RULES).join(', ')}.`);
  }
  let node = RULES[group];
  const path = parts.slice(1);
  if (path.length === 0) throw new Error(`${flag}: name a constant inside ${group}, e.g. --const.${group}.<NAME>=<value> (see --list).`);
  for (let i = 0; i < path.length; i++) {
    if (!isPlain(node) || !Object.prototype.hasOwnProperty.call(node, path[i])) {
      const near = isPlain(node) ? Object.keys(node).slice(0, 25).join(', ') : '(a value, not a table)';
      throw new Error(`${flag}: "${path.slice(0, i + 1).join('.')}" does not exist in ${group}${i ? '.' + path.slice(0, i).join('.') : ''}. Available there: ${near}.`);
    }
    node = node[path[i]];
  }
  if (isPlain(node)) {
    throw new Error(`${flag}: ${key} is a table; set one of its entries: ${Object.keys(node).slice(0, 25).join(', ')}.`);
  }
  if (Array.isArray(node)) {
    const items = text.split(',');
    if (items.length !== node.length) throw new Error(`${flag}: needs ${node.length} comma-separated values like the default ${JSON.stringify(node)}; got ${items.length}.`);
    return { group, path, value: items.map((t, i) => parseScalar(`${flag}[${i}]`, node[i], t.trim())) };
  }
  return { group, path, value: parseScalar(flag, node, text) };
}

function setDeep(target, group, path, value) {
  let o = (target[group] ??= {});
  for (let i = 0; i < path.length - 1; i++) o = o[path[i]] ??= {};
  o[path[path.length - 1]] = value;
}

/**
 * Parses argv (without node and script) into a plan.
 * @returns {{ help: boolean, list: boolean, plan: object }}
 */
export function parseArgs(argv) {
  const raw = {};
  const variantFlags = {};
  const constants = {};
  const constantFlags = [];
  for (const arg of argv) {
    if (!arg.startsWith('--')) throw new Error(`Unexpected argument "${arg}". Flags look like --games=200 (see --help).`);
    let name = arg.slice(2);
    let value = true;
    const eq = name.indexOf('=');
    if (eq >= 0) {
      value = name.slice(eq + 1);
      name = name.slice(0, eq);
    }
    if (name.startsWith('no-') && KNOWN.has(name.slice(3)) && BOOLEAN.has(name.slice(3))) {
      raw[name.slice(3)] = false;
      continue;
    }
    if (name.startsWith('variant.')) {
      const vn = name.slice('variant.'.length);
      if (!VARIANT_NAMES.includes(vn)) throw new Error(`--${name}: unknown variant "${vn}". Variants: ${VARIANT_NAMES.join(', ')}.`);
      if (value === true) throw new Error(`--${name} needs a value: --${name}=<${VARIANTS.find((v) => v.name === vn).values.join('|')}>.`);
      variantFlags[vn] = value;
      continue;
    }
    if (name.startsWith('const.')) {
      if (value === true) throw new Error(`--${name} needs a value.`);
      const c = parseConstant(`--${name}`, name.slice('const.'.length), value);
      setDeep(constants, c.group, c.path, c.value);
      constantFlags.push(`${[c.group, ...c.path].join('.')}=${JSON.stringify(c.value)}`);
      continue;
    }
    if (!KNOWN.has(name)) {
      throw new Error(`Unknown flag --${name}. Known flags: ${[...KNOWN].map((k) => '--' + k).join(' ')} --variant.<name>= --const.<GROUP>.<PATH>= (see --help).`);
    }
    raw[name] = BOOLEAN.has(name) ? parseBool(name, value) : value;
  }

  // Variants are resolved by the engine (rejects unknown values) so the plan holds only overrides.
  const variants = resolveVariants(variantFlags);
  const overrides = {};
  for (const v of VARIANTS) if (variants[v.name] !== v.default) overrides[v.name] = variants[v.name];

  const intFlag = (n, key, lo) => {
    if (raw[n] === undefined) return DEFAULTS[key];
    const x = Number(raw[n]);
    if (!Number.isInteger(x) || x < lo) throw new Error(`--${n} must be a whole number of at least ${lo}, not "${raw[n]}".`);
    return x;
  };
  const players = String(raw.players ?? DEFAULTS.players)
    .split(',')
    .map((t) => {
      const n = Number(t);
      if (!Number.isInteger(n) || n < 2 || n > 5) throw new Error(`--players must be 2 to 5 (or a comma list such as 2,3,4,5), not "${t}".`);
      return n;
    });
  const jitter = raw.jitter === undefined ? DEFAULTS.jitter : Number(raw.jitter);
  if (!Number.isFinite(jitter) || jitter < 0) throw new Error(`--jitter must be a number of 0 or more, not "${raw.jitter}".`);

  const plan = {
    games: intFlag('games', 'games', 1),
    players,
    bots: raw.bots === undefined ? null : String(raw.bots).split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
    jitter,
    seed: String(raw.seed ?? DEFAULTS.seed),
    threads: raw.threads === 'auto' ? 'auto' : intFlag('threads', 'threads', 1),
    out: raw.out === undefined ? null : String(raw.out),
    rotate: raw.rotate ?? DEFAULTS.rotate,
    maxDecisions: raw['max-decisions'] === undefined ? DEFAULTS.maxDecisions : intFlag('max-decisions', 'maxDecisions', 100),
    report: raw.report ?? DEFAULTS.report,
    quiet: raw.quiet ?? DEFAULTS.quiet,
    label: String(raw.label ?? DEFAULTS.label),
    section: raw.section === undefined ? null : String(raw.section).split(',').map((x) => x.trim()).filter(Boolean),
    top: raw.top === undefined ? 0 : intFlag('top', 'games', 1),
    variants: overrides,
    constants,
    constantFlags,
  };
  return { help: raw.help === true, list: raw.list === true, plan };
}

/** The --help text, with the variant and constant tables generated from the engine. */
export function helpText() {
  const lines = [];
  lines.push('Superfans simulator: bot-vs-bot games with designer metrics.');
  lines.push('');
  lines.push('  node sim/sim.mjs [flags]');
  lines.push('');
  lines.push('Flags');
  lines.push(`  --games=N            games per player count (default ${DEFAULTS.games})`);
  lines.push(`  --players=N[,N...]   2..5, or a list such as 2,3,4,5 (one run and one output file each; default ${DEFAULTS.players})`);
  lines.push('  --bots=L[,L...]      bot level per seat: random, easy, medium (hard is async and not supported here).');
  lines.push('                       One level = every seat; a list is per seat (padded with its last entry).');
  lines.push('                       Default: medium when src/bots/index.js exists, otherwise random.');
  lines.push(`  --jitter=N           per-decision random tiebreak passed to the bots (default ${DEFAULTS.jitter}; 0 = deterministic bots,`);
  lines.push('                       which gives seat 0 a fake advantage - never quote a seat rate without jitter)');
  lines.push(`  --seed=S             run seed; game k uses "<S>-<k>" (default ${DEFAULTS.seed})`);
  lines.push('  --rotate / --no-rotate  with mixed levels, rotate which level sits in which seat by game index (default on)');
  lines.push('  --threads=N|auto     worker threads (results are identical whatever the count; default 1)');
  lines.push('  --out=FILE           JSON output (default: system temp dir, superfans-sim/; never overwrites - adds -v2, -v3)');
  lines.push(`  --max-decisions=N    harness decision cap per game, reported separately as a livelock (default ${DEFAULTS.maxDecisions})`);
  lines.push('  --no-report          write the JSON only, print no report');
  lines.push('  --section=A,B        print only these report sections (health,integrity,length,scores,seats,vp,pacing,leads,actions,branching,economy,queues,achievements,swag,clubs,celebrities,subsystems)');
  lines.push('  --top=N              limit per-card tables to the first N cards');
  lines.push('  --quiet              no progress output');
  lines.push('  --label=TEXT         free text stored in the output');
  lines.push('  --list               list every variant and constant flag, then exit');
  lines.push('  --help               this text');
  lines.push('');
  lines.push('Variants (--variant.<name>=<value>, default first):');
  for (const v of VARIANTS) lines.push(`  --variant.${v.name}=${v.values.join('|')}    ${v.description} [${v.rule}]`);
  lines.push('');
  lines.push('Constants (--const.<GROUP>.<PATH>=<value>; --list shows every path and default):');
  lines.push('  ' + Object.keys(RULES).map((g) => `${g} (${CONSTANT_GROUP_RULES[g] ?? ''})`).join(', '));
  lines.push('  e.g. --const.COSTS.COST_MOVE_2=2   --const.PASS.PASS_SLOT_REWARD=0,0,1,2,4   --const.CAPACITY.QUEUE_CAPACITY.rulebook.2=5');
  return lines.join('\n');
}

/** `--list`: every variant and every constant leaf with its default. */
export function listText() {
  const lines = ['Variants:'];
  for (const v of VARIANTS) lines.push(`  --variant.${v.name}=${v.values.join('|')}   (default ${v.default})`);
  lines.push('', 'Constants:');
  for (const leaf of constantLeaves()) {
    const shown = JSON.stringify(leaf.value);
    lines.push(`  --const.${leaf.key}=   (default ${shown.length > 70 ? shown.slice(0, 67) + '...' : shown})`);
  }
  return lines.join('\n');
}
