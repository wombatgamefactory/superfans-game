// bug-report-capture.js - builds the bug report: one self-contained JSON object
// that answers "why would the game not let me do X?" without a conversation.
//
// THE THREE PROMISES (each one enforced in code and asserted in tests/bug-report.test.mjs):
//
//   1. IT NEVER THROWS. Every section of the report is built inside
//      section(name, fn). A failure becomes { error: 'message' } in its place and
//      the report still completes. An `error` key anywhere in a report is
//      itself worth reading. The two loggers (logAction, logEvent) swallow their
//      own exceptions for the same reason.
//
//   2. IT NEVER MUTATES. The live game state is only ever read through
//      cloneState: one clone is what gets written (a JSON round trip), a second
//      is what the engine helpers are pointed at. The tests compare hashState of
//      the live game before and after a capture.
//
//   3. THE OUTPUT IS STRINGIFY-SAFE, PROVEN. Every section is capped (depth,
//      array length, string length) EXCEPT the two that must be complete to be
//      useful: `gameState` and `replay` (config + full action list). The finished
//      report is round-tripped once through JSON.stringify / JSON.parse, and a
//      section that will not survive is replaced by { error }.
//
// No DOM access, so the same code runs in Node (the tests). The page-specific
// facts (URL, viewport, what each control says about itself) are gathered by
// bug-report-ui.js and passed in.
//
// No rules logic lives here: diagnostics call the engine's own functions
// (getBlockReason, getStructuralBlockReason, describeDecision, describeAction,
// scoreGame ...) and report what they say.
//
// PRIVACY: a report holds the whole game state (the replay needs it), so hands
// that were hidden at the table are in the file. It holds no names beyond what the
// player typed for the seats. The player downloads it and sends it by choice.

import {
  getValidActions,
  getBlockReason,
  getStructuralBlockReason,
  describeDecision,
  describeAction,
  frameLabel,
  actionKey,
  actionFamilies,
  FRAME_ACCEPTS,
  cloneState,
  hashState,
  getGameConfig,
  replayGame,
  scoreGame,
  topFrame,
  nonDefaultVariants,
  RULES_ID,
} from '../engine/index.js';
import { CONFIG } from './config.js';

/** The version of THIS file's report format. */
export const REPORT_SCHEMA_VERSION = 1;

/** The categories, stored in the report as these verbatim labels. */
export const CATEGORIES = [
  'The game would not let me do something',
  'The game let me do something it should not',
  'Scoring looks wrong',
  'A bot did something odd',
  'Display or layout problem',
  'Something else',
];

/** Caps for everything except `gameState` and `replay`. */
export const CAPS = { depth: 12, array: 300, string: 4000 };

/** Ring-buffer sizes. */
export const LOG_SIZES = { actions: 80, events: 120 };

/** Sections that are never capped (they must be complete to be replayable). */
export const UNCAPPED_SECTIONS = ['gameState', 'replay'];

// ---------------------------------------------------------------------------
// Small helpers (all total: none of them throws)
// ---------------------------------------------------------------------------

function message(err) {
  try {
    if (err && typeof err === 'object' && 'message' in err) return String(err.message).slice(0, 500);
    return String(err).slice(0, 500);
  } catch {
    return 'unknown error';
  }
}

function jsonClone(value) {
  return value === undefined ? null : JSON.parse(JSON.stringify(value));
}

function safe(fn) {
  try {
    return fn();
  } catch (err) {
    return { error: message(err) };
  }
}

const pad = (n, width = 2) => String(n).padStart(width, '0');

