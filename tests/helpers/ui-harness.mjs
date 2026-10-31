// ui-harness.mjs - shared by tests/ui-generic.test.mjs and tests/ui-board.test.mjs.
//
// A tiny static server (so the tests need nothing but node and Playwright), the
// browser launch (Edge, because Playwright's own Chromium is not downloaded on
// this machine), and a scripted human who plays ONLY through the page: real
// pointer events on whatever the page highlights, or the generic buttons.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = path.dirname(fileURLToPath(import.meta.url));
export const REPO = path.resolve(here, '..', '..');
const require = createRequire(path.join(REPO, 'package.json'));

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.webp': 'image/webp', '.png': 'image/png',
  '.svg': 'image/svg+xml', '.jpg': 'image/jpeg', '.ico': 'image/x-icon',
};

/** Serves the repo on a free port. */
export async function startServer() {
  const server = http.createServer((req, res) => {
    const u = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    const f = path.join(REPO, u === '/' ? 'index.html' : u.slice(1));
    if (!f.startsWith(REPO) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream', 'cache-control': 'no-store' });
    fs.createReadStream(f).pipe(res);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  return { port, url: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(r)) };
}

/** A per-process temp folder under the system temp dir. */
export function tempDir(label) {
  const dir = path.join(os.tmpdir(), `superfans-${label}-${process.pid}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export async function launch() {
  const { chromium } = require('playwright');
  return chromium.launch({ channel: 'msedge' });
}

/** Opens a page that records console errors and page errors. */
export async function openPage(browser, server, query, viewport = { width: 1600, height: 1000 }) {
  const page = await browser.newPage({ viewport });
  const errors = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console.error: ${m.text()}`);
  });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  await page.goto(`${server.url}/index.html?${query}`);
  await page.waitForFunction(() => window.__sf && window.__sf.screen !== undefined, null, { timeout: 15000 });
  return { page, errors };
}

/** A small seeded generator for the scripted player's choices. */
export function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function centreOf(page, selector, index) {
  const loc = page.locator(selector).nth(index);
  await loc.scrollIntoViewIfNeeded({ timeout: 2000 }).catch(() => {});
  const box = await loc.boundingBox();
  return box ? { x: box.x + box.width / 2, y: box.y + box.height / 2 } : null;
}

/** A real pointer click at the centre of the nth match. */
export async function pointerClick(page, selector, index = 0) {
  const c = await centreOf(page, selector, index);
  if (!c) return false;
  await page.mouse.move(c.x, c.y);
  await page.mouse.down();
  await page.mouse.up();
  return true;
}

/** Waits until nothing is animating or being decided by a bot: the next decision is the player's, or the game ended. */
export async function settle(page, ms = 20000) {
  await page.waitForFunction(
    () => {
      const sf = window.__sf;
      if (!sf) return false;
      if (sf.screen === 'end') return true;
      if (document.querySelector('#sf-modal-root [data-modal="score"], #sf-modal-root [data-modal="final"], #sf-modal-root .sf-handover')) return true;
      if (sf.busy) return false;
      const st = sf.state;
      if (!st) return false;
      if (sf.seats[st.toAct] && sf.seats[st.toAct].kind === 'bot') return false;
      return true;
    },
    null,
    { timeout: ms },
  );
}

/** What the page currently offers, read from the DOM (never from the engine). */
async function readPage(page) {
  return page.evaluate(() => {
    const q = (s) => [...document.querySelectorAll(s)];
    const visible = (el) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    };
    const modal = document.querySelector('#sf-modal-root [data-modal], #sf-modal-root .sf-handover');
    return {
      screen: window.__sf.screen,
      modal: modal ? (modal.classList.contains('sf-handover') ? 'handover' : modal.dataset.modal) : null,
      legalTargets: q('#sf-stage .is-legal, #sf-side .sf-card.is-legal').filter(visible).length,
      ready: q('.sf-action.is-ready').map((e) => e.dataset.action),
      done: q('#sf-stage [data-act^="do:"]').map((e) => e.dataset.act),
      rewards: q('.sf-rung [data-act^="reward:"]').map((e) => e.dataset.act),
      exchanges: q('.sf-trade:not([aria-disabled="true"])[data-act]').map((e) => e.dataset.act),
      cancel: !!document.querySelector('#sf-stage [data-act="cancel"]'),
      gen: q('[data-gen]').length,
      toAct: window.__sf.state ? window.__sf.state.toAct : null,
      seat: window.__sf.state && window.__sf.seats[window.__sf.state.toAct] ? window.__sf.seats[window.__sf.state.toAct].kind : null,
      prompt: (document.querySelector('#sf-stage .sf-banner__text') || {}).textContent || '',
    };
  });
}

/**
 * One step of the scripted human, using only what the page shows. Returns a short label of what it did
 * (for the log) or null when the game is over.
 * `mode`: 'board' (pointer clicks on highlighted targets and action buttons) or 'generic' (the generic list only).
 */
