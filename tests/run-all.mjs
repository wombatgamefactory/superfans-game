// Runs every tests/*.test.mjs in its own process; exits non-zero if any fail.
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const dir = dirname(fileURLToPath(import.meta.url));
const files = readdirSync(dir).filter((f) => f.endsWith('.test.mjs')).sort();
let failed = 0;
for (const f of files) {
  const r = spawnSync(process.execPath, [join(dir, f)], { stdio: 'inherit' });
  if (r.status === 0) console.log(`PASS ${f}`);
  else { console.log(`FAIL ${f}`); failed++; }
}
console.log(`${files.length} suites, ${failed} failed`);
process.exit(failed ? 1 : 0);
