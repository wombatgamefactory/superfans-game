// bug-report-ui.js - the "Report a problem" button and dialog.
//
// The button is mounted on document.body, NOT inside the game's re-rendered
// root, so it survives every re-render. Ctrl+Shift+B opens the dialog from
// anywhere: the landing page, during play, the hand-over cover and the end screen.
//
// All the report-building logic is in bug-report-capture.js (no DOM access,
// tested in Node). This file gathers the page-only facts (URL, viewport, what
// each control says about itself), freezes the snapshot the instant the dialog
// opens, and delivers it:
//
//   - Download report: a Blob and <a download>; the file name carries the id;
//   - Copy to clipboard: always offered, and shown at once if the download fails;
//   - a pre-addressed mailto: link, ONLY when CONFIG.BUG_REPORT_EMAIL is set
//     (while it is empty the email option is hidden; download and copy still work);
//   - a local archive in localStorage (about 20 reports or 4 MB) with a
//     "Past reports" list to download one again. Every storage access is in a try/catch.
//
// The page also hooks window 'error', 'unhandledrejection' and console.error /
// console.warn into the event log (calling through to the originals).

import { CONFIG } from './config.js';
import { track } from './analytics.js';
import {
  CATEGORIES,
  ARCHIVE_CAPS,
  buildReport,
  capValue,
  reportFileName,
  addToArchive,
  logEvent,
} from './bug-report-capture.js';

const STORE_KEY = 'superfans-bug-reports-v1';

const $ = (id) => document.getElementById(id);

function esc(text) {
  return String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

// ---------------------------------------------------------------------------
// Global error hooks
// ---------------------------------------------------------------------------

function formatArg(arg) {
  try {
    if (arg instanceof Error) return arg.stack ? String(arg.stack).split('\n').slice(0, 3).join(' | ') : arg.message;
    if (typeof arg === 'string') return arg;
    return JSON.stringify(arg);
  } catch {
    return String(arg);
  }
}

let hooksInstalled = false;

/** Hooks window errors, unhandled rejections and console.error / console.warn into the event log. Idempotent. */
function installErrorHooks() {
  if (hooksInstalled) return;
  hooksInstalled = true;
  window.addEventListener('error', (event) => {
    logEvent('error', `${event.message || 'error'} (${event.filename || 'unknown file'}:${event.lineno || 0})`);
  });
  window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason;
    logEvent('error', `unhandled promise rejection: ${reason && reason.message ? reason.message : formatArg(reason)}`);
  });
  for (const level of ['error', 'warn']) {
    const original = console[level];
    console[level] = function wrapped(...args) {
      try {
        logEvent(level === 'error' ? 'error' : 'warning', `console.${level}: ${args.map(formatArg).join(' ')}`);
      } catch {
        // swallowed: logging must never get in the way
      }
      return original.apply(this, args); // devtools must not lie
    };
  }
}

// ---------------------------------------------------------------------------
// The local archive
// ---------------------------------------------------------------------------

