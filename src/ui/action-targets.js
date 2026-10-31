// action-targets.js - the ONE module that maps clicks on the board to legal actions.
//
// Every click on a hall, a Crew, a volunteer space, a celebrity figure or a
// market card is a TARGET with a key such as "hall:main-hall" or
// "crew:c0-3". An engine action that needs board clicks lists, in order, the
// target keys that make it up (SLOT_DEFS): Move 2 is crew then hall; Excuse Me
// is crew then crew. The player's half-made action is just the list of keys
// picked so far ("picked") plus the action type armed from the button panel
// ("armed"). Nothing here knows a rule: it only filters the list the engine
// gave (getValidActions), so a lit target is legal by construction.
//
// Anything with no slots (Pass, conversions, club options, "Done", gaining
// Selfies of chosen colours, choosing an Achievement) is not a board click and
// lives in the panels and modals; if one of those were ever left without a
// widget it would fall through to the generic button list (see panels.js).

import { getBlockReason, ordinal } from '../engine/index.js';

/** [param, kind] per action type: the board clicks that build it, in order. */
export const SLOT_DEFS = Object.freeze({
  move2: [['crew', 'crew'], ['to', 'hall']],
  move3: [['crew', 'crew'], ['to', 'hall']],
  moveStep: [['crew', 'crew'], ['to', 'hall']],
  effectMove: [['crew', 'crew'], ['to', 'hall']],
  effectMovePair: [['crew', 'crew'], ['other', 'crew'], ['to', 'hall']],
  effectSwap: [['crew', 'crew'], ['other', 'crew']],
  newNoob: [['hall', 'hall']],
  placeOpeningCrew: [['hall', 'hall']],
  effectPlaceCrew: [['hall', 'hall']],
  effectChooseHall: [['hall', 'hall']],
  upgrade: [['crew', 'crew']],
  effectChooseCrew: [['crew', 'crew']],
  volunteer: [['space', 'space']],
  effectPlaceVolunteer: [['space', 'space']],
  effectMoveVolunteer: [['from', 'space'], ['to', 'space']],
  takeSelfie: [['celebrity', 'celeb']],
  effectChooseCelebrity: [['celebrity', 'celeb']],
  buySwag: [['card', 'swag']],
});

/** The engine accepts either order of these two; the list gives one. */
const UNORDERED_FIRST_TWO = new Set(['effectSwap', 'effectMovePair']);

/** The main actions that arm from the button panel (a board-click action in a normal turn). */
export const ARMABLE = Object.freeze(['move2', 'move3', 'newNoob', 'upgrade', 'volunteer', 'takeSelfie', 'buySwag']);

/** Frame kinds in which several action types may be offered at once and the buttons arm one of them. */
export const BUTTON_FRAMES = Object.freeze(['turn']);

export function keyOf(kind, value) {
  return `${kind}:${value}`;
}

export function kindOfKey(key) {
  return key.slice(0, key.indexOf(':'));
}

export function valueOfKey(key) {
  return key.slice(key.indexOf(':') + 1);
}

/** The ordered target keys of an action, or null when it is not built from board clicks. */
export function slotKeys(action) {
  const defs = SLOT_DEFS[action.type];
  if (!defs) return null;
  return defs.map(([param, kind]) => keyOf(kind, action[param]));
}

/** Entries { action, keys } for every way of building each action from clicks (both orders where the engine allows). */
function entriesOf(actions) {
  const out = [];
  for (const action of actions) {
    const keys = slotKeys(action);
    if (!keys) continue;
    out.push({ action, keys });
    if (UNORDERED_FIRST_TWO.has(action.type) && keys[0] !== keys[1]) {
      out.push({ action, keys: [keys[1], keys[0], ...keys.slice(2)] });
    }
  }
  return out;
}

/**
 * The entries a click can build right now.
 * - armed type: only actions of that type;
 * - a frame that is not a normal turn (card effect, move steps, opening placement ...): every board-click action offered;
 * - a normal turn with nothing armed: only the Swag cards (clicking a market card buys it, ui-design 5.2).
 */
export function eligibleEntries(frameKind, legal, armed) {
  if (armed) return entriesOf(legal.filter((a) => a.type === armed));
  if (BUTTON_FRAMES.includes(frameKind)) return entriesOf(legal.filter((a) => a.type === 'buySwag'));
  return entriesOf(legal);
}

