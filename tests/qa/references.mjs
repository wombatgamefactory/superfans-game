// references.mjs - every file reference matches the real file, letter for letter (task T18).
//
//   node tests/qa/references.mjs [--list]      exit 1 on any broken or wrong-case reference
//
// GitHub Pages serves from a case-sensitive file system; Windows and macOS do not. A reference to
// "Assets/Cards/Back.webp" works on the machine it was written on and returns 404 once published.
// This script reads the references the way the browser will and checks each against the real
// directory listing, comparing names exactly:
//
//   - index.html and the other .html files: src=, href=, srcset=, content= (images), url() in style
//   - .css: url(...) and @import
//   - .js / .mjs: import / export-from / import() specifiers (relative ones), new URL('...', import.meta.url),
//     fetch('...'), Worker('...'), and any string literal that starts with "assets/" or "src/"
//   - assets/manifest.json: every "file"
//
// It does not look at anything outside the repo. Absolute URLs (http:, data:, mailto:) are ignored.

import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, resolve, sep, posix } from 'node:path';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SKIP_DIRS = new Set(['node_modules', '.git', 'tmp', 'test-results', 'bug-reports']);

const dirCache = new Map();
function names(dir) {
  if (!dirCache.has(dir)) dirCache.set(dir, existsSync(dir) && statSync(dir).isDirectory() ? readdirSync(dir) : null);
  return dirCache.get(dir);
}

/**
 * Resolves `target` (an absolute path inside the repo) segment by segment against real directory
 * listings, comparing case-sensitively. Returns null when it is fine, or a message.
 */
export function exactCaseProblem(target) {
  const rel = relative(REPO, target);
  if (rel.startsWith('..')) return 'points outside the repository';
  let dir = REPO;
  for (const seg of rel.split(sep).filter(Boolean)) {
    const list = names(dir);
    if (!list) return `${relative(REPO, dir) || '.'} is not a folder`;
    if (list.includes(seg)) { dir = join(dir, seg); continue; }
    const near = list.find((n) => n.toLowerCase() === seg.toLowerCase());
    return near ? `wrong case: "${seg}" is really "${near}" in ${relative(REPO, dir) || '.'}` : `no such file: "${seg}" in ${relative(REPO, dir) || '.'}`;
  }
  return null;
}

