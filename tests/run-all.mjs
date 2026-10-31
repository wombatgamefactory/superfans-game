// Runs every tests/*.test.mjs in its own process, then the publication checks (tests/qa/sweep.mjs and
// tests/qa/references.mjs); exits non-zero if any fail. Prints each suite's time.
//
//   npm test                full gates (about 15 minutes on a busy machine; bot-ladder alone is about 5)
//   npm run test:quick      same, with QUICK=1: skips bot-ladder and plays fewer games in bots.test
//                           (thresholds are unchanged). A smoke check, not a gate.
//
// QUICK=1 in the environment does the same as --quick.
import { readdirSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const dir = dirname(fileURLToPath(import.meta.url));
const quick = process.argv.includes('--quick') || process.env.QUICK === '1';
/** Suites skipped in quick mode: the 100-game Hard-vs-Medium ladder (the Hard bot's acceptance gate). */
const SLOW = new Set(['bot-ladder.test.mjs']);

let files = readdirSync(dir).filter((f) => f.endsWith('.test.mjs')).sort();
for (const q of ['sweep.mjs', 'references.mjs']) if (existsSync(join(dir, 'qa', q))) files.push(join('qa', q));
const skipped = quick ? files.filter((f) => SLOW.has(f)) : [];
files = files.filter((f) => !skipped.includes(f));

let failed = 0;
const t00 = Date.now();
const env = { ...process.env, ...(quick ? { QUICK: '1' } : {}) };
for (const f of files) {
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [join(dir, f)], { stdio: 'inherit', env });
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  if (r.status === 0) console.log(`PASS ${f} (${secs} s)`);
  else { console.log(`FAIL ${f} (${secs} s)`); failed++; }
}
for (const f of skipped) console.log(`SKIP ${f} (quick mode)`);
console.log(`${files.length} suites${quick ? ' (quick mode)' : ''}, ${failed} failed, ${((Date.now() - t00) / 1000).toFixed(0)} s`);
process.exit(failed ? 1 : 0);
