// analytics.js - a tiny track(event, params) plus the builders for each Superfans
// event, wired at the page's choke points by real-player.js.
//
// Inert by default: while CONFIG.GA4_MEASUREMENT_ID is empty, track() returns at
// once. No script tag is added and no request of any kind is made. When the
// designer fills the id in, the first call injects the gtag script (once) and
// events are forwarded to it (anonymize_ip on).
//
// What is sent: event names and short enumerated values (counts, scores, a bot
// level, an action TYPE, a reason CODE, a variants hash). Never a player name, a
// seed, a free-text field or a bug report. clean() drops anything that is not a
// number, a boolean or a short string, and cuts strings at 100 characters.
//
// Local visits (localhost, 127.0.0.1, ::1, *.local, file:) send nothing unless the
// address has ?ga_debug=1, so development and the test suite never reach GA.
//
// track() never throws: analytics must not be able to cost anybody a turn.
//
// Test hook: setSink(fn) sends the cleaned events to fn instead of gtag, so the
// test suite can see them without a network call. A sink only works while an id
// is set (the "empty id means nothing is sent" promise has no exceptions).
//
// THE EVENTS (keep any analytics set-up notes in step with this list):
//   game_start               player_count, human_players, bot_players, bot_levels, variants_hash, version
//   hour_end                 hour, leader_seat_type, score_spread
//   game_end                 player_count, human_players, winner_seat_type, winning_score, margin, duration_minutes,
//                            hours_played, top_vp_source, achievements_completed_total, version
//   game_abandoned           hour_reached, player_count, human_players, duration_minutes, transport_type, version
//   illegal_action_attempted action_type, reason_code
//   rules_opened             (none)
//   bug_report_opened        screen

import { CONFIG } from './config.js';

let injected = false;
let sink = null;

/** Every event name this module sends, with its parameter names (the GA doc and the tests read this table). */
export const EVENT_TABLE = Object.freeze({
  game_start: ['player_count', 'human_players', 'bot_players', 'bot_levels', 'variants_hash', 'version'],
  hour_end: ['hour', 'leader_seat_type', 'score_spread'],
  game_end: ['player_count', 'human_players', 'winner_seat_type', 'winning_score', 'margin', 'duration_minutes', 'hours_played', 'top_vp_source', 'achievements_completed_total', 'version'],
  game_abandoned: ['hour_reached', 'player_count', 'human_players', 'duration_minutes', 'transport_type', 'version'],
  illegal_action_attempted: ['action_type', 'reason_code'],
  rules_opened: [],
  bug_report_opened: ['screen'],
});

/** Sends events to `fn(event, params)` instead of gtag (tests). Pass null to go back. */
export function setSink(fn) {
  sink = typeof fn === 'function' ? fn : null;
}

/** Whether analytics is switched on (an id is configured). */
export function analyticsOn() {
  return typeof CONFIG.GA4_MEASUREMENT_ID === 'string' && CONFIG.GA4_MEASUREMENT_ID.trim() !== '';
}

/** Only simple values, short strings: no free text can slip through. */
export function clean(params) {
  const out = {};
  if (params === null || typeof params !== 'object') return out;
  for (const key of Object.keys(params)) {
    const v = params[key];
    if (typeof v === 'number' && Number.isFinite(v)) out[key] = v;
    else if (typeof v === 'boolean') out[key] = v;
    else if (typeof v === 'string') out[key] = v.slice(0, 100);
    else if (Array.isArray(v)) out[key] = v.map((x) => String(x)).join(',').slice(0, 100);
  }
  return out;
}

/** ?ga_debug=1 on the page address (GA4 DebugView, and the one way to send from a local address). */
function debugVisit() {
  return typeof location !== 'undefined' && /[?&]ga_debug=1/.test(location.search);
}

/** A development or test address: nothing is sent from here without ?ga_debug=1. */
export function localVisit() {
  if (typeof location === 'undefined') return false;
  const h = String(location.hostname || '').toLowerCase();
  return location.protocol === 'file:' || h === '' || h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '[::1]' || h.endsWith('.local');
}

function inject(id) {
  if (injected) return true;
  if (typeof document === 'undefined') return false;
  if (!/^G-[A-Z0-9]{4,}$/i.test(id)) return false;
  injected = true;
  window.dataLayer = window.dataLayer || [];
  window.gtag = function gtag() {
    window.dataLayer.push(arguments); // gtag.js reads the `arguments` object itself, not an array
  };
  window.gtag('js', new Date());
  const config = { anonymize_ip: true };
  // ?ga_debug=1 on the page address switches GA4 DebugView on for this visit (setup doc, "Verify").
  if (debugVisit()) config.debug_mode = true;
  window.gtag('config', id, config);
  const script = document.createElement('script');
  script.async = true;
  script.src = `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(id)}`;
  document.head.appendChild(script);
  return true;
}

/**
 * Records one event. Returns true when it was forwarded (or sunk), false when
 * analytics is off or anything went wrong.
 */
export function track(event, params = {}) {
  try {
    if (!analyticsOn()) return false;
    const id = CONFIG.GA4_MEASUREMENT_ID.trim();
    const cleaned = clean(params);
    if (sink) {
      sink(String(event), cleaned);
      return true;
    }
    if (localVisit() && !debugVisit()) return false;
    if (!inject(id)) return false;
    window.gtag('event', String(event), cleaned);
    return true;
  } catch {
    return false;
  }
}