function walk(dir, out = []) {
  for (const n of readdirSync(dir)) {
    if (SKIP_DIRS.has(n)) continue;
    const p = join(dir, n);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

const isExternal = (s) => /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(s);
const clean = (s) => s.split('#')[0].split('?')[0];

/** Pulls [specifier, kind] pairs out of a file's text. */
export function extract(file, text) {
  const out = [];
  const add = (spec, kind) => { if (spec && !isExternal(spec) && !/[\${}]/.test(spec)) out.push([spec, kind]); };
  const ext = file.slice(file.lastIndexOf('.')).toLowerCase();
  if (ext === '.html') {
    for (const m of text.matchAll(/\b(?:src|href|poster|data-src)\s*=\s*["']([^"']+)["']/gi)) add(m[1], 'attr');
    for (const m of text.matchAll(/\bsrcset\s*=\s*["']([^"']+)["']/gi)) for (const part of m[1].split(',')) add(part.trim().split(/\s+/)[0], 'srcset');
    for (const m of text.matchAll(/<meta[^>]+content\s*=\s*["']([^"']+\.(?:png|jpe?g|webp|svg))["']/gi)) add(m[1], 'meta-image');
    for (const m of text.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/gi)) add(m[1], 'css-url');
    for (const m of text.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)) for (const r of extract('x.js', m[1])) out.push(r);
  } else if (ext === '.css') {
    for (const m of text.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/gi)) add(m[1], 'css-url');
    for (const m of text.matchAll(/@import\s+["']([^"']+)["']/gi)) add(m[1], 'css-import');
  } else if (ext === '.js' || ext === '.mjs') {
    for (const m of text.matchAll(/\b(?:import|export)\b[^'"`;]*?\bfrom\s*["']([^"']+)["']/g)) add(m[1], 'import');
    for (const m of text.matchAll(/\bimport\s*["']([^"']+)["']/g)) add(m[1], 'import');
    for (const m of text.matchAll(/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g)) add(m[1], 'dynamic-import');
    for (const m of text.matchAll(/new\s+URL\(\s*["']([^"']+)["']\s*,\s*import\.meta\.url/g)) add(m[1], 'new-URL');
    // strings in browser code only (tests and tools build their paths with join())
    if (/[\\/]src[\\/]/.test(file)) {
      for (const m of text.matchAll(/\bfetch\(\s*["']([^"']+)["']/g)) add(m[1], 'fetch');
      for (const m of text.matchAll(/["'`](assets\/[A-Za-z0-9_\-./]+\.(?:webp|png|jpe?g|svg|json|css|js))["'`]/g)) add(m[1], 'literal');
    }
  }
  return out;
}

/** The page-relative base for a reference found in `file`: HTML and CSS-in-HTML resolve from the page, imports from the module. */
function baseFor(file, spec, kind) {
  if (spec.startsWith('/')) return join(REPO, spec); // site-root path: only right if the site is at the root
  if (kind === 'literal' || kind === 'fetch') {
    // strings in browser code are resolved from the page that loads them (index.html, at the repo root)
    if (file.includes(`${sep}src${sep}`) && !spec.startsWith('.')) return join(REPO, spec);
  }
  return join(dirname(file), spec);
}

export function checkReferences() {
  const problems = [];
  let count = 0;
  const self = fileURLToPath(import.meta.url);
  const files = walk(REPO).filter((f) => /\.(html|css|js|mjs)$/i.test(f) && f !== self);
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    for (const [spec, kind] of extract(file, text)) {
      const s = clean(spec);
      if (!s) continue;
      count++;
      if (spec.startsWith('/') && !file.includes(`${sep}tests${sep}`)) {
        problems.push({ file: relative(REPO, file), spec, why: 'starts with "/": breaks under a sub-path such as /superfans-game/' });
        continue;
      }
      let target = baseFor(file, s, kind);
      target = resolve(target);
      const why = exactCaseProblem(target);
      if (why) problems.push({ file: relative(REPO, file), spec, why });
    }
  }
  // the manifest
  const manifestPath = join(REPO, 'assets', 'manifest.json');
  if (existsSync(manifestPath)) {
    const m = JSON.parse(readFileSync(manifestPath, 'utf8'));
    for (const a of m.assets) {
      count++;
      const why = exactCaseProblem(join(REPO, 'assets', a.file));
      if (why) problems.push({ file: 'assets/manifest.json', spec: a.file, why: `${a.id}: ${why}` });
    }
  }
  return { files: files.length, count, problems };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // self-check: the matcher must catch a wrong-case path and a missing one
  const probes = [
    [join(REPO, 'Index.html'), 'wrong case'],
    [join(REPO, 'src', 'ui', 'MAIN.js'), 'wrong case'],
    [join(REPO, 'src', 'ui', 'nope.js'), 'no such file'],
  ];
  const bad = probes.filter(([p, expect]) => !(exactCaseProblem(p) || '').startsWith(expect));
  if (bad.length) {
    console.log('FAIL references self-test: the checker missed ' + bad.map(([p]) => posix.basename(p)).join(', '));
    process.exit(1);
  }
  const { files, count, problems } = checkReferences();
  console.log(`references: ${count} references in ${files} html/css/js files plus the asset manifest; self-test ok`);
  for (const p of problems) console.log(`  ${p.file}  "${p.spec}"  ${p.why}`);
  console.log(problems.length ? `FAIL references: ${problems.length} problem(s)` : 'references clean: every path matches a real file, letter for letter');
  process.exit(problems.length ? 1 : 0);
}
