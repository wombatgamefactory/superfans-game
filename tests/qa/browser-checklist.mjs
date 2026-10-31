// browser-checklist.mjs - the browser pre-publication checklist, driven with real pointer events (task T18).
// Not part of `npm test` (slow, writes screenshots). Run it by hand before a release:
//
//   node tests/qa/browser-checklist.mjs [--subpath] [--only=landing,hm,hard,demo,handover] [--shots=<dir>]
//
//   default     the repo folder is served at "/" by a case-sensitive server (like GitHub Pages)
//   --subpath   the folder that CONTAINS the repo is served, so the game is at /<repo-folder>/ (a sub-path)
//
// Scenarios (each: no console errors, no failed or 404 requests):
//   landing    the landing page, How to play, start button, first-paint transfer, 390 px wide view
//   hm         ?seats=h,m   human against Medium: Rules modal, keyboard focus, Report a problem dialog,
//                           played to the end screen; Stats tab, Download game record (replayed), Play again
//   hard       ?seats=hard,m   Hard against Medium (a watched game), end screen checks
//   demo       ?seats=e,m,m    an all-bot demo, end screen checks
//   handover   ?seats=h,h      two humans: the handover screen hides the table and the next click works
//
// Screenshots and downloads go to a per-process folder under the system temp dir; the paths are printed.
// Exit code 1 if any check fails.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { launch, rng, tempDir, humanStep, playToEnd, pointerClick, REPO } from '../helpers/ui-harness.mjs';
import { startCaseServer } from './case-server.mjs';

const argv = process.argv.slice(2);
const flag = (n) => argv.find((a) => a.startsWith(`--${n}=`))?.split('=')[1];
const subpath = argv.includes('--subpath');
const only = (flag('only') || 'landing,hm,hard,demo,handover').split(',');
const OUT = flag('shots') || tempDir('qa-shots');
fs.mkdirSync(OUT, { recursive: true });

const results = [];
const shots = [];
function check(name, ok, detail = '') {
  results.push({ name, ok: !!ok, detail });
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` - ${detail}` : ''}`);
}
const MB = (n) => `${(n / 1048576).toFixed(2)} MB`;

const root = subpath ? path.dirname(REPO) : REPO;
const prefix = subpath ? `/${path.basename(REPO)}/` : '/';
const server = await startCaseServer(root);
const base = `${server.url}${prefix}`;
console.log(`serving ${root} -> ${base}${subpath ? '  (sub-path run)' : ''}`);
console.log(`screenshots and downloads: ${OUT}`);
const browser = await launch();

/** Opens a fresh page in a fresh context (nothing cached) and tracks errors, bad responses and bytes on the wire. */
async function open(query, viewport = { width: 1600, height: 1000 }) {
  const ctx = await browser.newContext({ viewport, acceptDownloads: true });
  const page = await ctx.newPage();
  const errors = [];
  const bad = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console.error: ${m.text()}`); });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('response', (r) => { if (r.status() >= 400) bad.push(`${r.status()} ${r.url()}`); });
  page.on('requestfailed', (r) => { if (!/fonts\.(googleapis|gstatic)\.com/.test(r.url())) bad.push(`failed ${r.url()}`); });
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Network.enable');
  const urls = new Map();
  const bytes = new Map();
  cdp.on('Network.requestWillBeSent', (e) => urls.set(e.requestId, e.request.url));
  cdp.on('Network.loadingFinished', (e) => bytes.set(e.requestId, e.encodedDataLength));
  const net = () => {
    const rows = [...bytes].map(([id, b]) => ({ url: urls.get(id) || '', bytes: b }));
    const sum = (f) => rows.filter(f).reduce((s, r) => s + r.bytes, 0);
    const local = (r) => r.url.startsWith(server.url);
    return {
      rows,
      total: sum(() => true),
      local: sum(local),
      external: sum((r) => !local(r) && !r.url.startsWith('data:')),
      images: sum((r) => local(r) && /\.(webp|png|jpe?g|svg)(\?|$)/i.test(r.url)),
      code: sum((r) => local(r) && /\.(m?js|css|html|json)(\?|$)/i.test(r.url)),
      count: rows.length,
    };
  };
  await page.goto(`${base}index.html${query ? `?${query}` : ''}`);
  await page.waitForFunction(() => window.__sf && window.__sf.screen !== undefined, null, { timeout: 20000 });
  return { ctx, page, errors, bad, net };
}