function readArchive() {
  try {
    const text = window.localStorage.getItem(STORE_KEY);
    const list = text ? JSON.parse(text) : [];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function writeArchive(list) {
  try {
    window.localStorage.setItem(STORE_KEY, JSON.stringify(list));
    return true;
  } catch {
    return false;
  }
}

/** Adds a finished report to the archive; on a full store the oldest entries go until it fits. Returns whether it was kept. */
function archiveReport(entry) {
  let list = addToArchive(readArchive(), entry, ARCHIVE_CAPS);
  while (!writeArchive(list)) {
    if (list.length <= 1) return false;
    list = list.slice(1);
  }
  return true;
}

// ---------------------------------------------------------------------------
// What the page knows that Node does not
// ---------------------------------------------------------------------------

function environmentFacts() {
  const out = {
    url: window.location.href,
    userAgent: navigator.userAgent,
    viewport: { width: window.innerWidth, height: window.innerHeight },
    screen: { width: window.screen ? window.screen.width : null, height: window.screen ? window.screen.height : null },
    devicePixelRatio: window.devicePixelRatio,
    language: navigator.language,
    reducedMotion: false,
  };
  try {
    out.reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    out.reducedMotion = null;
  }
  return out;
}

const textOf = (el) => (el.getAttribute('aria-label') || el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 100);

/**
 * What each control the UI has rendered says about itself: label, enabled,
 * highlight state and tooltip. A disabled-looking control next to a null
 * block reason is a UI bug, and this is where it shows.
 */
function scrapeControls() {
  const root = $('sf-game');
  if (!root) return { note: 'The game screen is not showing.', items: [] };
  const items = [];
  const describe = (el, kind) => ({
    kind,
    key: el.dataset.action || el.dataset.act || el.dataset.target || '',
    label: textOf(el),
    enabled: !(el.disabled === true) && el.getAttribute('aria-disabled') !== 'true',
    legal: el.classList.contains('is-legal') || el.classList.contains('is-ready'),
    title: el.getAttribute('title') || null,
  });
  root.querySelectorAll('.sf-action').forEach((el) => items.push(describe(el, 'action-button')));
  root.querySelectorAll('[data-target].is-legal').forEach((el) => items.push(describe(el, 'lit-target')));
  root.querySelectorAll('button[data-act]').forEach((el) => items.push(describe(el, 'ui-button')));
  const limit = 150;
  return { count: items.length, truncated: items.length > limit, items: items.slice(0, limit) };
}

// ---------------------------------------------------------------------------
// The dialog
// ---------------------------------------------------------------------------

const test = { failSections: [], lastFrozen: null, lastDownload: null };

let ctxProvider = null;
let frozen = null;
let opener = null;
let modal = null;

function safeCall(fn) {
  try {
    return fn();
  } catch (err) {
    return { error: err && err.message ? String(err.message) : 'unknown error' };
  }
}

function freeze() {
  let c = {};
  try {
    c = ctxProvider ? ctxProvider() || {} : {};
  } catch (err) {
    c = { ui: { contextError: String(err && err.message) } };
  }
  const report = buildReport(
    {
      state: c.state ?? null,
      seats: c.seats ?? [],
      replay: c.replay,
      lastHumanActor: c.lastHumanActor ?? null,
      screen: c.screen,
      ui: c.ui,
      environment: safeCall(environmentFacts),
      controls: c.state ? safeCall(scrapeControls) : undefined,
      words: { title: '', category: '', expected: '', actual: '' },
    },
    { config: CONFIG, failSections: test.failSections },
  );
  test.lastFrozen = report;
  return report;
}

/** The frozen report with the player's words filled in (re-proved stringify-safe). */
function finalReport(words) {
  const caps = { depth: 3, array: 10, string: 5000 };
  const copy = { ...frozen, words: capValue(words, caps) };
  try {
    return JSON.parse(JSON.stringify(copy));
  } catch {
    return { ...frozen, words: { error: 'the words could not be written' } };
  }
}

function readWords() {
  const get = (name) => (modal.querySelector(`[data-bug-field="${name}"]`) || { value: '' }).value;
  return { title: get('title').trim(), category: get('category'), expected: get('expected').trim(), actual: get('actual').trim() };
}

function mailtoHref(report, fileName) {
  const subject = `Superfans bug report ${report.id}`;
  const body = [
    `Report id: ${report.id}`,
    `Title: ${report.words && report.words.title ? report.words.title : '(none)'}`,
    '',
    `Please attach the file "${fileName}" that was just downloaded to this email.`,
    'If it is not attached, quote the report id above so the report can still be matched.',
  ].join('\n');
  return `mailto:${encodeURIComponent(CONFIG.BUG_REPORT_EMAIL).replace(/%40/g, '@')}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

function pastListHtml() {
  const list = readArchive().slice().reverse();
  if (list.length === 0) return '<p class="bug-note" data-bug-field="past-empty">No reports saved on this device yet.</p>';
  return `<ul class="bug-past" data-bug-field="past-list">${list
    .map(
      (e) => `<li data-bug-past="${esc(e.id)}"><span class="bug-past__id">${esc(e.id)}</span> <span class="bug-past__title">${esc(e.title || '(untitled)')}</span> <small>${Math.round((e.text || '').length / 1024)} KB</small> <button type="button" class="bug-btn bug-btn--small" data-bug-act="past-download" data-bug-id="${esc(e.id)}">Download again</button></li>`,
    )
    .join('')}</ul>`;
}

function dialogHtml() {
  const hasEmail = typeof CONFIG.BUG_REPORT_EMAIL === 'string' && CONFIG.BUG_REPORT_EMAIL.trim() !== '';
  return `<div class="bug-card" role="dialog" aria-modal="true" aria-labelledby="bug-title" data-bug-field="dialog">
    <h2 id="bug-title">Report a problem</h2>
    <p class="bug-id">Report id <b data-bug-field="id">${esc(frozen.id)}</b></p>
    <p class="bug-note">The file will contain the game position (so the report can be replayed, which includes every hand), the recent actions and refusals, and what the game says about each control. No personal data beyond what you type below.</p>
    <label class="bug-row">Short title <input type="text" data-bug-field="title" maxlength="120" autocomplete="off"></label>
    <label class="bug-row">What kind of problem is it?
      <select data-bug-field="category">${CATEGORIES.map((c) => `<option value="${esc(c)}">${esc(c)}</option>`).join('')}</select></label>
    <label class="bug-row">What did you expect to happen? <textarea data-bug-field="expected" rows="2" maxlength="2000"></textarea></label>
    <label class="bug-row">What happened instead? <textarea data-bug-field="actual" rows="3" maxlength="2000"></textarea></label>
    <div class="bug-actions">
      <button type="button" class="bug-btn bug-btn--primary" data-bug-act="download">Download report</button>
      <button type="button" class="bug-btn" data-bug-act="copy">Copy to clipboard</button>
      ${hasEmail ? '<a class="bug-btn bug-link" data-bug-act="mailto" data-bug-field="mailto" href="#">Email this report</a>' : ''}
      <button type="button" class="bug-btn" data-bug-act="close">Close</button>
    </div>
    <p class="bug-status" data-bug-field="status" role="status" aria-live="polite"></p>
    <textarea class="bug-fallback" data-bug-field="fallback" rows="6" readonly hidden aria-label="The report, to copy by hand"></textarea>
    <details class="bug-pastbox" data-bug-field="past"><summary>Past reports on this device</summary><div data-bug-field="past-body">${pastListHtml()}</div></details>
  </div>`;
}

function setStatus(text) {
  const el = modal && modal.querySelector('[data-bug-field="status"]');
  if (el) el.textContent = text;
}

function refreshPast() {
  const el = modal && modal.querySelector('[data-bug-field="past-body"]');
  if (el) el.innerHTML = pastListHtml();
}

function updateMailto() {
  const link = modal && modal.querySelector('[data-bug-field="mailto"]');
  if (!link) return;
  const report = finalReport(readWords());
  link.href = mailtoHref(report, reportFileName(report.id, report.words.title));
}

/** Saves the finished report in the local archive and returns { text, fileName, report }. */
function prepare() {
  const report = finalReport(readWords());
  const fileName = reportFileName(report.id, report.words.title);
  const text = JSON.stringify(report, null, 1);
  archiveReport({ id: report.id, savedAt: report.timestamp && report.timestamp.iso, title: report.words.title, fileName, text });
  refreshPast();
  return { text, fileName, report };
}

function saveBlob(text, fileName) {
  const blob = new Blob([text], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.rel = 'noopener';
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

function showFallback(text) {
  const box = modal && modal.querySelector('[data-bug-field="fallback"]');
  if (!box) return;
  box.value = text;
  box.hidden = false;
  box.focus();
  box.select();
}

function download(text, fileName, report) {
  try {
    saveBlob(text, fileName);
    test.lastDownload = { fileName, size: text.length, id: report.id };
    setStatus(`Downloaded ${fileName}. Please send it back with the report id ${report.id}.`);
  } catch {
    setStatus('Your browser blocked the download. The report is below: copy it and send it back with the report id.');
    showFallback(text);
  }
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    setStatus('Copied to the clipboard. Paste it into your message and quote the report id.');
  } catch {
    setStatus('Could not copy automatically. The report is below: select it and copy it by hand.');
    showFallback(text);
  }
}

function onModalClick(event) {
  const el = event.target instanceof Element ? event.target.closest('[data-bug-act]') : null;
  if (!el) return;
  const act = el.dataset.bugAct;
  if (act === 'close') {
    closeDialog();
  } else if (act === 'download') {
    const { text, fileName, report } = prepare();
    download(text, fileName, report);
  } else if (act === 'copy') {
    const { text } = prepare();
    copyText(text);
  } else if (act === 'mailto') {
    // The file must exist before the mail client opens: download it, then let the link go on.
    updateMailto();
    const { text, fileName, report } = prepare();
    download(text, fileName, report);
  } else if (act === 'past-download') {
    const entry = readArchive().find((e) => e.id === el.dataset.bugId);
    if (!entry) {
      setStatus('That report is no longer stored on this device.');
      return;
    }
    try {
      saveBlob(entry.text, entry.fileName || `superfans-bug-${entry.id}.json`);
      setStatus(`Downloaded ${entry.fileName || entry.id} again.`);
    } catch {
      setStatus('Your browser blocked the download. The report is below.');
      showFallback(entry.text);
    }
  }
}

function focusables() {
  return Array.from(modal.querySelectorAll('input, select, textarea, button, a[href], summary')).filter((e) => !e.disabled && !e.hidden && e.offsetParent !== null);
}

function onModalKeydown(event) {
  if (event.key === 'Escape') {
    event.preventDefault();
    event.stopPropagation();
    closeDialog();
    return;
  }
  if (event.key === 'Tab') {
    const list = focusables();
    if (list.length === 0) return;
    const first = list[0];
    const last = list[list.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }
}

/** Opens the dialog; the snapshot is frozen NOW, not when the player submits. */
export function openDialog() {
  if (modal) {
    const title = modal.querySelector('[data-bug-field="title"]');
    if (title) title.focus();
    return;
  }
  frozen = freeze();
  opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  modal = document.createElement('div');
  modal.className = 'bug-modal';
  modal.id = 'bug-modal';
  modal.innerHTML = dialogHtml();
  modal.addEventListener('click', onModalClick);
  modal.addEventListener('keydown', onModalKeydown);
  modal.addEventListener('input', () => updateMailto());
  modal.addEventListener('change', () => updateMailto());
  // A click on the dim backdrop (outside the card) closes it.
  modal.addEventListener('mousedown', (event) => {
    if (event.target === modal) closeDialog();
  });
  document.body.appendChild(modal);
  const app = $('app');
  if (app) app.setAttribute('inert', '');
  updateMailto();
  track('bug_report_opened', { screen: String(frozen.screen) });
  const title = modal.querySelector('[data-bug-field="title"]');
  if (title) title.focus();
}

export function closeDialog() {
  if (!modal) return;
  modal.remove();
  modal = null;
  const app = $('app');
  if (app) app.removeAttribute('inert');
  const back = opener && document.contains(opener) ? opener : $('bug-report-btn');
  opener = null;
  if (back && typeof back.focus === 'function') back.focus();
}

// ---------------------------------------------------------------------------
// Mounting
// ---------------------------------------------------------------------------

function mountButton() {
  if ($('bug-report-btn')) return;
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.id = 'bug-report-btn';
  btn.className = 'bug-fab';
  btn.setAttribute('aria-haspopup', 'dialog');
  btn.title = 'Report a problem (Ctrl+Shift+B)';
  btn.innerHTML = '<span>Report a problem</span>';
  btn.addEventListener('click', () => openDialog());
  document.body.appendChild(btn);
}

/**
 * Installs the error hooks, the button and Ctrl+Shift+B.
 * @param {{ getContext: () => object }} options getContext returns the page's facts (see real-player.js)
 * @returns {object} a small API for the tests
 */
export function installBugReporter({ getContext }) {
  ctxProvider = getContext;
  installErrorHooks();
  mountButton();
  document.addEventListener(
    'keydown',
    (event) => {
      if (modal && event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        closeDialog();
        return;
      }
      if (event.ctrlKey && event.shiftKey && (event.key === 'B' || event.key === 'b')) {
        event.preventDefault();
        event.stopPropagation();
        openDialog();
      }
    },
    true,
  );
  return {
    open: openDialog,
    close: closeDialog,
    isOpen: () => modal !== null,
    /** The report frozen when the dialog last opened (as an object). */
    frozen: () => (test.lastFrozen ? JSON.parse(JSON.stringify(test.lastFrozen)) : null),
    /** A report built right now without opening the dialog. */
    capture: () => freeze(),
    /** Test hook: names of sections to break on the next capture. */
    failSections: (names) => {
      test.failSections = Array.isArray(names) ? names : [];
    },
    lastDownload: () => test.lastDownload,
    archive: {
      list: () => readArchive().map((e) => ({ id: e.id, title: e.title, fileName: e.fileName, size: (e.text || '').length })),
      add: (entry) => archiveReport(entry),
      clear: () => writeArchive([]),
      caps: ARCHIVE_CAPS,
    },
  };
}