export async function humanStep(page, rand, mode = 'board') {
  await settle(page);
  const s = await readPage(page);
  if (s.screen === 'end') return null;
  if (s.modal === 'handover') {
    await pointerClick(page, '[data-act="handover-ok"]');
    return 'handover';
  }
  if (mode === 'generic') {
    if (s.modal === 'handover') return 'handover';
    const n = s.gen;
    if (n === 0) {
      if (s.modal === 'score' || s.modal === 'final') {
        await pointerClick(page, '[data-act="score-continue"]');
        return 'continue';
      }
      throw new Error(`generic mode: no generic buttons on screen (toAct ${s.toAct}, modal ${s.modal})`);
    }
    const i = Math.floor(rand() * n);
    await pointerClick(page, '[data-gen]', i);
    return 'generic';
  }
  switch (s.modal) {
    case 'score':
    case 'final':
      await pointerClick(page, '[data-act="score-continue"]');
      return 'continue';
    case 'confirm-pass':
      await pointerClick(page, '[data-act="pass-ok"]');
      return 'pass-ok';
    case 'pass-achievement':
    case 'pick-card':
    case 'convert':
    case 'discard': {
      const n = await page.locator('#sf-modal-root [data-do]').count();
      await pointerClick(page, '#sf-modal-root [data-do]', Math.floor(rand() * n));
      return s.modal;
    }
    case 'choice': {
      const n = await page.locator('#sf-modal-root [data-act^="opt:"]').count();
      await pointerClick(page, '#sf-modal-root [data-act^="opt:"]', Math.floor(rand() * n));
      return 'choice';
    }
    case 'gain': {
      for (let k = 0; k < 8; k += 1) {
        const ok = await page.locator('#sf-modal-root [data-act="gain-ok"]:not([disabled])').count();
        if (ok) break;
        const plus = page.locator('#sf-modal-root [data-act^="gain+:"]:not([disabled])');
        const pn = await plus.count();
        if (!pn) break;
        await pointerClick(page, '#sf-modal-root [data-act^="gain+:"]:not([disabled])', Math.floor(rand() * pn));
      }
      await pointerClick(page, '#sf-modal-root [data-act="gain-ok"]');
      return 'gain';
    }
    case 'log':
    case 'rules':
    case 'settings':
      await pointerClick(page, '[data-act="close-modal"]');
      return 'close';
    default:
      break;
  }
  if (s.seat !== 'human') return 'wait';
  // reward on the ladder
  if (s.rewards.length) {
    await pointerClick(page, '.sf-rung [data-act^="reward:"]', Math.floor(rand() * s.rewards.length));
    return 'reward';
  }
  // something is lit on the board: click it (sometimes finish early with Done)
  if (s.legalTargets > 0) {
    if (s.done.length && rand() < 0.3) {
      await pointerClick(page, '#sf-stage [data-act^="do:"]', 0);
      return 'done';
    }
    await pointerClick(page, '#sf-stage .is-legal, #sf-side .sf-card.is-legal', Math.floor(rand() * s.legalTargets));
    return 'target';
  }
  if (s.done.length) {
    await pointerClick(page, '#sf-stage [data-act^="do:"]', 0);
    return 'done';
  }
  if (s.exchanges.length && rand() < 0.08) {
    await pointerClick(page, '.sf-trade:not([aria-disabled="true"])[data-act]', Math.floor(rand() * s.exchanges.length));
    return 'exchange';
  }
  if (s.ready.length) {
    // spread the choices: prefer not to pass early
    const pool = s.ready.filter((a) => a !== 'pass');
    const pick = pool.length && rand() < 0.93 ? pool[Math.floor(rand() * pool.length)] : s.ready[Math.floor(rand() * s.ready.length)];
    const sel = pick === 'pass' ? '.sf-action[data-action="pass"]' : `.sf-action[data-action="${pick}"]`;
    await pointerClick(page, sel);
    return `button:${pick}`;
  }
  if (s.cancel) {
    await pointerClick(page, '#sf-stage [data-act="cancel"]');
    return 'cancel';
  }
  throw new Error(`the scripted player is stuck (toAct ${s.toAct}, prompt "${s.prompt}")`);
}

/** Plays until the end screen (or maxSteps), returning the counts. */
export async function playToEnd(page, rand, mode, { maxSteps = 4000, onStep = null } = {}) {
  const counts = {};
  let steps = 0;
  for (; steps < maxSteps; steps += 1) {
    const label = await humanStep(page, rand, mode);
    if (label === null) break;
    counts[label.split(':')[0]] = (counts[label.split(':')[0]] || 0) + 1;
    if (onStep) await onStep(label, steps);
  }
  return { steps, counts, finished: steps < maxSteps };
}