async function shot(page, name, full = false) {
  const file = path.join(OUT, `${subpath ? 'sub-' : ''}${name}.png`);
  await page.screenshot({ path: file, fullPage: full });
  shots.push(file);
  return file;
}

function clean(label, p) {
  check(`${label}: no console errors`, p.errors.length === 0, p.errors.slice(0, 3).join(' | '));
  check(`${label}: no failed or 404 requests`, p.bad.length === 0, p.bad.slice(0, 3).join(' | '));
}

const quiet = async (page) => page.waitForLoadState('networkidle').catch(() => {});

// ---------------------------------------------------------------------------
async function landing() {
  console.log('\n[landing]');
  const p = await open('');
  const { page } = p;
  await quiet(page);
  const n = p.net();
  console.log(`  landing first-paint transfer: ${MB(n.total)} in ${n.count} requests (images ${MB(n.images)}, code ${MB(n.code)}, external ${MB(n.external)})`);
  check('landing: first-paint transfer <= 2 MB', n.total <= 2 * 1048576, MB(n.total));
  check('landing: setup screen shown', (await page.evaluate(() => window.__sf.screen)) === 'setup');
  await shot(page, 'landing-1600x1000');
  await shot(page, 'landing-1600-full', true);
  // How to play
  const opened = await pointerClick(page, '[data-rules]');
  check('landing: How to play button clickable', opened);
  await page.waitForSelector('.sf-modal, [data-htp-close]', { timeout: 5000 }).catch(() => {});
  const htpText = await page.evaluate(() => (document.querySelector('.sf-modal') || document.body).innerText.length);
  check('landing: How to play has content', htpText > 800, `${htpText} characters`);
  await shot(page, 'landing-how-to-play');
  await pointerClick(page, '[data-htp-close]');
  await page.waitForTimeout(300);
  check('landing: How to play closes', (await page.locator('.sf-modal').count()) === 0);
  // Start from the landing page with real clicks
  await pointerClick(page, '[data-start]');
  await page.waitForFunction(() => window.__sf.screen === 'game', null, { timeout: 15000 }).catch(() => {});
  check('landing: "Open the doors!" starts a game', (await page.evaluate(() => window.__sf.screen)) === 'game');
  await quiet(page);
  const g = p.net();
  console.log(`  landing + game screen transfer: ${MB(g.total)} in ${g.count} requests (images ${MB(g.images)})`);
  check('game screen: cumulative transfer <= 4 MB', g.total <= 4 * 1048576, MB(g.total));
  await shot(page, 'game-from-landing');
  clean('landing and start', p);
  // phone
  const m = await open('', { width: 390, height: 844 });
  await quiet(m.page);
  const overflow = await m.page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check('landing at 390 px: no horizontal scroll', overflow <= 1, `${overflow}px`);
  await shot(m.page, 'landing-390', true);
  clean('landing at 390 px', m);
  await p.ctx.close();
  await m.ctx.close();
}

// ---------------------------------------------------------------------------
/** Tabs through the page and reports focus order and whether each stop shows a visible ring. */
async function keyboardPass(page, label) {
  const stops = [];
  await page.evaluate(() => document.activeElement && document.activeElement.blur());
  for (let i = 0; i < 14; i++) {
    await page.keyboard.press('Tab');
    stops.push(await page.evaluate(() => {
      const el = document.activeElement;
      if (!el || el === document.body) return { tag: 'BODY', ring: false };
      const cs = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      const ring = (cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0) || (cs.boxShadow && cs.boxShadow !== 'none');
      return { tag: el.tagName, text: (el.getAttribute('aria-label') || el.innerText || el.id || '').trim().slice(0, 30), ring: !!ring, visible: r.width > 0 && r.height > 0 };
    }));
  }
  const real = stops.filter((s) => s.tag !== 'BODY');
  const ringed = real.filter((s) => s.ring).length;
  check(`${label}: Tab reaches controls`, real.length >= 5, `${real.length}/14 stops: ${real.slice(0, 5).map((s) => s.text || s.tag).join(' > ')}`);
  check(`${label}: focused controls show a ring`, ringed >= real.length * 0.8, `${ringed}/${real.length}`);
}

