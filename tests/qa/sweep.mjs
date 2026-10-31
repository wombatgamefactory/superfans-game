// sweep.mjs - the pre-publication sweep of every tracked file (task T18).
//
//   node tests/qa/sweep.mjs            exit 1 on any hit; prints file:line, the rule and the text
//   node tests/qa/sweep.mjs --list     also prints the largest files and the allow-list in use
//
// What it looks for, in every tracked text file (and the file names and sizes of all of them):
//   local-path   a drive-letter path, a user's home folder path, or the name of the synced folder
//                the project was built in: such text means a machine's layout is being published
//   email        any e-mail address except the repository's GitHub no-reply address
//   secret       API keys, tokens, private keys, and key-looking assignments
//   internal-doc names of documents and folders that stay beside the repo (specs, notes, task files)
//   size         any file over 1 MB that is not on the allow-list
//
// It also proves itself: before sweeping, it runs each detector over a built-in bad sample and
// fails if the detector stays quiet (a sweep that has never been seen red is unverified).
// The patterns are assembled from fragments so that this file does not trip its own rules.
//
// The files come from `git ls-files` (tracked, plus new files that are not ignored, which is what the
// next commit would add); where there is no git repository it walks the folder,
// skipping node_modules, .git and tests/tmp.

import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, sep } from 'node:path';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const J = (...parts) => parts.join('');
const MAX_BYTES = 1024 * 1024;
export const NOREPLY = J('273657828+wombatgamefactory', '@users.noreply.github.com');
/** The public support address the bug reporter mails to (also used by Firefly Festival). */
export const SUPPORT = J('info', '@wombatgamefactory.com');

// ---------------------------------------------------------------------------
// Detectors
// ---------------------------------------------------------------------------

/** @type {{ rule: string, re: RegExp, note: string, sample: string }[]} */
export const DETECTORS = [
  {
    rule: 'local-path',
    // A single letter plus a colon plus a slash or backslash (not part of a URL scheme), a home-folder
    // path (the folder name after the slash is the user's own), or the synced-folder name.
    re: new RegExp(
      J('(?:(?<![A-Za-z0-9])[A-Za-z]:[\\\\/](?![\\\\/])', '|\\\\\\\\[A-Za-z]:', '|/(?:c|mnt/c)/Users/', '|/Users/[A-Za-z]', '|/home/[a-z]', '|Drop', 'box)'),
    ),
    note: 'a local machine path or folder name',
    sample: J('S', ':', '\\', 'game', '\\', 'file.txt'),
  },
  {
    rule: 'email',
    re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/,
    note: 'an e-mail address other than the GitHub no-reply and the public support address',
    sample: J('someone', '@', 'example.com'),
    ignore: (m) => m === NOREPLY || m === SUPPORT,
  },
  {
    rule: 'secret',
    re: new RegExp(
      J(
        'AIza[0-9A-Za-z_-]{30,}',
        '|gh[pousr]_[A-Za-z0-9]{30,}',
        '|github_pat_[A-Za-z0-9_]{20,}',
        '|xox[baprs]-[A-Za-z0-9-]{10,}',
        '|AKIA[0-9A-Z]{16}',
        '|sk-[A-Za-z0-9]{24,}',
        '|-----BEGIN [A-Z ]*PRIVATE KEY-----',
        '|(?:api[_-]?key|secret|passwd|password|auth[_-]?token|access[_-]?token)["\']?\\s*[:=]\\s*["\'][^"\'\\s]{8,}["\']',
      ),
      'i',
    ),
    note: 'something that looks like a key, token or password',
    sample: J('const apiKey', ' = "', 'abcd1234efgh5678', '"'),
  },
  {
    rule: 'internal-doc',
    re: new RegExp(
      J('(?:rules', '-spec|web-build', '-notes|(?<![A-Za-z])tasks', '[\\\\/]|CLAUDE', '\\.md|\\bled', 'ger\\b|\\.claude', '[\\\\/])'),
      'i',
    ),
    note: 'the name of an internal document or folder that stays beside the repo',
    sample: J('see the ', 'rules', '-spec', ' file'),
  },
];

// ---------------------------------------------------------------------------
// Allow-list: each entry is a reasoned exception. Keep it short.
// ---------------------------------------------------------------------------

export const ALLOW = [
  { rule: 'internal-doc', file: '.gitignore', why: 'the ignore list names the internal files precisely so they stay out of the repo' },
  { rule: 'local-path', file: 'sim/sim.mjs', why: 'a warning if simulator output is written into a synced folder; matches the folder name only' },
  { rule: 'size', file: 'package-lock.json', why: 'npm lock file (only if it ever grows past 1 MB)' },
];

