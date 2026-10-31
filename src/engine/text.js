// text.js - small helpers for the sentences the engine writes to players
// (block reasons and labels). British English, real numbers.
//
// Shared by legality.js and cardeffects.js. Reads the state, never changes it.
// R4.2.1, R24: every printed "MOJO" is coffee, "Selfy" Selfie, "Noob" N00b: the engine never writes the old words.

import { hallName, hallDistance, spaceById } from './board.js';
import { capacity, hallCount, isFull, ordinal, queuePosition } from './queries.js';

/** A player's name. */
export function nameOf(state, seat) {
  return state.players[seat].name;
}

/** "1 hall", "2 halls". */
export function plural(n, one, many) {
  return `${n} ${n === 1 ? one : many}`;
}

/** "your VIP in Main Hall (2nd)" / "Ann's N00b in supply". */
export function crewLabel(state, crew, viewer) {
  const whose = viewer === crew.owner ? 'your' : `${nameOf(state, crew.owner)}'s`;
  if (crew.hall === null) return `${whose} ${crew.badge} in supply`;
  return `${whose} ${crew.badge} in ${hallName(crew.hall)} (${ordinal(queuePosition(state, crew.id))})`;
}

/** "Main Hall is full (7 of 7)" (R3.6.1; no full stop). */
export function fullText(state, hall) {
  return `${hallName(hall)} is full (${hallCount(state, hall)} of ${capacity(state)})`;
}

/** R10.2 - why no path reaches `to` within `max` steps. */
export function noPathReason(state, crew, to, max, label) {
  const d = hallDistance(crew.hall, to);
  if (d > max) return `${hallName(to)} is ${d} halls from ${hallName(crew.hall)}; ${label} reaches at most ${plural(max, 'hall', 'halls')}.`;
  if (isFull(state, to)) return `${fullText(state, to)}.`;
  return `Every way from ${hallName(crew.hall)} to ${hallName(to)} within ${plural(max, 'hall', 'halls')} passes through a full hall (capacity ${capacity(state)}).`;
}

/** Whether `v` is a `{ green, red, orange }` object of non-negative integers (with this total, when given). */
export function isSelfieObject(v, total) {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  const keys = Object.keys(v);
  if (keys.length !== 3 || !['green', 'red', 'orange'].every((c) => Number.isInteger(v[c]) && v[c] >= 0)) return false;
  return total === undefined || v.green + v.red + v.orange === total;
}

/** Every `{ green, red, orange }` with this total, in a fixed order (green-heavy first). */
export function compositions(total) {
  const out = [];
  for (let g = total; g >= 0; g--) {
    for (let r = total - g; r >= 0; r--) out.push({ green: g, red: r, orange: total - g - r });
  }
  return out;
}

/** "the rope between Main Stage and Main Hall", "the Security space in Photo Ops" (R3.4, R3.5). */
export function spaceLabel(id) {
  const sp = spaceById(id);
  if (!sp) return String(id);
  if (sp.role === 'usher') return `the rope between ${hallName(sp.halls[0])} and ${hallName(sp.halls[1])}`;
  return `the ${sp.role === 'security' ? 'Security' : 'Photographer'} space in ${hallName(sp.hall)}`;
}