async function bugDialog(page, label) {
  const opener = await pointerClick(page, '#bug-report-btn');
  check(`${label}: Report a problem button clickable`, opener);
  await page.waitForSelector('.bug-modal', { timeout: 4000 }).catch(() => {});
  const open = (await page.locator('.bug-modal').count()) === 1;
  check(`${label}: Report a problem dialog opens`, open);
  if (!open) return;
  const focusInside = await page.evaluate(() => !!document.activeElement && !!document.activeElement.closest('.bug-modal'));
  check(`${label}: dialog takes keyboard focus`, focusInside);
  await shot(page, `${label}-report-dialog`);
  let escaped = 0;
  for (let i = 0; i < 16; i++) {
    await page.keyboard.press('Tab');
    if (!(await page.evaluate(() => !!document.activeElement && !!document.activeElement.closest('.bug-modal')))) escaped++;
  }
  check(`${label}: Tab stays inside the dialog`, escaped === 0, escaped ? `focus left the dialog on ${escaped}/16 presses` : '');
  await page.fill('[data-bug-field="title"]', 'QA dialog check');
  const dl = page.waitForEvent('download', { timeout: 6000 }).catch(() => null);
  await pointerClick(page, '[data-bug-act="download"]');
  const d = await dl;
  let okFile = false;
  let detail = 'no download';
  if (d) {
    const f = path.join(OUT, `${label}-bug-report.json`);
    await d.saveAs(f);
    try {
      const j = JSON.parse(fs.readFileSync(f, 'utf8'));
      okFile = !!(j.id && j.diagnostics && j.gameState !== undefined);
      detail = `${(fs.statSync(f).size / 1024).toFixed(0)} KB, keys ${Object.keys(j).slice(0, 8).join(',')}`;
    } catch (e) { detail = `bad JSON: ${e.message}`; }
  }
  check(`${label}: Download report gives a report file`, okFile, detail);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  check(`${label}: Escape closes the dialog`, (await page.locator('.bug-modal').count()) === 0);
  const back = await page.evaluate(() => document.activeElement && (document.activeElement.id || document.activeElement.tagName));
  check(`${label}: focus returns to the opener`, back === 'bug-report-btn', String(back));
  // Ctrl+Shift+B
  await page.keyboard.press('Control+Shift+B');
  await page.waitForTimeout(200);
  check(`${label}: Ctrl+Shift+B opens it`, (await page.locator('.bug-modal').count()) === 1);
  await page.keyboard.press('Escape');
}