const allowed = (rule, file) => ALLOW.some((a) => a.rule === rule && a.file === file);

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

function listFiles() {
  try {
    const out = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 1 << 26 });
    const files = out.split('\0').filter(Boolean);
    if (files.length) return { files: [...new Set(files)], source: 'git, tracked and new unignored files' };
  } catch { /* fall through to the walk */ }
  const files = [];
  const skip = new Set(['node_modules', '.git', 'tmp', 'test-results', 'bug-reports']);
  (function walk(dir) {
    for (const name of readdirSync(dir)) {
      if (skip.has(name)) continue;
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else files.push(relative(REPO, full).split(sep).join('/'));
    }
  })(REPO);
  return { files, source: 'directory walk (no git repository)' };
}

const looksBinary = (buf) => buf.subarray(0, 8000).includes(0);

/** Scans one text for every detector; returns [{ rule, line, text, match }]. */
export function scanText(text) {
  const hits = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.length > 20000) continue; // minified blobs: not prose, and the regexes are not free
    for (const d of DETECTORS) {
      const re = new RegExp(d.re.source, d.re.flags.includes('g') ? d.re.flags : d.re.flags + 'g');
      let m;
      while ((m = re.exec(line))) {
        if (d.ignore && d.ignore(m[0])) continue;
        hits.push({ rule: d.rule, line: i + 1, text: line.trim().slice(0, 140), match: m[0] });
        break;
      }
    }
  }
  return hits;
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

export function sweep() {
  const { files, source } = listFiles();
  const hits = [];
  const sizes = [];
  const used = new Set();
  for (const file of files) {
    const abs = join(REPO, file);
    let buf;
    try { buf = readFileSync(abs); } catch { continue; } // listed but deleted from the working tree
    sizes.push([file, buf.length]);
    if (buf.length > MAX_BYTES) {
      if (allowed('size', file)) used.add(`size:${file}`);
      else hits.push({ file, rule: 'size', line: 0, text: `${(buf.length / 1048576).toFixed(2)} MB (limit 1 MB)` });
    }
    // file names count too
    for (const d of DETECTORS) {
      if (d.rule === 'email' || d.rule === 'secret') continue;
      const m = d.re.exec(file);
      if (m && !allowed(d.rule, file)) hits.push({ file, rule: d.rule, line: 0, text: `file name: ${file}` });
    }
    if (looksBinary(buf)) continue;
    for (const h of scanText(buf.toString('utf8'))) {
      if (allowed(h.rule, file)) { used.add(`${h.rule}:${file}`); continue; }
      hits.push({ file, ...h });
    }
  }
  return { files, source, hits, sizes, used };
}

/** Each detector must fire on its own bad sample; the no-reply address must pass. */
export function selfTest() {
  const problems = [];
  for (const d of DETECTORS) {
    const hit = scanText(d.sample).some((h) => h.rule === d.rule);
    if (!hit) problems.push(`detector "${d.rule}" did not fire on its sample`);
  }
  if (scanText(`Contact ${NOREPLY}`).some((h) => h.rule === 'email')) problems.push('the GitHub no-reply address was flagged');
  if (scanText('https://www.example.com/play/').length) problems.push('an ordinary URL was flagged');
  if (scanText('const GA = ""; // GA4_MEASUREMENT_ID: empty').length) problems.push('an empty config line was flagged');
  return problems;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1].replace(/\//g, sep)) {
  const list = process.argv.includes('--list');
  const bad = selfTest();
  if (bad.length) {
    console.log('FAIL sweep self-test');
    for (const b of bad) console.log(`  ${b}`);
    process.exit(1);
  }
  const { files, source, hits, sizes, used } = sweep();
  console.log(`sweep: ${files.length} tracked files (${source}); self-test ok`);
  if (list) {
    const top = sizes.sort((a, b) => b[1] - a[1]).slice(0, 5);
    console.log('  largest: ' + top.map(([f, n]) => `${f} ${(n / 1024).toFixed(0)} KB`).join(', '));
    for (const a of ALLOW) console.log(`  allow ${a.rule} in ${a.file}: ${a.why}${used.has(`${a.rule}:${a.file}`) ? ' (used)' : ' (not needed now)'}`);
  }
  for (const h of hits) console.log(`  ${h.file}${h.line ? ':' + h.line : ''}  [${h.rule}]  ${h.text}`);
  console.log(hits.length ? `FAIL sweep: ${hits.length} hit(s)` : 'sweep clean: no local paths, e-mail addresses, secrets or internal doc names; no file over 1 MB');
  process.exit(hits.length ? 1 : 0);
}