// ---- parameter builders (pure: tested in Node) ------------------------------------------------------

/** A short stable hash of the non-default variants ("default" when there are none). */
export function variantsHash(variants) {
  const keys = Object.keys(variants || {}).sort();
  if (!keys.length) return 'default';
  const text = keys.map((k) => `${k}=${JSON.stringify(variants[k])}`).join('&');
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

const counts = (seats) => ({
  player_count: seats.length,
  human_players: seats.filter((s) => s.kind === 'human').length,
  bot_players: seats.filter((s) => s.kind === 'bot').length,
});

/** @param {{kind: string, level?: string}[]} seats @param {object} variants non-default variants */
export function gameStartParams(seats, variants, version = CONFIG.VERSION) {
  const levels = seats.filter((s) => s.kind === 'bot').map((s) => s.level || 'medium').sort();
  return { ...counts(seats), bot_levels: levels.length ? levels.join(',') : 'none', variants_hash: variantsHash(variants), version };
}

/** The type of the seat(s) in front on `vp` (per seat): 'human', 'bot' or 'tie' (a tie across both kinds, or a shared top). */
export function leaderSeatType(seats, vp) {
  const top = Math.max(...vp);
  const types = new Set(vp.map((v, i) => (v === top ? seats[i].kind : null)).filter(Boolean));
  const leaders = vp.filter((v) => v === top).length;
  if (leaders > 1) return types.size === 1 ? `${[...types][0]}` : 'tie';
  return [...types][0];
}

export function hourEndParams(seats, vp, hour) {
  return { hour, leader_seat_type: leaderSeatType(seats, vp), score_spread: Math.max(...vp) - Math.min(...vp) };
}

/**
 * @param {object} p
 *   seats, scores (scoreGame result), hoursPlayed, durationMs, winnerSources ({source: vp} of the first-ranked seat),
 *   achievementsCompleted (number)
 */
export function gameEndParams({ seats, scores, hoursPlayed, durationMs, winnerSources, achievementsCompleted }, version = CONFIG.VERSION) {
  const ranked = [...scores.players].sort((a, b) => a.rank - b.rank);
  const first = ranked[0];
  const second = ranked[1];
  const shared = scores.sharedTop && scores.sharedTop.length > 1;
  const topSource = Object.entries(winnerSources || {}).sort((a, b) => b[1] - a[1])[0];
  const c = counts(seats);
  return {
    player_count: c.player_count,
    human_players: c.human_players,
    winner_seat_type: shared ? 'shared' : seats[first.seat].kind,
    winning_score: first.vp,
    margin: second ? first.vp - second.vp : first.vp,
    duration_minutes: Math.round((durationMs || 0) / 60000),
    hours_played: hoursPlayed,
    top_vp_source: topSource ? topSource[0] : 'none',
    achievements_completed_total: achievementsCompleted,
    version,
  };
}

export function gameAbandonedParams(seats, hour, durationMs, version = CONFIG.VERSION) {
  const c = counts(seats);
  return { hour_reached: hour, player_count: c.player_count, human_players: c.human_players, duration_minutes: Math.round((durationMs || 0) / 60000), transport_type: 'beacon', version };
}

/**
 * The refusal text the engine gives is free text; GA gets a CODE from a closed list instead.
 * Order matters: the first pattern that matches wins.
 */
const REASON_PATTERNS = [
  ['game-over', /game is over/i],
  ['not-your-turn', /not yours|decision \(|waiting for|is thinking|not your turn/i],
  ['must-finish-first', /you must .* first|finish it with/i],
  ['already-passed', /passed this hour/i],
  ['safety-stop', /safety stop/i],
  ['too-far', /reaches at most|halls? from|too far/i],
  ['not-enough-coffee', /coffee/i],
  ['hall-full', /\bfull\b|queue|no room|has room/i],
  ['not-adjacent', /not next to|adjacent/i],
  ['not-enough-selfies', /selfie/i],
  ['supply-empty', /no .* left|on the board \(R/i],
  ['no-crew', /no crew|crew/i],
  ['volunteer-space-taken', /volunteer/i],
  ['swag-unavailable', /swag/i],
  ['achievement', /achievement/i],
  ['club', /club/i],
  ['choose-action-first', /choose an action first|not part of this action/i],
];

/** A short code for a block-reason sentence. Never returns free text. */
export function reasonCode(text) {
  const t = String(text ?? '');
  for (const [code, re] of REASON_PATTERNS) if (re.test(t)) return code;
  return 'other';
}

/** An action type or frame kind reduced to a safe token (letters and digits only). */
export function safeToken(text) {
  const t = String(text ?? '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40);
  return t || 'unknown';
}

/** Sends `game_abandoned` with the beacon transport (the page is going away). */
export function trackAbandoned(seats, hour, durationMs) {
  return track('game_abandoned', gameAbandonedParams(seats, hour, durationMs));
}

/** For tests: forget the injected flag. */
export function _resetForTests() {
  injected = false;
  sink = null;
}