function stamp(now) {
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

function randomSuffix(bytesFn) {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = new Uint8Array(4);
  try {
    if (typeof bytesFn === 'function') bytesFn(bytes);
    else globalThis.crypto.getRandomValues(bytes);
  } catch {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
}

/** "sfbug-20261031-143015-k3x9": local time, random suffix. */
export function makeReportId(now = new Date(), bytesFn = null) {
  return `sfbug-${stamp(now)}-${randomSuffix(bytesFn)}`;
}

/** A lowercase slug of a title for a file name ("" becomes "report"). */
export function slugOf(title) {
  const slug = String(title ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
  return slug || 'report';
}

/** The download file name: superfans-bug-<id>-<slug-of-title>.json (kebab-case, no spaces). */
export function reportFileName(id, title) {
  return `superfans-bug-${id}-${slugOf(title)}.json`;
}

// ---------------------------------------------------------------------------
// Caps
// ---------------------------------------------------------------------------

/**
 * A copy of `value` that JSON can always carry, within the caps. Functions,
 * symbols and bigints become short strings; NaN and Infinity become strings;
 * a cycle becomes '[circular]'; an Error becomes { error }.
 */
export function capValue(value, caps = CAPS, depth = 0, seen = new WeakSet()) {
  if (value === null) return null;
  switch (typeof value) {
    case 'string':
      return value.length > caps.string ? `${value.slice(0, caps.string)}... [+${value.length - caps.string} characters]` : value;
    case 'number':
      return Number.isFinite(value) ? value : String(value);
    case 'boolean':
      return value;
    case 'undefined':
      return null;
    case 'bigint':
      return String(value);
    case 'function':
      return '[function]';
    case 'symbol':
      return '[symbol]';
    default:
      break;
  }
  if (seen.has(value)) return '[circular]';
  if (depth >= caps.depth) return Array.isArray(value) ? `[array of ${value.length}, past the depth cap]` : '[object, past the depth cap]';
  seen.add(value);
  let out;
  if (Array.isArray(value)) {
    out = value.slice(0, caps.array).map((item) => capValue(item, caps, depth + 1, seen));
    if (value.length > caps.array) out.push(`[+${value.length - caps.array} more items]`);
  } else if (value instanceof Error) {
    out = { error: message(value) };
  } else if (value instanceof Map) {
    out = capValue(Array.from(value.entries()), caps, depth, seen);
  } else if (value instanceof Set) {
    out = capValue(Array.from(value.values()), caps, depth, seen);
  } else if (typeof value.nodeType === 'number') {
    out = '[DOM node]';
  } else {
    out = {};
    const keys = Object.keys(value);
    for (const key of keys.slice(0, 200)) {
      let item;
      try {
        item = value[key];
      } catch {
        item = '[unreadable]';
      }
      if (item === undefined) continue;
      out[key] = capValue(item, caps, depth + 1, seen);
    }
    if (keys.length > 200) out.__moreKeys = keys.length - 200;
  }
  seen.delete(value);
  return out;
}

// ---------------------------------------------------------------------------
// The local archive (pure: the page does the localStorage reads and writes)
// ---------------------------------------------------------------------------

/** About 20 reports or 4 MB of text, whichever is hit first; the oldest are evicted. */
export const ARCHIVE_CAPS = { count: 20, bytes: 4000000 };

/**
 * `list` (oldest first) with `entry` added and the oldest evicted until both
 * caps hold. An entry with the same id replaces the old one. The newest entry
 * is always kept, however large. Entries: { id, savedAt, title, fileName, text }.
 */
export function addToArchive(list, entry, caps = ARCHIVE_CAPS) {
  const out = list.filter((e) => e && e.id !== entry.id);
  out.push(entry);
  const size = () => out.reduce((n, e) => n + (e.text ? e.text.length : 0), 0);
  while (out.length > 1 && (out.length > caps.count || size() > caps.bytes)) out.shift();
  return out;
}

// ---------------------------------------------------------------------------
// The two ring buffers
// ---------------------------------------------------------------------------

const logs = { actions: [], events: [], eventCount: 0, game: 0 };

function push(buffer, entry, size) {
  buffer.push(entry);
  if (buffer.length > size) buffer.splice(0, buffer.length - size);
}

/**
 * Records one APPLIED action. `entry`: { seq, seat, name, text, how, action }
 * where `how` is 'human' | 'bot' | 'fallback' | 'generic'. Never throws.
 */
export function logAction(entry) {
  try {
    push(logs.actions, { game: logs.game, ...capValue(entry, { depth: 4, array: 20, string: 300 }) }, LOG_SIZES.actions);
  } catch {
    // a logging failure must never cost anybody a turn
  }
}

/**
 * Records one event: kind is 'error' | 'warning' | 'refusal' | 'ignored' | 'incident' | 'info'.
 * `data` is any small extra detail. Never throws.
 */
export function logEvent(kind, text, data) {
  try {
    logs.eventCount += 1;
    const entry = { n: logs.eventCount, game: logs.game, at: new Date().toISOString(), kind: String(kind), text: String(text).slice(0, 500) };
    if (data !== undefined) entry.data = capValue(data, { depth: 4, array: 20, string: 300 });
    push(logs.events, entry, LOG_SIZES.events);
  } catch {
    // swallowed on purpose
  }
}

/** A new game starts: the action log starts afresh (the event log keeps its history, tagged by game number). */
export function startLogs() {
  logs.actions.length = 0;
  logs.game += 1;
}

/** Empties both buffers (tests). */
export function resetLogs() {
  logs.actions.length = 0;
  logs.events.length = 0;
  logs.eventCount = 0;
  logs.game = 0;
}

/** Copies of both buffers. */
export function getLogs() {
  return { actionLog: logs.actions.map((e) => ({ ...e })), eventLog: logs.events.map((e) => ({ ...e })) };
}

// ---------------------------------------------------------------------------
// Diagnostics: the heart of the report
// ---------------------------------------------------------------------------

/**
 * Which player the report is about, and why. The human who must act now; if a
 * bot is to act, the human who acted last.
 */
export function pickReporter(state, seats, lastHumanActor) {
  const isHuman = (seat) => seat !== null && seat !== undefined && seats[seat] !== undefined && seats[seat].kind === 'human';
  if (state.phase === 'ended') {
    const seat = isHuman(lastHumanActor) ? lastHumanActor : Math.max(0, seats.findIndex((s) => s.kind === 'human'));
    return { seat, why: 'the game is over; the human who acted last (or the first human seat)' };
  }
  if (isHuman(state.toAct)) return { seat: state.toAct, why: 'the human who must act now' };
  if (isHuman(lastHumanActor)) return { seat: lastHumanActor, why: 'a bot is to act, so this is the human who acted last' };
  const first = seats.findIndex((s) => s.kind === 'human');
  if (first >= 0) return { seat: first, why: 'a bot is to act and no human has acted yet, so the first human seat' };
  return { seat: state.toAct ?? 0, why: 'every seat is a bot; the seat to act' };
}

function stackReport(state) {
  return {
    depth: state.stack.length,
    frames: state.stack.map((f, i) => ({ index: i, kind: f.kind, player: f.player, playerName: state.players[f.player] ? state.players[f.player].name : null, label: safe(() => frameLabel(state, f)) })),
    top: topFrame(state),
  };
}

/**
 * For every action TYPE: how many of its actions are legal right now, which frames accept it, and what the
 * engine says to a bare action of that type for the reporter (a parameter complaint is the common answer:
 * it is a probe of the ladder, not a real move). `structural` is the same question with timing aside.
 */
function typeReport(state, seat, legalNow) {
  const families = actionFamilies();
  const top = topFrame(state);
  const out = {};
  for (const type of Object.keys(families)) {
    const fam = families[type];
    const probe = { type, player: seat };
    let now;
    let structural = null;
    try {
      now = getBlockReason(state, probe);
      structural = now === null ? null : getStructuralBlockReason(state, probe);
    } catch (err) {
      now = `[the engine threw: ${message(err)}]`;
    }
    out[type] = {
      legalNow: legalNow.filter((a) => a.type === type).length,
      acceptedByTopFrame: top ? (FRAME_ACCEPTS[top.kind] || []).includes(type) : false,
      frames: fam.frames,
      rule: fam.rule,
      bareProbe: { now, structural },
    };
  }
  return out;
}

function playerNumbers(state, p, seats) {
  const seat = seats[p.seat] ?? {};
  return {
    seat: p.seat,
    name: p.name,
    kind: seat.kind ?? null,
    level: seat.level ?? null,
    colour: p.colour,
    coffee: p.coffee,
    selfies: { ...p.selfies },
    vp: p.vp,
    vpBySource: { ...p.vpBySource },
    club: p.club,
    clubUsedThisHour: p.clubUsedThisHour,
    passSlot: p.passSlot,
    mainActionsThisHour: p.mainActionsThisHour,
    handSize: p.hand ? p.hand.length : null,
    crewOnBoard: state.crew.filter((c) => c.owner === p.seat && c.hall).map((c) => ({ id: c.id, badge: c.badge, hall: c.hall })),
  };
}

/** The diagnostics section. `state` is the CLONE that engine helpers may be pointed at. */
export function buildDiagnostics(state, seats, lastHumanActor, controls) {
  const reporter = pickReporter(state, seats, lastHumanActor);
  const seat = reporter.seat;
  const diag = {
    reporter: { seat, name: state.players[seat] ? state.players[seat].name : null, why: reporter.why },
    toAct: state.toAct,
    phase: state.phase,
    hour: state.hour,
  };
  diag.decision = safe(() => describeDecision(state));
  diag.stack = safe(() => stackReport(state));
  let legalNow = [];
  diag.legal = safe(() => {
    legalNow = getValidActions(state);
    return { forSeat: state.toAct, count: legalNow.length, actions: legalNow.slice(0, 400).map((a) => ({ key: actionKey(a), text: describeAction(state, a) })) };
  });
  diag.actionTypes = safe(() => (state.phase === 'ended' ? { skipped: 'The game is over, so no action is open.' } : typeReport(state, seat, legalNow)));
  diag.legalAgreement = safe(() => {
    // every action the list offers must pass the block-reason ladder
    const refused = legalNow.filter((a) => getBlockReason(state, a) !== null).map((a) => actionKey(a));
    return { ok: refused.length === 0, offeredButRefused: refused.slice(0, 50) };
  });
  diag.players = safe(() => state.players.map((p) => safe(() => playerNumbers(state, p, seats))));
  diag.score = safe(() => {
    const s = scoreGame(state);
    return { players: s.players.map((p) => ({ seat: p.seat, name: p.name, vp: p.vp, rank: p.rank, bySource: p.bySource })) };
  });
  diag.controls = controls === undefined ? null : controls;
  return diag;
}

// ---------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------

function tableReport(state, seats) {
  return {
    seats: state.players.map((p) => {
      const seat = seats[p.seat] ?? {};
      return { seat: p.seat + 1, name: p.name, colour: p.colour, kind: seat.kind ?? null, level: seat.level ?? null };
    }),
    seed: state.config.seed,
    variantsNotDefault: nonDefaultVariants(state.variants),
  };
}

/** Re-derives the state from the replay record, in a scratch copy, and says whether it agrees. */
export function checkReplay(replay, expectedHash) {
  const started = Date.now();
  const state = replayGame(replay.config, replay.actions);
  const hash = hashState(state);
  return { ok: hash === expectedHash, replayedHash: hash, expectedHash, ms: Date.now() - started };
}

/** Paths of every { error } placed inside the report (a failure inside a section is contained by safe(); this lists them). */
function findErrorPaths(report) {
  const found = [];
  const walk = (value, path, depth) => {
    if (found.length >= 30 || depth > 6 || value === null || typeof value !== 'object') return;
    if (typeof value.error === 'string' && Object.keys(value).length === 1) {
      found.push(path);
      return;
    }
    for (const key of Object.keys(value)) {
      if (depth === 0 && UNCAPPED_SECTIONS.includes(key)) continue;
      walk(value[key], path ? `${path}.${key}` : key, depth + 1);
    }
  };
  try {
    walk(report, '', 0);
  } catch {
    // listing is a courtesy
  }
  return found;
}

/**
 * Builds the report. NEVER THROWS.
 *
 * @param {object} input
 *   state            the live game state, or null (setup screen)
 *   seats            [{ kind, level, name, colour }] by seat
 *   replay           { actions: [engine actions in the order applied] }
 *   lastHumanActor   the seat of the human who acted last, or null
 *   words            { title, category, expected, actual } as typed
 *   screen           'setup' | 'game' | 'end'
 *   ui               the UI's own state
 *   controls         what each on-screen control says about itself
 *   environment      URL, user agent, viewport, ...
 * @param {object} [options]  now, randomBytes, config (default CONFIG), failSections (test hook)
 */
export function buildReport(input = {}, options = {}) {
  try {
    return buildReportInner(input ?? {}, options ?? {});
  } catch (err) {
    return { schemaVersion: REPORT_SCHEMA_VERSION, id: `sfbug-${Date.now()}`, game: 'superfans', capture: { sectionsWithErrors: ['everything'], fatal: message(err) } };
  }
}

function buildReportInner(input, options) {
  const now = options.now instanceof Date ? options.now : new Date();
  const config = options.config || CONFIG;
  const failSections = options.failSections || [];
  const errors = [];
  const sections = {};
  const section = (name, fn) => {
    try {
      if (failSections.includes(name)) throw new Error(`forced failure of the "${name}" section (test)`);
      sections[name] = fn();
    } catch (err) {
      sections[name] = { error: message(err) };
      errors.push(name);
    }
  };

  const live = input && input.state ? input.state : null;
  const seats = input && Array.isArray(input.seats) ? input.seats : [];
  // Promise 2: one clone is what is written, one is what the engine helpers are pointed at.
  let forWrite = null;
  let forEngine = null;
  try {
    if (live) {
      forWrite = jsonClone(cloneState(live));
      forEngine = cloneState(live);
    }
  } catch (err) {
    errors.push('clone');
    sections.cloneError = { error: message(err) };
  }

  let id;
  try {
    id = makeReportId(now, options.randomBytes);
  } catch {
    id = `sfbug-${Date.now()}`;
  }

  section('schemaVersion', () => REPORT_SCHEMA_VERSION);
  section('id', () => id);
  section('game', () => 'superfans');
  section('timestamp', () => ({ iso: now.toISOString(), local: `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`, utcOffsetMinutes: -now.getTimezoneOffset() }));
  section('version', () => String(config.VERSION));
  section('rulesId', () => RULES_ID);
  section('environment', () => input.environment ?? null);
  section('screen', () => input.screen ?? null);
  section('words', () => ({ title: String(input.words?.title ?? ''), category: String(input.words?.category ?? ''), expected: String(input.words?.expected ?? ''), actual: String(input.words?.actual ?? '') }));
  section('table', () => (forEngine ? tableReport(forEngine, seats) : null));
  section('stateHash', () => (forEngine ? hashState(forEngine) : null));
  section('gameState', () => forWrite);
  section('replay', () => {
    if (!forEngine) return null;
    const actions = input.replay && Array.isArray(input.replay.actions) ? input.replay.actions : [];
    return {
      note: 'Rebuild: replayGame(config, actions). Forced (automatic) actions are re-derived by the engine and are not in this list.',
      config: jsonClone(getGameConfig(forEngine)),
      actionCount: actions.length,
      actions: jsonClone(actions),
    };
  });
  section('replayCheck', () => {
    if (!forEngine) return null;
    const rp = sections.replay;
    if (!rp || rp.error) return { ok: false, note: 'no replay record' };
    return checkReplay(rp, hashState(forEngine));
  });
  section('ui', () => input.ui ?? null);
  section('diagnostics', () => (forEngine ? buildDiagnostics(forEngine, seats, input.lastHumanActor ?? null, input.controls) : null));
  section('actionLog', () => getLogs().actionLog);
  section('eventLog', () => getLogs().eventLog);

  // Promise 3: cap everything but the sections that must be complete.
  const report = {};
  for (const name of Object.keys(sections)) {
    try {
      report[name] = UNCAPPED_SECTIONS.includes(name) ? sections[name] : capValue(sections[name]);
    } catch (err) {
      report[name] = { error: message(err) };
      errors.push(name);
    }
  }
  report.capture = { sectionsWithErrors: [...new Set(errors)], errorPaths: findErrorPaths(report), caps: CAPS, uncapped: UNCAPPED_SECTIONS };

  // ... and prove it is stringify-safe by one round trip.
  try {
    return JSON.parse(JSON.stringify(report));
  } catch {
    const out = {};
    for (const name of Object.keys(report)) {
      try {
        out[name] = JSON.parse(JSON.stringify(report[name]));
      } catch (err) {
        out[name] = { error: `could not be written as JSON: ${message(err)}` };
        out.capture.sectionsWithErrors.push(name);
      }
    }
    return out;
  }
}
