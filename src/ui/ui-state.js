// ui-state.js - the ONE pending-action state machine, plus the view settings.
//
// Nothing here is rules logic and nothing here is stored in the DOM. The DOM
// carries only identifiers (data-target="hall:main-hall"); everything the page
// remembers between clicks is in this module.
//
// The pending action is two things (action-targets.js explains the model):
//   armed   the action type chosen from the button panel ('move2'), or null
//   picked  the target keys clicked so far (['crew:c0-2'])
// Cancel (button, Esc, clicking the armed button again) clears both. They are
// also cleared after every applied action and every undo, so a half-made
// selection can never refer to a state that no longer exists.

/** The pending action. */
const pending = { armed: null, picked: [] };

/** Everything else the page itself holds and the engine does not. */
const view = {
  /** 'setup' | 'game' | 'end' */
  screen: 'setup',
  /** Force the generic button layer only (?generic=1). */
  generic: false,
  /** 'normal' | 'fast' | 'instant' */
  speed: 'normal',
  /** The human who currently holds the device, or null before the first handover. */
  deviceHolder: null,
  /** The one message shown to the player: { text, sub, kind, id } or null. */
  notice: null,
  /** Open modal: { kind, ... } or null (kinds: pass-confirm, achievement, choice, gain, log, settings, rules, score, handover). */
  modal: null,
  /** The side-panel log is open (tablet and phone). */
  logOpen: false,
  /** Seats whose dials should wobble (Coffee Break), seats with a gain animation, hall flashes ... */
  flash: emptyFlash(),
  /** Display state override while an animation is being played (see walk.js); null = the real state. */
  display: null,
  /** Walk playback: { route, doneTo, colour, banner } or null. */
  walk: null,
  /** Sticky 'busy' reason while an animation holds the board (clicks ignored). */
  busy: null,
  /** Floating gain chips over the board: [{ id, html, x, y, ms }]. */
  floats: [],
  /** The hall hovered (for the tooltip), key or null. */
  hover: null,
};

let counter = 0;

function emptyFlash() {
  return { pour: [], gain: [], halls: [], crew: [], seq: -1 };
}

export function getView() {
  return view;
}

export function getPending() {
  return pending;
}

export function arm(type) {
  pending.armed = type;
  pending.picked = [];
}

export function setPicked(picked) {
  pending.picked = picked.slice();
}

/** Whether Cancel has anything to clear. */
export function hasPending() {
  return pending.armed !== null || pending.picked.length > 0;
}

/** Clears the half-made action. Returns whether anything was cleared. */
export function cancelPending() {
  const had = hasPending();
  pending.armed = null;
  pending.picked = [];
  return had;
}

/** After an applied action or an undo: everything half-made is gone. */
export function resetPending() {
  cancelPending();
  view.notice = null;
}

export function setNotice(text, kind = 'refuse', sub = '') {
  counter += 1;
  view.notice = text ? { text, sub, kind, id: counter } : null;
  return view.notice;
}

export function clearNotice() {
  view.notice = null;
}

export function openModal(modal) {
  counter += 1;
  view.modal = { ...modal, id: counter };
  return view.modal;
}

export function closeModal() {
  view.modal = null;
}

export function setFlash(flash) {
  view.flash = { ...emptyFlash(), ...flash };
}

export function clearFlash() {
  view.flash = emptyFlash();
}

export function nextId() {
  counter += 1;
  return counter;
}

/** Esc closes the most recent thing, in order: the half-made action, a closable modal, the log, the message. */
export function escape() {
  if (cancelPending()) return 'selection';
  if (view.modal && view.modal.closable) {
    view.modal = null;
    return 'modal';
  }
  if (view.logOpen) {
    view.logOpen = false;
    return 'log';
  }
  if (view.notice) {
    view.notice = null;
    return 'notice';
  }
  return null;
}

/** A fresh start for a new game: keeps speed and the generic flag. */
export function resetForNewGame() {
  resetPending();
  view.deviceHolder = null;
  view.modal = null;
  view.display = null;
  view.walk = null;
  view.busy = null;
  view.floats = [];
  view.logOpen = false;
  clearFlash();
}

export const SPEEDS = ['normal', 'fast', 'instant'];
