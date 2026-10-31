// history.js - "your last games", kept in this browser's localStorage.
//
// Stays on the device: nothing here is ever sent anywhere. Every storage access
// is in a try/catch (private windows and blocked storage throw), and the page
// works the same when storage is unavailable. Capped at MAX_GAMES entries.

import { escapeHtml } from './art.js';

export const HISTORY_KEY = 'superfans-history-v1';
export const MAX_GAMES = 20;

function store() {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

/** Newest first. Always an array. */
export function readHistory() {
  try {
    const s = store();
    if (!s) return [];
    const list = JSON.parse(s.getItem(HISTORY_KEY) || '[]');
    return Array.isArray(list) ? list.filter((e) => e && typeof e === 'object') : [];
  } catch {
    return [];
  }
}

function write(list) {
  try {
    const s = store();
    if (!s) return false;
    s.setItem(HISTORY_KEY, JSON.stringify(list));
    return true;
  } catch {
    return false;
  }
}

/**
 * The summary line of one finished game.
 * @param {{ state: object, scores: object, seats: object[], durationMs: number, now?: Date }} g
 */
export function summarise({ state, scores, seats, durationMs, now = new Date() }) {
  const ranked = [...scores.players].sort((a, b) => a.rank - b.rank);
  return {
    at: now.toISOString(),
    players: seats.length,
    hours: state.hour,
    minutes: Math.max(1, Math.round((durationMs || 0) / 60000)),
    winner: ranked[0] ? { name: ranked[0].name, kind: seats[ranked[0].seat].kind, vp: ranked[0].vp } : null,
    table: ranked.map((p) => ({ name: p.name, kind: seats[p.seat].kind, level: seats[p.seat].level ?? null, vp: p.vp })),
  };
}

/** Adds a game (newest first, capped). Returns the new list. */
export function addGame(entry) {
  const list = [entry, ...readHistory()].slice(0, MAX_GAMES);
  while (list.length && !write(list)) list.pop();
  return list;
}

export function clearHistory() {
  write([]);
}

function dateText(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** The "Your last games" block for the landing page ('' when there are none). */
export function historyHtml(limit = 5) {
  const list = readHistory().slice(0, limit);
  if (!list.length) return '';
  const rows = list
    .map((g) => {
      const you = g.table && g.table.some((p) => p.kind === 'human') ? '' : ' (bots only)';
      const table = (g.table || []).map((p, i) => `<span class="sf-hist__p">${i + 1}. ${escapeHtml(p.name)} <b>${Number(p.vp) || 0}</b></span>`).join('');
      return `<li class="sf-hist__row"><span class="sf-hist__when">${escapeHtml(dateText(g.at))}</span>
        <span class="sf-hist__win">${g.winner ? `${escapeHtml(g.winner.name)} won with ${Number(g.winner.vp) || 0} VP` : 'Finished'}${you}</span>
        <span class="sf-hist__meta">${Number(g.players) || 0} players &middot; ${Number(g.minutes) || 1} min</span>
        <span class="sf-hist__table">${table}</span></li>`;
    })
    .join('');
  return `<section class="sf-panel sf-hist" aria-labelledby="hist-title" data-history>
    <h2 class="sf-panel__title" id="hist-title" style="font-size:var(--fs-lg)">Your last games <small>kept on this device only</small></h2>
    <ul class="sf-hist__list">${rows}</ul>
    <button class="sf-btn sf-btn--ghost" data-hist-clear type="button">Clear this list</button>
  </section>`;
}

/** Wires the Clear button (delegated, installed once). */
export function installHistoryClear() {
  if (typeof document === 'undefined') return;
  document.addEventListener('click', (e) => {
    const t = e.target instanceof Element ? e.target.closest('[data-hist-clear]') : null;
    if (!t) return;
    clearHistory();
    const sec = t.closest('[data-history]');
    if (sec) sec.remove();
  });
}