async function endScreenChecks(p, label, players) {
  const { page } = p;
  await page.waitForFunction(() => window.__sf.screen === 'end', null, { timeout: 200000 });
  await page.waitForTimeout(500);
  check(`${label}: end screen reached`, true);
  await shot(page, `${label}-end-scores`);
  const rows = await page.locator('.sf-table tbody tr').count();
  check(`${label}: scores table has a row per player`, rows >= players, `${rows} rows`);
  const badText = await page.evaluate(() => /undefined|NaN|\[object/.test(document.body.innerText));
  check(`${label}: no "undefined"/"NaN" on the end screen`, !badText);
  await pointerClick(page, '[data-end-tab="stats"]');
  await page.waitForTimeout(300);
  const statsVisible = await page.evaluate(() => { const el = document.querySelector('[data-end-panel="stats"]'); return !!el && !el.hidden && el.innerText.length > 200; });
  check(`${label}: Stats tab shows`, statsVisible);
  const badStats = await page.evaluate(() => /undefined|NaN|\[object/.test(document.querySelector('[data-end-panel="stats"]').innerText));
  check(`${label}: no "undefined"/"NaN" in the Stats tab`, !badStats);
  await shot(page, `${label}-end-stats`, true);
  // Download game record, then replay it headless
  const dl = page.waitForEvent('download', { timeout: 8000 }).catch(() => null);
  await pointerClick(page, '[data-act="download-record"]');
  const d = await dl;
  if (!d) check(`${label}: Download game record`, false, 'no download');
  else {
    const f = path.join(OUT, `${label}-game-record.json`);
    await d.saveAs(f);
    const r = spawnSync(process.execPath, [path.join(REPO, 'tools', 'replay.mjs'), f, '--quiet'], { encoding: 'utf8' });
    check(`${label}: Download game record replays to the same scores`, r.status === 0, `${path.basename(f)} ${(fs.statSync(f).size / 1024).toFixed(0)} KB, replay exit ${r.status} ${(r.stdout + r.stderr).trim().slice(0, 120)}`);
  }
  // Play again
  await pointerClick(page, '[data-act="play-again"]');
  await page.waitForFunction(() => window.__sf.screen === 'game', null, { timeout: 15000 }).catch(() => {});
  const again = await page.evaluate(() => ({ screen: window.__sf.screen, players: window.__sf.state && window.__sf.state.players.length, hour: window.__sf.state && window.__sf.state.hour, actions: window.__sf.actions.length }));
  check(`${label}: Play again starts a fresh game with the same seats`, again.screen === 'game' && again.players === players && again.actions < 5, JSON.stringify(again));
}

// ---------------------------------------------------------------------------
async function humanVsMedium() {
  console.log('\n[hm]  ?seats=h,m');
  const p = await open('seats=h,m&speed=instant');
  const { page } = p;
  const rand = rng(7);
  await quiet(page);
  const n = p.net();
  console.log(`  game-screen first-paint transfer (direct to a game): ${MB(n.total)} in ${n.count} requests (images ${MB(n.images)})`);
  check('hm: game screen transfer <= 4 MB', n.total <= 4 * 1048576, MB(n.total));
  for (let i = 0; i < 3; i++) await humanStep(page, rand, 'board');
  await shot(page, 'hm-play-1600');
  // Rules modal, real click
  await pointerClick(page, '[data-act="rules"]');
  await page.waitForSelector('#sf-modal-root [data-modal="rules"]', { timeout: 4000 }).catch(() => {});
  const rulesOpen = (await page.locator('#sf-modal-root [data-modal="rules"]').count()) === 1;
  check('hm: Rules modal opens on a real click', rulesOpen);
  if (rulesOpen) {
    const len = await page.evaluate(() => document.querySelector('#sf-modal-root [data-modal="rules"]').innerText.length);
    check('hm: Rules modal has content', len > 800, `${len} characters`);
    await shot(page, 'hm-rules-modal');
    const inside = await page.evaluate(() => !!document.activeElement && !!document.activeElement.closest('#sf-modal-root'));
    check('hm: Rules modal takes keyboard focus', inside);
    await pointerClick(page, '[data-act="close-modal"]');
    await page.waitForTimeout(200);
    check('hm: Rules modal closes', (await page.locator('#sf-modal-root [data-modal="rules"]').count()) === 0);
  }
  await keyboardPass(page, 'hm');
  // Operate an action button from the keyboard
  const before = await page.evaluate(() => window.__sf.pending ? JSON.stringify(window.__sf.pending) : 'none');
  const focused = await page.evaluate(() => { const el = document.querySelector('.sf-action.is-ready'); if (!el) return false; el.focus(); return document.activeElement === el; });
  if (focused) {
    await page.keyboard.press('Enter');
    await page.waitForTimeout(400);
    const after = await page.evaluate(() => ({ pending: window.__sf.pending ? JSON.stringify(window.__sf.pending) : 'none', seq: window.__sf.actions.length }));
    check('hm: Enter on a focused action button does something', after.pending !== before || after.seq > 0, `pending ${before} -> ${after.pending}`);
    await pointerClick(page, '#sf-stage [data-act="cancel"]');
  } else check('hm: an action button can be focused', false, 'no ready action button found');
  await bugDialog(page, 'hm');
  const res = await playToEnd(page, rand, 'board', { maxSteps: 4000 });
  check('hm: scripted human finished the game', res.finished, `${res.steps} steps, fallbacks ${await page.evaluate(() => window.__sf.fallbackCount)}`);
  await endScreenChecks(p, 'hm', 2);
  clean('hm', p);
  await p.ctx.close();
}

async function botGame(label, query, players) {
  console.log(`\n[${label}]  ?${query}`);
  const t0 = Date.now();
  const p = await open(query);
  await shot(p.page, `${label}-start`);
  await p.page.waitForFunction(() => window.__sf.screen === 'end', null, { timeout: 280000 });
  console.log(`  played to the end in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  await endScreenChecks(p, label, players);
  if (label === 'hard') await bugDialog(p.page, label);
  clean(label, p);
  await p.ctx.close();
}

async function handover() {
  console.log('\n[handover]  ?seats=h,h');
  const p = await open('seats=h,h&speed=instant');
  const { page } = p;
  const rand = rng(11);
  let seen = false;
  for (let i = 0; i < 80 && !seen; i++) {
    await page.waitForFunction(() => window.__sf.screen === 'end' || !!document.querySelector('.sf-handover') || (window.__sf.state && window.__sf.seats[window.__sf.state.toAct].kind === 'human' && !window.__sf.busy), null, { timeout: 15000 }).catch(() => {});
    if (await page.locator('.sf-handover').count()) { seen = true; break; }
    await humanStep(page, rand, 'board');
  }
  check('handover: a handover screen appears between two humans', seen);
  if (seen) {
    const info = await page.evaluate(() => {
      const el = document.querySelector('.sf-handover');
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return { covers: r.width >= innerWidth - 2 && r.height >= innerHeight - 2, text: el.innerText.slice(0, 120), bg: cs.backgroundColor, opacity: cs.opacity, seq: window.__sf.actions.length, toAct: window.__sf.state.toAct };
    });
    check('handover: the screen covers the whole viewport', info.covers, info.bg);
    await shot(page, 'handover-screen');
    // a click on the table behind it must do nothing
    await page.mouse.click(600, 500);
    await page.waitForTimeout(250);
    const seq2 = await page.evaluate(() => window.__sf.actions.length);
    check('handover: clicking the table behind it does nothing', seq2 === info.seq);
    // peek: are the hidden player's cards in the DOM and legible behind a see-through scrim?
    const peek = await page.evaluate(() => {
      const hand = [...document.querySelectorAll('#sf-side img, #sf-stage img')].filter((i) => /achievement-\d/.test(i.src)).length;
      return { handImgs: hand };
    });
    console.log(`  (achievement card images in the DOM behind the handover screen: ${peek.handImgs}; scrim colour ${info.bg})`);
    await pointerClick(page, '[data-act="handover-ok"]');
    await page.waitForTimeout(300);
    check('handover: "show my hand" dismisses it', (await page.locator('.sf-handover').count()) === 0);
    await shot(page, 'handover-after');
  }
  clean('handover', p);
  await p.ctx.close();
}

try {
  if (only.includes('landing')) await landing();
  if (only.includes('hm')) await humanVsMedium();
  if (only.includes('handover')) await handover();
  if (only.includes('demo')) await botGame('demo', 'seats=e,m,m&speed=instant', 3);
  if (only.includes('hard')) await botGame('hard', 'seats=hard,m&speed=instant', 2);
} catch (err) {
  check('the checklist ran to the end', false, err.stack || err.message);
} finally {
  await browser.close();
  const notFound = server.requests.filter((r) => r.status === 404);
  check('server saw no 404s (case-sensitive match)', notFound.length === 0, notFound.slice(0, 5).map((r) => r.url).join(', '));
  // which manifest files did this run ever ask for (informational: a card art only loads when it is shown)
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(REPO, 'assets', 'manifest.json'), 'utf8'));
    const asked = new Set(server.requests.map((r) => r.url));
    const never = manifest.assets.filter((a) => !asked.has(`${prefix}assets/${a.file}`));
    console.log(`\nassets requested by this run: ${manifest.assets.length - never.length} of ${manifest.assets.length}; never requested: ${never.length}`);
    if (never.length) console.log(`  ${never.map((a) => a.id).join(', ')}`);
  } catch { /* informational only */ }
  await server.close();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed${subpath ? ' (sub-path run)' : ''}`);
console.log('screenshots:');
for (const s of shots) console.log(`  ${s}`);
for (const f of failed) console.log(`FAILED: ${f.name} ${f.detail}`);
process.exit(failed.length ? 1 : 0);
