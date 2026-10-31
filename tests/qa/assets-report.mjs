// assets-report.mjs - reconciles assets/manifest.json with the files on disk and with the code (task T18).
//
//   node tests/qa/assets-report.mjs        exit 1 on a missing file, an orphan file or a file over 200 KB
//
// Hard checks (the same ones tools/validate-assets.mjs makes, re-run here so one command gives the whole picture):
//   - every manifest entry has a file on disk, with the byte size it claims
//   - every file under assets/ is in the manifest
//   - no asset is over 200 KB
// Report (never a failure):
//   - total size, first-paint set size, counts by status
//   - entries that nothing in index.html, style.css or src/ appears to ask for: the manifest id, or the
//     file name, or an id prefix that code builds ("card-swag-" + colour + ...). These are "unused".
//     A few are used only through a template the scan cannot read, so check the list by eye.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const { validateAssets, MAX_BYTES } = await import(pathToFileURL(join(REPO, 'tools', 'validate-assets.mjs')).href);

function walk(dir, out = []) {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

const { errors, warnings, stats, manifest } = validateAssets(REPO);

// Text the browser (and the page) can reach: index.html, style.css, everything under src/ and sim/metrics.
const sources = ['index.html', 'style.css', ...walk(join(REPO, 'src')).map((p) => p.slice(REPO.length + 1))];
const text = sources.map((f) => readFileSync(join(REPO, f), 'utf8')).join('\n');

// String fragments ending in "-" that code uses as id prefixes: 'card-swag-', `portrait-celebrity-${x}`, 'hall-' + slug ...
const prefixes = new Set();
for (const m of text.matchAll(/["'`]([a-z][a-z0-9]*(?:-[a-z0-9]+)*-)(?=["'`]|\$\{)/g)) prefixes.add(m[1]);

const unused = [];
for (const a of manifest.assets) {
  const byId = text.includes(a.id);
  const byFile = text.includes(a.file);
  const byPrefix = [...prefixes].some((p) => a.id.startsWith(p));
  if (!(byId || byFile || byPrefix)) unused.push(a);
}

const big = manifest.assets.filter((a) => a.bytes > MAX_BYTES);
console.log(`assets: ${stats.count} in the manifest, ${(stats.totalBytes / 1048576).toFixed(2)} MB in all; largest ${Math.max(...manifest.assets.map((a) => a.bytes))} bytes (limit ${MAX_BYTES})`);
console.log(`  by status: ${Object.entries(stats.byStatus).map(([k, v]) => `${k} ${v}`).join(', ')}`);
console.log(`  first-paint set (flag firstPaint in the manifest): ${stats.firstPaintBytes} bytes`);
console.log(`  files over ${MAX_BYTES} bytes: ${big.length}`);
for (const w of warnings) console.log(`  warning: ${w}`);
console.log(`  not referenced by index.html, style.css or src/ (by id, file name or id prefix): ${unused.length}`);
for (const a of unused) console.log(`    ${a.id}  [${a.status}]  ${a.file}  - ${a.usedIn}`);
for (const e of errors) console.log(`  ERROR ${e}`);
console.log(errors.length ? `FAIL assets: ${errors.length} error(s)` : 'assets reconciled: every entry has its file, every file is in the manifest, none over the limit');
process.exit(errors.length ? 1 : 0);
