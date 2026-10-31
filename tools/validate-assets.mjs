// validate-assets.mjs - checks assets/manifest.json against the files on disk.
// Usage: node tools/validate-assets.mjs        (exit 1 on any error)
// Also exported: validateAssets(repoRoot) -> { errors, warnings, stats, manifest }
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

export const MAX_BYTES = 200_000;
export const FIRST_PAINT_BUDGET = 2_000_000;
const STATUSES = new Set(['real', 'placeholder', 'missing']);
const REQUIRED = ['id', 'file', 'width', 'height', 'bytes', 'status', 'source', 'shows', 'usedIn'];
const IGNORED_FILES = new Set(['manifest.json', 'STILL-NEEDED.md', '.gitkeep']);

const isAbsolutePath = (p) => /^([a-zA-Z]:|[\\/])/.test(p) || p.includes('\\') || p.split('/').includes('..');

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, name.name);
    if (name.isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

export function validateAssets(repoRoot) {
  const errors = [];
  const warnings = [];
  const assetsDir = join(repoRoot, 'assets');
  const manifestPath = join(assetsDir, 'manifest.json');
  if (!existsSync(manifestPath)) {
    return { errors: ['assets/manifest.json is missing'], warnings, stats: {}, manifest: null };
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const list = manifest.assets;
  if (!Array.isArray(list) || list.length === 0) {
    return { errors: ['manifest.assets must be a non-empty array'], warnings, stats: {}, manifest };
  }

  const ids = new Set();
  const files = new Set();
  const stats = { count: 0, totalBytes: 0, firstPaintBytes: 0, byStatus: {} };
  for (const a of list) {
    const tag = a.id ?? '(no id)';
    for (const k of REQUIRED) {
      if (a[k] === undefined || a[k] === null || a[k] === '') errors.push(`${tag}: missing field ${k}`);
    }
    if (!a.id) continue;
    if (ids.has(a.id)) errors.push(`${tag}: duplicate id`);
    ids.add(a.id);
    if (!STATUSES.has(a.status)) errors.push(`${tag}: bad status ${a.status}`);
    if (typeof a.file === 'string') {
      if (isAbsolutePath(a.file)) errors.push(`${tag}: file path is absolute or uses backslashes/..: ${a.file}`);
      if (files.has(a.file) ) warnings.push(`${tag}: file shared with another id: ${a.file}`);
      files.add(a.file);
      const full = join(assetsDir, a.file);
      if (!existsSync(full)) errors.push(`${tag}: file does not exist: ${a.file}`);
      else {
        const size = statSync(full).size;
        if (size > MAX_BYTES) errors.push(`${tag}: ${size} bytes exceeds ${MAX_BYTES}`);
        if (size !== a.bytes) errors.push(`${tag}: manifest says ${a.bytes} bytes, file is ${size}`);
      }
    }
    if (typeof a.source === 'string' && (/^([a-zA-Z]:|[\\/])/.test(a.source) || a.source.includes('\\'))) {
      errors.push(`${tag}: source must be relative with forward slashes: ${a.source}`);
    }
    if (!(a.width > 0 && a.height > 0)) errors.push(`${tag}: width/height must be positive`);
    stats.count++;
    stats.totalBytes += a.bytes || 0;
    if (a.firstPaint) stats.firstPaintBytes += a.bytes || 0;
    stats.byStatus[a.status] = (stats.byStatus[a.status] || 0) + 1;
  }
  if (stats.firstPaintBytes > FIRST_PAINT_BUDGET) {
    errors.push(`first-paint set is ${stats.firstPaintBytes} bytes, budget ${FIRST_PAINT_BUDGET}`);
  }
  // Files on disk that the manifest does not know about.
  for (const f of walk(assetsDir)) {
    const rel = relative(assetsDir, f).split('\\').join('/');
    const base = rel.split('/').pop();
    if (IGNORED_FILES.has(base)) continue;
    if (!files.has(rel)) errors.push(`orphan file not in manifest: ${rel}`);
  }
  if (typeof manifest.playerColours !== 'object') errors.push('manifest.playerColours missing');
  return { errors, warnings, stats, manifest };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const { errors, warnings, stats } = validateAssets(root);
  for (const w of warnings) console.log(`warn: ${w}`);
  for (const e of errors) console.log(`error: ${e}`);
  console.log(`${stats.count ?? 0} assets, ${stats.totalBytes ?? 0} bytes, first paint ${stats.firstPaintBytes ?? 0} bytes`, stats.byStatus ?? {});
  if (errors.length) {
    console.log(`FAILED with ${errors.length} error(s)`);
    process.exit(1);
  }
  console.log('assets ok');
}
