// main.js - the page controller. Owns the game state, the commit path every
// action takes (human click, bot move, generic button), undo, the hotseat
// handover, animations and the screens.
//
// HOOK POINTS for T16 (analytics, stats, game record, bug reporter): there is
// exactly one place each for "a game started", "an action was applied" and "a
// game ended". Register with registerHooks({ onGameStart, onAction, onGameEnd,
// onRefusal, onRender }); every hook is optional and may be async-free. See
// `hooks` below.

import {
  createGame,
  applyAction,
  getValidActions,
  getBlockReason,
  isGameOver,
  cloneState,
  topFrame,
  describeDecision,
  describeAction,
  scoreGame,
  EVENTS,
  slotsOfHour,
  crewById,
  capacity,
  isFull,
  hallDistance,
  ordinal,
  RULES_ID,
  getGameConfig,
  makeRng,
} from '../engine/index.js';
import { CONFIG } from './config.js';
import { loadArt, installArtFallback } from './art.js';
import { loadBots, botLevels, FALLBACK_LEVELS } from './bots-bridge.js';
import { createBotDriver } from './bot-driver.js';
import {
  getView, getPending, arm, setPicked, cancelPending, resetPending, setNotice, clearNotice, openModal, closeModal,
  setFlash, clearFlash, resetForNewGame, escape as escapeKey, nextId,
} from './ui-state.js';
import { eligibleEntries, resolveClick, stepOf, refusalReason, kindOfKey, valueOfKey, BUTTON_FRAMES, SLOT_DEFS } from './action-targets.js';
import { renderBoard, makeClasser, fullTag } from './board-render.js';
import { renderTopbar, renderPlayers, renderSide, renderPrompt, renderToast, renderFloats } from './panels.js';
import { modalFor, renderModal, selfieIcons } from './modals.js';
import { previewMove } from './preview.js';
import { eventsToLog } from './log.js';
import { playWalk, patchDisplay } from './walk.js';
import { renderEnd } from './end-screen.js';
import { showSetup, defaultSeats } from './setup.js';

// ---- hooks (T16) -------------------------------------------------------------------------

const hooks = { onGameStart: [], onAction: [], onGameEnd: [], onRefusal: [], onRender: [] };

/** Register callbacks. Each is optional: { onGameStart(info), onAction(events, info), onGameEnd(info), onRefusal(info), onRender() }. */
export function registerHooks(h) {
  for (const k of Object.keys(hooks)) if (typeof h[k] === 'function') hooks[k].push(h[k]);
}

function fire(name, ...args) {
  for (const fn of hooks[name]) {
    try {
      fn(...args);
    } catch (err) {
      // a broken hook must never break the game
      app.incidents.push(`hook ${name}: ${err && err.message}`);
    }
  }
}

// ---- the app --------------------------------------------------------------------------------

const app = {
  root: null,
  screen: 'setup',
  seats: [],
  seed: 0,
  state: null,
  actions: [],
  events: [],
  log: [],
  undo: [],
  busy: false,
  driver: null,
  botsReal: false,
  incidents: [],
  fallbackCount: 0,
  fallbackTypes: [],
  humanActions: 0,
  undoSeat: null,
  regions: {},
  startedAt: 0,
  walkFactor: 1,
  skipping: false,
};

const params = new URLSearchParams(location.search);
const view = getView();

// ---- helpers ------------------------------------------------------------------------------------

const humanCount = () => app.seats.filter((s) => s.kind === 'human').length;

function speedFactor() {
  const base = { normal: 1, fast: 0.35, instant: 0 }[view.speed] ?? 1;
  return app.skipping ? 0 : base * app.walkFactor;
}

function wait(ms) {
  const f = speedFactor();
  if (f === 0) return Promise.resolve();
  return new Promise((r) => setTimeout(r, ms * f));
}

