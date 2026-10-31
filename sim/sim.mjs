// sim.mjs - the Superfans simulator: N bot-vs-bot games with designer metrics.
//
//   node sim/sim.mjs --games=200 --players=3 --bots=medium --out=run.json
//   node sim/sim.mjs --help        flags, variants and constants (generated from the engine tables)
//   node sim/sim.mjs --list        every --variant. and --const. flag with its default
//
// Per game: a record (SCHEMA.md) built from engine events only, with a bookkeeping check that the
// VP, coffee and selfies the events announced equal the engine's own totals. Per run: a JSON file
// (default: the system temp dir, never inside Dropbox, never overwritten) and a printed report
// (sim-report.mjs). Exit code 1 if any game was refused, crashed, hit the decision cap or failed
// the bookkeeping check; turn-capped games are reported as a finding but do not fail the run.

import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir, cpus } from 'node:os';
import { dirname, join, resolve, extname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { parseArgs, helpText, listText } from './args.mjs';
import { resolveLevels, loadBots } from './bots.mjs';
import { runGame } from './run-game.mjs';
import { aggregate } from './aggregate.mjs';
import { renderReport } from './sim-report.mjs';
import { createGame, RULES_ID, SCHEMA_VERSION } from '../src/engine/index.js';

export const OUTPUT_SCHEMA = 'superfans-sim-v1';

/** The first free path: `name.json`, then `name-v2.json`, `name-v3.json` (generated files are never overwritten). */
export function freePath(path) {
  if (!existsSync(path)) return path;
  const ext = extname(path);
  const stem = path.slice(0, path.length - ext.length);
  for (let v = 2; v < 10000; v++) {
    const p = `${stem}-v${v}${ext}`;
    if (!existsSync(p)) return p;
  }
  throw new Error(`No free file name near ${path}.`);
}

function outPathFor(plan, P, many) {
  if (plan.out) {
    const p = resolve(plan.out);
    if (!many) return freePath(p);
    const ext = extname(p) || '.json';
    return freePath(`${p.slice(0, p.length - (extname(p) ? ext.length : 0))}-${P}p${ext}`);
  }
  const tag = [...new Set(plan.levels)].join('-');
  const name = `sim-${P}p-${tag}-${plan.games}g-seed-${plan.seed.replace(/[^A-Za-z0-9_-]/g, '_')}.json`;
  return freePath(join(tmpdir(), 'superfans-sim', name));
}

/**
 * Plays `plan.games` games at `players` seats and returns the records in index order.
 * @param {object} plan serialisable plan (see run-game.mjs)
 * @param {number} threads worker threads (1 = in this thread)
 */
export async function playGames(plan, players, threads = 1) {
  const n = plan.games;
  if (threads <= 1 || n < 8) {
    const records = [];
    for (let i = 0; i < n; i++) records.push(await runGame(plan, players, i));
    return records;
  }
  const t = Math.min(threads, n);
  const slices = Array.from({ length: t }, () => []);
  for (let i = 0; i < n; i++) slices[i % t].push(i);
  const workerUrl = new URL('./worker.mjs', import.meta.url);
  const parts = await Promise.all(
    slices.map(
      (indices) =>
        new Promise((resolveP, reject) => {
          const w = new Worker(workerUrl, { workerData: { plan, players, indices } });
          w.once('message', resolveP);
          w.once('error', reject);
          w.once('exit', (code) => {
            if (code !== 0) reject(new Error(`Worker exited with code ${code}.`));
          });
        }),
    ),
  );
  return parts.flat().sort((a, b) => a.index - b.index);
}

/** Builds the output object for one player count. */
export function buildOutput(plan, P, records, wallMs, threads) {
  const summary = aggregate(records, { players: P });
  return {
    schema: OUTPUT_SCHEMA,
    players: P,
    plan: {
      games: plan.games, levels: plan.levels, jitter: plan.jitter, seed: plan.seed, rotate: plan.rotate,
      variants: plan.variants, constants: plan.constants, constantFlags: plan.constantFlags, label: plan.label, maxDecisions: plan.maxDecisions,
    },
    meta: {
      rulesId: RULES_ID, engineSchema: SCHEMA_VERSION, node: process.version, threads, wallMs: Math.round(wallMs),
      generated: new Date().toISOString(),
    },
    summary,
    games: records,
  };
}

async function main(argv) {
  const { help, list, plan: parsed } = parseArgs(argv);
  if (help) {
    console.log(helpText());
    return 0;
  }
  if (list) {
    console.log(listText());
    return 0;
  }
  const bots = await loadBots();
  if (bots.warning) console.error(`warning: ${bots.warning}`);
  let exit = 0;
  const many = parsed.players.length > 1;
  for (const P of parsed.players) {
    const levels = await resolveLevels(parsed.bots, P);
    const plan = { ...parsed, levels, players: undefined };
    // Fail fast on a bad variant/constant combination before playing anything.
    createGame({ playerCount: P, variants: plan.variants, constants: Object.keys(plan.constants).length ? plan.constants : undefined }, { seed: 'check' });
    const threads = plan.threads === 'auto' ? Math.max(1, Math.min(8, cpus().length - 1)) : plan.threads;
    if (!plan.quiet) console.error(`Playing ${plan.games} ${P}-player games, bots ${[...new Set(levels)].join('/')}, jitter ${plan.jitter}, ${threads} thread(s)...`);
    const t0 = performance.now();
    const records = await playGames(plan, P, threads);
    const wall = performance.now() - t0;
    const out = buildOutput(plan, P, records, wall, threads);
    const path = outPathFor(plan, P, many);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(out) + '\n', 'utf8');
    if (/dropbox/i.test(path)) console.error(`warning: ${path} is inside Dropbox; simulator output belongs in the system temp dir.`);
    if (plan.report) console.log(renderReport(out.summary, out.plan, { only: plan.section, top: plan.top }));
    console.log(`Wrote ${path}  (${records.length} games in ${(wall / 1000).toFixed(1)} s, ${(wall / records.length).toFixed(0)} ms a game)`);
    const c = out.summary.counts;
    if (c.refusals + c.errors + c.integrity + c.decisionCapHits > 0) {
      console.error(`FAILED: ${c.refusals} refused, ${c.errors} crashed, ${c.integrity} bookkeeping mismatches, ${c.decisionCapHits} decision-cap games.`);
      exit = 1;
    }
  }
  return exit;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      console.error(`sim.mjs: ${err && err.message ? err.message : err}`);
      process.exit(2);
    },
  );
}