/**
 * Where the half-made action stands.
 * @returns {{ next: Map<string, object[]>, kinds: Set<string>, complete: object[], step: number, total: number }}
 */
export function stepOf(entries, picked) {
  const live = entries.filter((e) => picked.every((k, i) => e.keys[i] === k));
  const next = new Map();
  const kinds = new Set();
  let total = 0;
  for (const e of live) {
    if (e.keys.length > picked.length) {
      const key = e.keys[picked.length];
      if (!next.has(key)) next.set(key, []);
      next.get(key).push(e);
      kinds.add(kindOfKey(key));
    }
    total = Math.max(total, e.keys.length);
  }
  return { next, kinds, complete: live.filter((e) => e.keys.length === picked.length), step: picked.length + 1, total, live };
}

/**
 * What a click on `key` does.
 * @returns {{ kind: 'commit', action: object } | { kind: 'pick', picked: string[] } | { kind: 'refuse', key: string, picked: string[] } | { kind: 'ignore' }}
 */
export function resolveClick(entries, picked, key) {
  const here = stepOf(entries, picked);
  if (here.next.has(key)) {
    const after = [...picked, key];
    const done = stepOf(entries, after);
    const finished = done.complete.filter((e) => e.keys.length === after.length);
    if (finished.length > 0 && done.next.size === 0) return { kind: 'commit', action: finished[0].action };
    if (finished.length > 0) return { kind: 'commit', action: finished[0].action };
    return { kind: 'pick', picked: after };
  }
  if (here.kinds.has(kindOfKey(key))) return { kind: 'refuse', key, picked };
  return { kind: 'ignore' };
}

/**
 * Classes a rendered target should wear: '' (nothing is happening), 'is-legal',
 * 'is-illegal' (right kind, not allowed: stays clickable and explains),
 * 'is-dimmed' (not part of this step), 'is-selected' (already picked).
 */
export function targetClass(entries, picked, key, active) {
  if (!active) return '';
  if (picked.includes(key)) return 'is-selected';
  const here = stepOf(entries, picked);
  if (here.next.has(key)) return 'is-legal';
  if (here.kinds.has(kindOfKey(key))) return 'is-illegal';
  return 'is-dimmed';
}

// ---- refusals: why can't I? ---------------------------------------------------------

/** Param order and the filler used when a refusal is asked for before every slot is picked. */
function paramValues(type, keys) {
  const defs = SLOT_DEFS[type];
  const action = { type };
  defs.forEach(([param], i) => {
    if (keys[i] !== undefined) action[param] = valueOfKey(keys[i]);
  });
  return action;
}

/**
 * The engine's own reason for refusing a click: builds the action the click
 * would have made (filling the slots not yet picked with a stand-in) and asks
 * getBlockReason. Returns a sentence, always.
 */
export function refusalReason(state, armedType, frameKind, legal, picked, key, fillers) {
  const type = armedType ?? inferType(legal, picked, key, frameKind);
  const keys = [...picked, key];
  if (!type || !SLOT_DEFS[type]) return 'That is not part of this action. Cancel to choose another.';
  const action = paramValues(type, keys);
  const defs = SLOT_DEFS[type];
  for (let i = keys.length; i < defs.length; i++) {
    const [param, kind] = defs[i];
    action[param] = fillers?.[kind] ?? null;
  }
  // a Crew clicked before its hall: ask with any other hall so the Crew's own problem surfaces first
  if (action.to === null || action.to === undefined) action.to = (fillers?.hall ?? 'main-hall') === action.crew ? 'entrance' : fillers?.hall ?? 'main-hall';
  if (action.other === null) action.other = fillers?.crew ?? null;
  try {
    const reason = getBlockReason(state, action);
    if (reason) return reason;
  } catch {
    // fall through
  }
  return 'That is not allowed right now.';
}

function inferType(legal, picked, key, frameKind) {
  // the first type offered whose slot kind matches the clicked key
  const kind = kindOfKey(key);
  for (const a of legal) {
    const defs = SLOT_DEFS[a.type];
    if (defs && defs[picked.length] && defs[picked.length][1] === kind) return a.type;
  }
  return null;
}

// ---- small helpers for the renderer --------------------------------------------------------

/** Tag text under a legal hall, from a preview ("2nd in the queue"). */
export function queueTag(position) {
  return position ? `${ordinal(position)}` : '';
}