function reducedMotion() {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** The one message. Every refusal and notice goes through here. */
function say(text, kind = 'refuse', sub = '') {
  const n = setNotice(text, kind, sub);
  if (kind === 'refuse') fire('onRefusal', { text, state: app.state });
  const id = n.id;
  setTimeout(() => {
    if (view.notice && view.notice.id === id) {
      clearNotice();
      render();
    }
  }, kind === 'refuse' ? 4200 : 2600);
  render();
}

// ---- context for the renderers ----------------------------------------------------------------------

function buildCtx() {
  const real = app.state;
  const state = view.display ?? real;
  const over = isGameOver(real);
  const seats = app.seats;
  const toAct = real.toAct;
  const humans = humanCount();
  const scoreOpen = view.modal && (view.modal.kind === 'score' || view.modal.kind === 'final');
  const isHuman = toAct !== null && seats[toAct] && seats[toAct].kind === 'human';
  const needsHandover = !over && !view.walk && !app.busy && humans >= 2 && isHuman && view.deviceHolder !== toAct;
  const canAct = !over && isHuman && !needsHandover && !app.busy && !view.walk && !scoreOpen;
  const legal = canAct ? getValidActions(real) : [];
  const frame = topFrame(real);
  const generic = view.generic;
  const pending = getPending();
  const entries = canAct && !generic ? eligibleEntries(frame ? frame.kind : null, legal, pending.armed) : [];
  const active = canAct && !generic && entries.length > 0 && (pending.armed !== null || !BUTTON_FRAMES.includes(frame.kind));
  const targets = { entries, picked: pending.picked, active };
  const classer = makeClasser(state, targets);
  const viewer = canAct
    ? toAct
    : view.deviceHolder !== null && seats[view.deviceHolder] && seats[view.deviceHolder].kind === 'human'
      ? view.deviceHolder
      : seats.findIndex((s) => s.kind === 'human') >= 0
        ? seats.findIndex((s) => s.kind === 'human')
        : toAct ?? 0;
  const handVisible = (seat) => {
    if (needsHandover) return false;
    if (humans === 1) return seats[seat].kind === 'human';
    return canAct && seat === toAct && view.deviceHolder === seat;
  };
  const waitName = toAct !== null ? real.players[toAct].name : '';
  const waitText = over
    ? 'The convention is over.'
    : needsHandover
      ? `Waiting for ${waitName} to take the device.`
      : isHuman
        ? 'One moment...'
        : `${waitName} is thinking...`;
  const waitReason = isHuman ? 'Please wait a moment.' : `It is ${waitName}'s turn (${seats[toAct] ? seats[toAct].level : ''} bot).`;
  const ctx = {
    state, real, legal, frame, view, seats, toAct, canAct, needsHandover, generic, pending, targets, classer, viewer,
    handVisible, waitText, waitReason, actorSeat: canAct ? toAct : viewer,
    undoCount: !app.busy && !needsHandover && !over && !view.walk && (humans < 2 || view.deviceHolder === app.undoSeat) ? app.undo.length : 0,
    decision: canAct ? describeDecision(real) : null, log: app.log, seed: app.seed, botsReal: app.botsReal,
    thinking: !isHuman && !over && !view.walk && toAct !== null ? toAct : null,
    tags: new Map(),
    routes: [],
  };
  // tags on halls while a hall is being picked
  if (active) {
    const here = stepOf(entries, pending.picked);
    if (here.kinds.has('hall')) {
      for (const [key, list] of here.next) {
        if (kindOfKey(key) !== 'hall') continue;
        const a = list[0].action;
        const to = valueOfKey(key);
        if (a.crew && (a.type === 'move2' || a.type === 'move3' || a.type === 'moveStep' || a.type === 'effectMove')) {
          const c = crewById(real, a.crew);
          const pm = previewMove(real, a);
          const d = c && c.hall ? hallDistance(c.hall, to) : null;
          const bits = [];
          if (d !== null && a.type === 'move2') bits.push(`${d} hall${d === 1 ? '' : 's'}`);
          if (pm && pm.position) bits.push(`${ordinal(pm.position)} in queue`);
          if (pm && pm.usherCoffee) bits.push(`+${pm.usherCoffee} coffee`);
          ctx.tags.set(key, bits.join(' · '));
        } else if (a.type === 'newNoob' || a.type === 'placeOpeningCrew' || a.type === 'effectPlaceCrew') {
          ctx.tags.set(key, 'Place here');
        }
      }
      for (const h of capacityHalls(real)) {
        const key = `hall:${h}`;
        if (!here.next.has(key) && isFull(real, h)) ctx.tags.set(key, fullTag(real, h));
      }
    }
  }
  return ctx;
}

function capacityHalls(state) {
  return state.crew.length ? [...new Set(state.crew.filter((c) => c.hall).map((c) => c.hall))] : [];
}

function boardCtx(ctx) {
  const state = ctx.state;
  const routes = [];
  if (view.walk) {
    for (const w of view.walk.routes) routes.push({ card: w.card, colour: w.colour, doneTo: w.doneTo, preview: false });
  } else if (state.phase === 'floor' || state.phase === 'coffeeBreak') {
    for (const e of slotsOfHour(state, state.hour)) if (e.status === 'onBoard') routes.push({ card: e.card, colour: e.colour, doneTo: 0, preview: true });
  }
  const picked = ctx.pending.picked.find((k) => kindOfKey(k) === 'crew');
  const sourceCrew = picked ? crewById(ctx.real, valueOfKey(picked)) : null;
  const walking = view.walk && view.walk.routes.length ? view.walk.routes[view.walk.routes.length - 1].card : null;
  return {
    classer: ctx.classer,
    tags: ctx.tags,
    view,
    routes,
    walkingCard: view.walk ? walking : null,
    sourceHall: sourceCrew ? sourceCrew.hall : null,
    dim: false,
  };
}

// ---- rendering ----------------------------------------------------------------------------------------

function ensureGameDom() {
  if (app.root.dataset.screen === 'game') return;
  app.root.dataset.screen = 'game';
  app.regions = {};
  document.body.classList.add('sf-page--game');
  app.root.innerHTML = `<div class="sf-game" id="sf-game">
    <header class="sf-topbar" id="sf-top"></header>
    <aside class="sf-players" id="sf-players" aria-label="Players"></aside>
    <main class="sf-stage" id="sf-stage"></main>
    <aside class="sf-side" id="sf-side" aria-label="This Hour, actions and market"></aside>
  </div><div id="sf-modal-root"></div>`;
}

function setRegion(id, html) {
  if (app.regions[id] === html) return false;
  const el = document.getElementById(id);
  if (!el) return false;
  const scroll = el.scrollTop;
  let rects = null;
  if (id === 'sf-stage') {
    rects = captureCrew();
    const tip = document.getElementById('sf-tip');
    if (tip) tip.remove();
  }
  el.innerHTML = html;
  el.scrollTop = scroll;
  app.regions[id] = html;
  if (rects) flipCrew(rects);
  return true;
}

function captureCrew() {
  const out = new Map();
  for (const el of document.querySelectorAll('#sf-stage [data-crew]')) out.set(el.dataset.crew, el.getBoundingClientRect());
  return out;
}

/** FLIP: a Crew that changed place slides from where it was (350 ms). */
function flipCrew(before) {
  if (reducedMotion() || view.speed === 'instant' || before.size === 0) return;
  for (const el of document.querySelectorAll('#sf-stage [data-crew]')) {
    const was = before.get(el.dataset.crew);
    if (!was) continue;
    const now = el.getBoundingClientRect();
    const dx = was.left - now.left;
    const dy = was.top - now.top;
    if (Math.abs(dx) < 2 && Math.abs(dy) < 2) continue;
    el.animate([{ transform: `translate(${dx}px, ${dy}px)`, zIndex: 9 }, { transform: 'none', zIndex: 9 }], { duration: 350, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' });
  }
}

function render() {
  if (app.screen === 'end' || app.screen === 'setup' || !app.state) return;
  ensureGameDom();
  const ctx = buildCtx();
  const bctx = boardCtx(ctx);
  setRegion('sf-top', renderTopbar(ctx));
  setRegion('sf-players', renderPlayers(ctx));
  setRegion(
    'sf-stage',
    `<div class="sf-promptbar">${renderPrompt(ctx)}</div><div class="sf-boardwrap">${renderBoard(ctx.state, bctx)}${renderFloats(ctx)}${renderToast(ctx)}</div>`,
  );
  setRegion('sf-side', renderSide(ctx));
  const modal = modalFor(ctx);
  const modalHtml = modal ? renderModal(ctx, modal) : '';
  const rootEl = document.getElementById('sf-modal-root');
  if (rootEl && app.regions['sf-modal-root'] !== modalHtml) {
    rootEl.innerHTML = modalHtml;
    app.regions['sf-modal-root'] = modalHtml;
    const focusEl = rootEl.querySelector('[autofocus], button:not([disabled])');
    if (focusEl && modal && modal.kind !== 'log') focusEl.focus({ preventScroll: true });
  }
  const logEl = document.querySelector('.sf-log--tall');
  if (logEl) logEl.scrollTop = logEl.scrollHeight;
  document.documentElement.dataset.toAct = String(ctx.toAct);
  fire('onRender');
}

// ---- the commit path ------------------------------------------------------------------------------------------

/** Events that make an undo unfair: a hidden or random card was revealed. */
const REVEALS = new Set([EVENTS.ACHIEVEMENT_DRAWN, EVENTS.DECK_RESHUFFLED, EVENTS.SWAG_DEALT]);

function snapshot() {
  return { state: cloneState(app.state), actions: app.actions.length, log: app.log.length, events: app.events.length };
}

/**
 * Applies an action: the only way the state changes. Returns { ok, error? }.
 * @param {object} action an engine action
 * @param {'human'|'bot'|'fallback'|'generic'} how
 */
async function commit(action, how) {
  if (app.busy || app.screen !== 'game') return { ok: false, error: 'busy' };
  const s = app.state;
  const reason = getBlockReason(s, action);
  if (reason) {
    return { ok: false, error: reason };
  }
  app.busy = true;
  const human = how !== 'bot' && how !== 'fallback';
  const snap = human ? snapshot() : null;
  const before = cloneState(s);
  let events;
  try {
    events = applyAction(s, action) ?? [];
  } catch (err) {
    app.busy = false;
    return { ok: false, error: err.reason || err.message };
  }
  const actor = before.toAct;
  app.actions.push({ action, seat: actor, hour: before.hour, how });
  app.events.push(...events);
  app.log.push(...eventsToLog(s, events, before.hour));
  // Commit points: another player acts, the Hour moves on (the Walk), or a hidden/random card is revealed.
  if (!human || app.undoSeat !== actor) app.undo = [];
  if (human) {
    app.humanActions += 1;
    app.undo.push(snap);
    app.undoSeat = actor;
  }
  const boundary = s.phase !== before.phase || s.hour !== before.hour || events.some((e) => REVEALS.has(e.type) && e.type !== EVENTS.SWAG_DEALT);
  if (boundary) app.undo = [];
  resetPending();
  fire('onAction', events, { action, how, state: s, before, seat: actor });
  try {
    await present(before, events);
  } finally {
    app.busy = false;
  }
  if (isGameOver(s)) {
    await finishGame();
  } else {
    render();
    app.driver.kick();
  }
  return { ok: true };
}

/** Animations for one action's events. */
async function present(before, events) {
  const pour = [];
  const halls = [];
  const crewNew = [];
  const gain = [];
  for (const ev of events) {
    if (ev.type === EVENTS.COFFEE_GAIN && ev.cause === 'coffee-break' && ev.amount > 0) pour.push(ev.player);
    if (ev.type === EVENTS.SELFIE_GAIN && ev.cause === 'take-selfie') {
      if (ev.detail && ev.detail.hall) halls.push(ev.detail.hall);
      gain.push(ev.player);
    }
    if (ev.type === EVENTS.CREW_PLACED) crewNew.push(ev.crew);
  }
  const hasWalk = events.some((e) => e.type === EVENTS.CELEBRITY_ENTERED);
  app.skipping = false;
  if (hasWalk) {
    await playWalk(
      {
        view,
        setDisplay: (st) => { view.display = st; },
        render,
        wait,
        showScore,
        addFloat,
      },
      before,
      events,
    );
  }
  const take = events.find((e) => e.type === EVENTS.SELFIE_GAIN && e.cause === 'take-selfie');
  if (take && take.detail && take.detail.hall && !hasWalk) {
    const centre = floatPos(take.detail.hall);
    const colour = ['green', 'red', 'orange'].find((c) => take.gain[c] > 0) ?? 'green';
    addFloat({ colour: app.state.players[take.player].colour, x: centre.x, y: centre.y, html: `+1 ${colour} Selfie` });
  }
  setFlash({ pour: pour.length ? [...new Set(pour)] : [], gain, halls: hasWalk ? [] : halls, crew: crewNew });
  if (pour.length) {
    const names = [...new Set(pour)].length;
    if (names > 0 && app.state.phase !== 'ended') say('Coffee Break: everyone pours a fresh coffee.', 'good', events.filter((e) => e.type === EVENTS.COFFEE_GAIN && e.cause === 'coffee-break').map((e) => `${app.state.players[e.player].name} +${e.amount}`).join(', '));
  }
  render();
  if (halls.length || pour.length || gain.length) {
    setTimeout(() => {
      clearFlash();
      render();
    }, 700);
  }
}

function floatPos(hall) {
  const grid = { 'artist-alley': [0, 0], 'main-stage': [0, 1], 'cosplay-arena': [0, 2], 'autograph-hall': [1, 0], 'main-hall': [1, 1], 'vendor-hall': [1, 2], 'photo-ops': [2, 0], entrance: [2, 1], 'food-trucks': [2, 2] }[hall] ?? [1, 1];
  return { x: ((50 + grid[1] * 114) / 328) * 100, y: ((50 + grid[0] * 114) / 328) * 100 - 6 };
}

function addFloat(f) {
  const id = nextId();
  view.floats.push({ ...f, id });
  setTimeout(() => {
    view.floats = view.floats.filter((x) => x.id !== id);
    render();
  }, 1500);
}

/** Opens the scoring popup and waits for Continue (bots-only games continue by themselves). */
function showScore(data) {
  return new Promise((resolve) => {
    openModal({ kind: 'score', ...data, closable: false, resolve });
    render();
    if (humanCount() === 0) {
      const f = { normal: 2400, fast: 700, instant: 0 }[view.speed] ?? 2400;
      setTimeout(() => continueModal(), f);
    }
  });
}

function continueModal() {
  const m = view.modal;
  if (!m || !m.resolve) return;
  closeModal();
  render();
  m.resolve();
}

async function finishGame() {
  const s = app.state;
  const finals = app.events.filter((e) => e.type === EVENTS.ACHIEVEMENT_SCORED && e.when === 'final');
  if (finals.length && app.actions.length) {
    await new Promise((resolve) => {
      openModal({ kind: 'final', items: finals.map((e) => ({ player: e.player, card: e.card, count: e.count, laurel: e.laurel, multiplier: e.multiplier, vp: e.vp, tripled: e.tripled })), closable: false, resolve });
      render();
      if (humanCount() === 0) setTimeout(() => continueModal(), { normal: 2400, fast: 700, instant: 0 }[view.speed] ?? 2400);
    });
  }
  fire('onGameEnd', { state: s, scores: scoreGame(s), seats: app.seats, record: buildRecord(), events: app.events, durationMs: performance.now() - app.startedAt });
  app.screen = 'end';
  app.driver.cancel();
  app.root.dataset.screen = 'end';
  document.body.classList.remove('sf-page--game');
  app.root.innerHTML = renderEnd(s, app.seats, app.events, {});
  window.scrollTo(0, 0);
  fire('onRender');
}

function buildRecord() {
  const cfg = getGameConfig(app.state);
  return {
    game: 'superfans',
    version: CONFIG.VERSION,
    rulesId: RULES_ID,
    seed: app.seed,
    config: cfg,
    seats: app.seats.map((s) => ({ kind: s.kind, level: s.level, name: s.name, colour: s.colour })),
    actions: app.actions.map((a) => ({ seat: a.seat, hour: a.hour, how: a.how, action: a.action })),
    finalScores: scoreGame(app.state).players.map((p) => ({ seat: p.seat, name: p.name, vp: p.vp, rank: p.rank })),
  };
}

// ---- undo ---------------------------------------------------------------------------------------------------------

function doUndo() {
  if (app.busy || !app.undo.length) return say('Nothing to undo: undo works until another player acts.', 'info');
  app.driver.cancel();
  const snap = app.undo.pop();
  app.state = snap.state;
  app.actions.length = snap.actions;
  app.log.length = snap.log;
  app.events.length = snap.events;
  resetPending();
  render();
  app.driver.kick();
}

// ---- starting games ---------------------------------------------------------------------------------------------------

function randomSeed() {
  const a = new Uint32Array(1);
  crypto.getRandomValues(a);
  return a[0] % 2147483647;
}

function startGame(setup) {
  const seed = setup.seed ?? randomSeed();
  app.seed = seed;
  app.seats = setup.seats.map((s) => ({ ...s }));
  const config = {
    players: app.seats.map((s) => ({ name: s.name, colour: s.colour })),
    variants: setup.variants ?? {},
  };
  const made = createGame(config, { seed, events: true });
  app.state = made.state;
  app.actions = [];
  app.events = [...made.events];
  app.log = eventsToLog(app.state, made.events, 1);
  app.undo = [];
  app.busy = false;
  app.fallbackCount = 0;
  app.fallbackTypes = [];
  app.humanActions = 0;
  app.startedAt = performance.now();
  resetForNewGame();
  view.deviceHolder = null;
  app.driver.cancel();
  app.driver.seed(seed);
  app.screen = 'game';
  app.root.dataset.screen = '';
  app.lastSetup = { seats: app.seats.map((s) => ({ ...s })), seed: null, variants: setup.variants ?? {} };
  fire('onGameStart', { state: app.state, seats: app.seats, seed, config, record: buildRecord() });
  render();
  app.driver.kick();
}

function toSetup() {
  app.screen = 'setup';
  app.driver.cancel();
  app.root.dataset.screen = 'setup';
  app.regions = {};
  document.body.classList.remove('sf-page--game');
  showSetup(app.root, { seats: app.lastSetup ? app.lastSetup.seats : defaultSeats(), levels: botLevels(), onStart: startGame });
}

// ---- clicks -----------------------------------------------------------------------------------------------------------------

async function apply(action, how = 'human') {
  const res = await commit(action, how);
  if (!res.ok && res.error && res.error !== 'busy') say(res.error);
  return res;
}

function legalNow() {
  const ctx = buildCtx();
  return ctx.canAct ? ctx.legal : [];
}

/** A click on a board target (hall, Crew, volunteer space, celebrity, Swag card). */
function onTarget(key) {
  const ctx = buildCtx();
  if (!ctx.canAct) {
    if (ctx.needsHandover) return;
    if (!app.busy) say(ctx.waitText, 'info');
    return;
  }
  if (ctx.generic) return;
  const pending = ctx.pending;
  let armed = pending.armed;
  let entries = ctx.targets.entries;
  let picked = pending.picked;
  const frameKind = ctx.frame ? ctx.frame.kind : null;

  if (!armed && BUTTON_FRAMES.includes(frameKind)) {
    const kind = kindOfKey(key);
    if (kind === 'swag') {
      armed = 'buySwag';
      entries = eligibleEntries(frameKind, ctx.legal, 'buySwag');
    } else if (kind === 'crew') {
      // a shortcut: clicking one of your own Crew with nothing armed starts Move 2 with it
      const c = crewById(ctx.real, valueOfKey(key));
      if (c && c.owner === ctx.toAct && ctx.legal.some((a) => a.type === 'move2' && a.crew === c.id)) {
        arm('move2');
        setPicked([key]);
        render();
        return;
      }
      if (c && c.owner === ctx.toAct) {
        return say(refusalReason(ctx.real, 'move2', frameKind, ctx.legal, [], key, fillers(ctx)));
      }
      return say('Choose an action first (the blue buttons on the right).', 'info');
    } else {
      return say('Choose an action first (the blue buttons on the right).', 'info');
    }
  }
  const out = resolveClick(entries, picked, key);
  if (out.kind === 'commit') {
    resetPending();
    void apply(out.action, 'human');
  } else if (out.kind === 'pick') {
    setPicked(out.picked);
    render();
  } else if (out.kind === 'refuse') {
    say(refusalReason(ctx.real, armed, frameKind, ctx.legal, out.picked, key, fillers(ctx)));
  } else {
    say('That is not part of this action. Cancel to choose another.', 'info');
  }
}

function fillers(ctx) {
  const mine = ctx.real.crew.find((c) => c.owner === ctx.toAct && c.hall);
  return { hall: 'main-hall', crew: mine ? mine.id : null, space: 'rope_01', celeb: null, swag: null };
}

function chooseOne(actions) {
  return actions.length === 1 ? actions[0] : null;
}

async function onAct(name, el) {
  const [verb, arg] = name.split(':');
  const ctx = buildCtx();
  switch (name) {
    case 'cancel': cancelPending(); render(); return;
    case 'undo': doUndo(); return;
    case 'log': openModal({ kind: 'log', closable: true }); render(); return;
    case 'rules': openModal({ kind: 'rules', closable: true }); render(); return;
    case 'settings': openModal({ kind: 'settings', closable: true }); render(); return;
    case 'close-modal': closeModal(); render(); return;
    case 'handover-ok': view.deviceHolder = ctx.toAct; render(); return;
    case 'score-continue': continueModal(); return;
    case 'walk-fast': app.walkFactor = app.walkFactor === 1 ? 0.5 : 1; return;
    case 'walk-skip': app.skipping = true; return;
    case 'new-game': closeModal(); toSetup(); return;
    case 'play-again': startGame({ seats: app.lastSetup.seats, variants: app.lastSetup.variants, seed: null }); return;
    case 'download-record': downloadRecord(); return;
    case 'pass-ok': {
      closeModal();
      const pass = ctx.legal.find((a) => a.type === 'pass');
      if (pass) await apply(pass, 'human');
      return;
    }
    case 'gain-ok': return gainOk(ctx);
    default: break;
  }
  if (verb === 'speed') { view.speed = arg; app.driver.kick(); render(); return; }
  if (verb === 'opt') {
    const m = view.modal;
    if (m && m.options && m.options[Number(arg)]) {
      const o = m.options[Number(arg)];
      closeModal();
      await apply(o.action, 'human');
    }
    return;
  }
  if (verb === 'gain+' || verb === 'gain-') return gainStep(verb === 'gain+' ? 1 : -1, arg, ctx);
  if (verb === 'arm') return armType(arg, ctx, el);
  if (!ctx.canAct) return;
  if (name === 'club') return clubClick(ctx, el);
  if (name === 'pass') return passClick(ctx, el);
  if (verb === 'do') {
    const a = ctx.legal.find((x) => x.type === arg);
    if (a) await apply(a, 'human');
    return;
  }
  if (verb === 'reward') {
    const a = ctx.legal.find((x) => x.type === 'passReward' && x.reward === arg);
    if (a) await apply(a, 'human');
    else say('You cannot take that reward now.');
    return;
  }
  if (verb === 'exchange') return exchangeClick(arg, ctx);
  if (verb === 'convert') return convertClick(arg, ctx);
}

function disabledReason(el) {
  return el && el.getAttribute('aria-disabled') === 'true' ? el.getAttribute('title') || 'Not available right now.' : null;
}

function armType(type, ctx, el) {
  const why = disabledReason(el);
  if (why) return say(why);
  if (!ctx.canAct) return;
  const pending = getPending();
  if (pending.armed === type) {
    cancelPending();
    return render();
  }
  const list = ctx.legal.filter((a) => a.type === type);
  if (!list.length) return say(disabledReason(el) || 'You cannot do that now.');
  // one possible target: do it at once
  if ((type === 'newNoob' || type === 'takeSelfie') && list.length === 1) {
    cancelPending();
    void apply(list[0], 'human');
    return;
  }
  arm(type);
  render();
}

async function passClick(ctx, el) {
  const why = disabledReason(el);
  if (why) return say(why);
  const pass = ctx.legal.find((a) => a.type === 'pass');
  if (!pass) return say('You cannot pass now.');
  const others = ctx.legal.filter((a) => ['move2', 'move3', 'newNoob', 'upgrade', 'volunteer', 'takeSelfie', 'buySwag', 'clubPower'].includes(a.type));
  if (others.length && ctx.real.players[ctx.toAct].coffee >= 1) {
    openModal({ kind: 'confirm-pass', closable: true });
    return render();
  }
  cancelPending();
  await apply(pass, 'human');
}

function clubClick(ctx, el) {
  const why = disabledReason(el);
  if (why) return say(why);
  const list = ctx.legal.filter((a) => a.type === 'clubPower');
  if (!list.length) return say(disabledReason(el) || 'Your Club power is not available now.');
  const one = chooseOne(list);
  if (one) {
    cancelPending();
    void apply(one, 'human');
    return;
  }
  openModal({
    kind: 'choice', closable: true, title: 'Club Power: which option?', note: '',
    options: list.map((a) => ({ action: a, html: escapeText(describeAction(ctx.real, a)), title: '' })),
  });
  render();
}

function escapeText(t) {
  return String(t).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function exchangeClick(rate, ctx) {
  const list = ctx.legal.filter((a) => a.type === 'exchange' && a.rate === rate);
  if (!list.length) {
    const el = document.querySelector(`[data-act="exchange:${rate}"]`);
    return say(disabledReason(el) || 'You cannot make that trade now.');
  }
  openModal({
    kind: 'choice', closable: true, title: rate === 'E1' ? 'Swap Selfies for coffee' : rate === 'E2' ? 'Swap Selfies for another colour' : 'Swap Selfies for VP',
    note: 'Choose which Selfies to hand over.',
    options: list.map((a) => ({
      action: a,
      html: `${selfieIcons(a.pay)} <span aria-hidden="true">&rarr;</span> ${a.rate === 'E1' ? '1 coffee' : a.rate === 'E3' ? '2 VP' : `1 ${a.gain} Selfie`}`,
      title: describeAction(ctx.real, a),
    })),
  });
  render();
}

function convertClick(type, ctx) {
  const list = ctx.legal.filter((a) => a.type === type);
  if (!list.length) {
    const el = document.querySelector(`[data-act="convert:${type}"]`);
    return say(disabledReason(el) || 'You cannot do that now.');
  }
  if (type === 'strikeAPose') {
    openModal({ kind: 'gain', type: 'strikeAPose', total: 2, title: 'Strike a Pose: choose 2 Selfies', cancelable: true, closable: true, key: `sap:${nextId()}` });
    return render();
  }
  openModal({
    kind: 'choice', closable: true, title: 'Rare Finds', note: 'Swap 2 Selfies of one colour for 3 of another.',
    options: list.map((a) => ({ action: a, html: `${selfieIcons({ green: 0, red: 0, orange: 0, [a.pay]: 2 })} <span aria-hidden="true">&rarr;</span> ${selfieIcons({ green: 0, red: 0, orange: 0, [a.gain]: 3 })}`, title: describeAction(ctx.real, a) })),
  });
  render();
}

function gainStep(delta, colour, ctx) {
  const m = view.modal && view.modal.kind === 'gain' ? view.modal : modalFor(ctx);
  if (!m || m.kind !== 'gain') return;
  if (!view.draft || view.draft.key !== m.key) view.draft = { key: m.key, counts: { green: 0, red: 0, orange: 0 } };
  const c = view.draft.counts;
  const sum = c.green + c.red + c.orange;
  if (delta > 0 && sum >= m.total) return;
  if (delta < 0 && c[colour] <= 0) return;
  c[colour] += delta;
  app.regions['sf-modal-root'] = null;
  render();
}

async function gainOk(ctx) {
  const m = view.modal && view.modal.kind === 'gain' ? view.modal : modalFor(ctx);
  if (!m || !view.draft || view.draft.key !== m.key) return;
  const c = view.draft.counts;
  const action = ctx.legal.find((a) => a.type === m.type && a.gain && a.gain.green === c.green && a.gain.red === c.red && a.gain.orange === c.orange);
  if (!action) return say('That mix of Selfies is not allowed here.');
  view.draft = null;
  if (view.modal) closeModal();
  await apply(action, 'human');
}

function downloadRecord() {
  const blob = new Blob([JSON.stringify(buildRecord(), null, 1)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `superfans-game-${app.seed}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

// ---- events -------------------------------------------------------------------------------------------------------------------

function onClick(e) {
  if (app.screen === 'setup') return;
  const t = e.target;
  if (!(t instanceof Element)) return;
  const actEl = t.closest('[data-act]');
  if (actEl && !actEl.disabled) {
    void onAct(actEl.dataset.act, actEl);
    return;
  }
  const doEl = t.closest('[data-do]');
  if (doEl) {
    const legal = legalNow();
    const a = legal[Number(doEl.dataset.do)];
    if (a) {
      if (view.modal && view.modal.kind !== 'score') closeModal();
      void apply(a, 'human');
    }
    return;
  }
  const genEl = t.closest('[data-gen]');
  if (genEl) {
    const legal = legalNow();
    const a = legal[Number(genEl.dataset.gen)];
    if (a) {
      if (!view.generic) {
        app.fallbackCount += 1;
        app.fallbackTypes.push(a.type);
      }
      cancelPending();
      void apply(a, view.generic ? 'generic' : 'human');
    }
    return;
  }
  // board targets: the innermost target that fits the current step wins
  const chain = [];
  for (let el = t.closest('[data-target]'); el; el = el.parentElement ? el.parentElement.closest('[data-target]') : null) chain.push(el.dataset.target);
  if (!chain.length) return;
  const ctx = buildCtx();
  const here = ctx.targets.active ? stepOf(ctx.targets.entries, ctx.pending.picked) : null;
  let key = chain[0];
  if (here) {
    key = chain.find((k) => here.next.has(k)) ?? chain.find((k) => here.kinds.has(kindOfKey(k))) ?? chain[0];
  }
  onTarget(key);
}

/** Hall tooltips: queue, volunteers, celebrities, and what the current action could do there. */
function onHover(e) {
  const t = e.target instanceof Element ? e.target : null;
  const hall = t ? t.closest('.sf-hall[data-tip]') : null;
  let tip = document.getElementById('sf-tip');
  if (!hall || app.screen !== 'game') {
    if (tip) tip.remove();
    return;
  }
  if (tip && tip.dataset.hall === hall.dataset.hall) return;
  if (!tip) {
    tip = document.createElement('div');
    tip.id = 'sf-tip';
    tip.className = 'sf-tip';
    tip.setAttribute('role', 'tooltip');
    document.body.appendChild(tip);
  }
  tip.dataset.hall = hall.dataset.hall;
  const [head, ...rest] = hall.dataset.tip.split('|');
  const ctx = buildCtx();
  const extra = ctx.tags.get(`hall:${hall.dataset.hall}`);
  const legalHere = hall.classList.contains('is-legal');
  tip.innerHTML = `<b>${escapeText(head)}</b>${rest.map((r) => `<div>${escapeText(r)}</div>`).join('')}${legalHere && extra ? `<div class="sf-tip__who">${escapeText(extra)}</div>` : ''}`;
  const r = hall.getBoundingClientRect();
  const right = r.right + 270 < window.innerWidth;
  tip.style.left = `${right ? r.right + 8 : Math.max(8, r.left - 268)}px`;
  tip.style.top = `${Math.max(8, Math.min(window.innerHeight - 140, r.top + 20))}px`;
  tip.style.position = 'fixed';
}

function onKey(e) {
  if (app.screen !== 'game') return;
  if (e.key === 'Escape') {
    const closed = escapeKey();
    if (closed) {
      render();
      e.preventDefault();
    }
    return;
  }
  if ((e.key === 'Enter' || e.key === ' ') && e.target instanceof Element && e.target.matches('[data-target][role="button"]')) {
    e.preventDefault();
    onTarget(e.target.dataset.target);
  }
}

// ---- boot ----------------------------------------------------------------------------------------------------------------------------

function seatsFromParam(text) {
  const colours = ['blue', 'yellow', 'pink', 'green', 'red'];
  return text.split(',').filter(Boolean).slice(0, 5).map((t, i) => {
    const kind = t === 'human' || t === 'h' ? 'human' : 'bot';
    const level = kind === 'bot' ? ({ e: 'easy', m: 'medium', d: 'hard', b: 'medium' }[t] ?? t) : null;
    const cap = level ? level.charAt(0).toUpperCase() + level.slice(1) : '';
    return { kind, level, name: kind === 'human' ? `Player ${i + 1}` : `${cap} Bot${text.split(',').filter((x) => x === t).length > 1 ? ` ${i + 1}` : ''}`, colour: colours[i] };
  });
}

async function boot() {
  app.root = document.getElementById('app');
  view.generic = params.get('generic') === '1';
  if (params.get('speed') && ['normal', 'fast', 'instant'].includes(params.get('speed'))) view.speed = params.get('speed');
  const [, bots] = await Promise.all([loadArt(), loadBots()]);
  app.botsReal = bots.real;
  installArtFallback(document);
  app.driver = createBotDriver({
    getState: () => app.state,
    shouldRun: () => app.screen === 'game' && app.state && !isGameOver(app.state) && !app.busy && !view.walk && !(view.modal && (view.modal.kind === 'score' || view.modal.kind === 'final')) && app.seats[app.state.toAct] && app.seats[app.state.toAct].kind === 'bot',
    levelFor: (seat) => app.seats[seat].level || 'medium',
    speed: () => view.speed,
    apply: (action, how) => commit(action, how),
    incident: (text) => { app.incidents.push(text); },
  });
  document.addEventListener('click', onClick);
  document.addEventListener('keydown', onKey);
  document.addEventListener('mouseover', onHover);
  window.addEventListener('resize', () => { if (app.screen === 'game') { app.regions['sf-stage'] = null; } });
  exposeTestApi();
  const seatParam = params.get('seats');
  const seedParam = params.get('seed');
  const setup = { seats: seatParam ? seatsFromParam(seatParam) : null, seed: seedParam !== null ? Number(seedParam) : null };
  app.lastSetup = setup.seats ? { seats: setup.seats, seed: setup.seed, variants: {} } : null;
  if (setup.seats && params.get('autostart') !== '0') {
    startGame(setup);
  } else {
    app.screen = 'setup';
    showSetup(app.root, { seats: setup.seats ?? undefined, levels: bots.levels ?? FALLBACK_LEVELS, seed: setup.seed, onStart: (s) => startGame({ ...s, seed: s.seed ?? setup.seed }) });
  }
}

/** window.__sf: read-only handles for the Playwright tests and the T16 hooks. */
function exposeTestApi() {
  window.__sf = {
    get state() { return app.state; },
    get screen() { return app.screen; },
    get seats() { return app.seats; },
    get busy() { return app.busy; },
    get fallbackCount() { return app.fallbackCount; },
    get fallbackTypes() { return app.fallbackTypes.slice(); },
    get incidents() { return app.incidents.slice(); },
    get actions() { return app.actions; },
    get humanActions() { return app.humanActions; },
    get driver() { return app.driver; },
    get log() { return app.log; },
    get pending() { return getPending(); },
    get legal() { return legalNow(); },
    setSpeed(s) { view.speed = s; },
    registerHooks,
    buildRecord,
  };
}

boot();
