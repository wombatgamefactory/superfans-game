// board.js - the fixed geometry of the board (spec R3): halls, adjacency,
// ropes, volunteer spaces, lines, plus the fixed vocabularies (colours,
// badges). Nothing here depends on a game state.
//
// HALL IDS. The engine's key for a hall is its CODE id (R3.2.2:
// `artist-alley` .. `food-trucks`). The grid id (`h11` .. `h33`, R3.1) is kept
// on each hall for the spec's tables and for the one rule that sorts by it
// (R10.5's path tie-break). Display names are R3.2's (Main Hall in the centre,
// Q7). Card routes in data/cards.js are code ids.

import { HALL_ART } from './data/cards.js';

function deepFreeze(v) {
  if (v !== null && typeof v === 'object' && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const k of Object.keys(v)) deepFreeze(v[k]);
  }
  return v;
}

/** R3.2, R3.2.2, R3.3.1. In reading order (row 1 left to right, ...). */
export const HALLS = deepFreeze([
  { id: 'artist-alley', grid: 'h11', row: 1, col: 1, name: 'Artist Alley', boardLabel: "Artist's Alley", kind: 'corner' },
  { id: 'main-stage', grid: 'h12', row: 1, col: 2, name: 'Main Stage', boardLabel: 'Main Stage', kind: 'edge' },
  { id: 'cosplay-arena', grid: 'h13', row: 1, col: 3, name: 'Cosplay Arena', boardLabel: 'Cosplay Corner', kind: 'corner' },
  { id: 'autograph-hall', grid: 'h21', row: 2, col: 1, name: 'Autograph Hall', boardLabel: 'Autographs', kind: 'edge' },
  { id: 'main-hall', grid: 'h22', row: 2, col: 2, name: 'Main Hall', boardLabel: 'Main Hall', kind: 'centre' },
  { id: 'vendor-hall', grid: 'h23', row: 2, col: 3, name: 'Vendor Hall', boardLabel: 'Vendor Hall', kind: 'edge' },
  { id: 'photo-ops', grid: 'h31', row: 3, col: 1, name: 'Photo Ops', boardLabel: 'Photo Ops', kind: 'corner' },
  { id: 'entrance', grid: 'h32', row: 3, col: 2, name: 'Entrance', boardLabel: 'Ticket Hall', kind: 'edge' },
  { id: 'food-trucks', grid: 'h33', row: 3, col: 3, name: 'Food Trucks', boardLabel: 'Food Trucks', kind: 'corner' },
].map((h) => ({ ...h, art: HALL_ART[h.id] ?? null })));

/** Hall code ids in reading order. */
export const HALL_IDS = Object.freeze(HALLS.map((h) => h.id));

/** R3.2.1 - new Crew arrive here. */
export const ENTRANCE = 'entrance';

const HALL_INDEX = new Map(HALLS.map((h) => [h.id, h]));
const GRID_INDEX = new Map(HALLS.map((h) => [h.grid, h]));

/** The hall record for a code id, or null. */
export function hallById(id) {
  return HALL_INDEX.get(id) ?? null;
}

/** The hall record for a grid id (`h22`), or null. */
export function hallByGrid(grid) {
  return GRID_INDEX.get(grid) ?? null;
}

/** Whether `id` is a hall code id. */
export function isHallId(id) {
  return HALL_INDEX.has(id);
}

/** The display name of a hall ("Main Hall"). */
export function hallName(id) {
  const h = HALL_INDEX.get(id);
  return h ? h.name : String(id);
}

/** R3.4 - the twelve ropes, joining grid pairs exactly as the spec's table. */
const ROPE_TABLE = [
  ['rope_01', 'h11', 'h12'],
  ['rope_02', 'h11', 'h21'],
  ['rope_03', 'h12', 'h13'],
  ['rope_04', 'h12', 'h22'],
  ['rope_05', 'h13', 'h23'],
  ['rope_06', 'h21', 'h22'],
  ['rope_07', 'h21', 'h31'],
  ['rope_08', 'h22', 'h23'],
  ['rope_09', 'h22', 'h32'],
  ['rope_10', 'h23', 'h33'],
  ['rope_11', 'h31', 'h32'],
  ['rope_12', 'h32', 'h33'],
];

export const ROPES = deepFreeze(
  ROPE_TABLE.map(([id, a, b]) => ({ id, halls: [GRID_INDEX.get(a).id, GRID_INDEX.get(b).id] })),
);

export const ROPE_IDS = Object.freeze(ROPES.map((r) => r.id));

const ROPE_BY_PAIR = new Map();
for (const r of ROPES) {
  ROPE_BY_PAIR.set(`${r.halls[0]}|${r.halls[1]}`, r.id);
  ROPE_BY_PAIR.set(`${r.halls[1]}|${r.halls[0]}`, r.id);
}

/** The rope between two adjacent halls, or null when they are not adjacent. */
export function ropeBetween(a, b) {
  return ROPE_BY_PAIR.get(`${a}|${b}`) ?? null;
}

/** R3.3 - adjacent halls (orthogonal), in the spec's grid order. */
export const ADJACENT = deepFreeze(
  Object.fromEntries(
    HALLS.map((h) => {
      const next = ROPES.filter((r) => r.halls.includes(h.id))
        .map((r) => (r.halls[0] === h.id ? r.halls[1] : r.halls[0]))
        .sort((x, y) => HALL_INDEX.get(x).grid.localeCompare(HALL_INDEX.get(y).grid));
      return [h.id, next];
    }),
  ),
);

/** Whether two halls share a side (R1.16). */
export function areAdjacent(a, b) {
  return ROPE_BY_PAIR.has(`${a}|${b}`);
}

/** Ropes touching a hall (R3.4.1). */
export const ROPES_OF_HALL = deepFreeze(
  Object.fromEntries(HALLS.map((h) => [h.id, ROPES.filter((r) => r.halls.includes(h.id)).map((r) => r.id)])),
);

/** Steps between two halls on the grid (Manhattan distance). */
export function hallDistance(a, b) {
  const x = HALL_INDEX.get(a);
  const y = HALL_INDEX.get(b);
  return Math.abs(x.row - y.row) + Math.abs(x.col - y.col);
}

/**
 * R3.5 - the 30 volunteer spaces. Rope spaces carry the rope id as their
 * space id; hall spaces are `security-<hall>` and `photographer-<hall>`.
 */
export const VOLUNTEER_SPACES = deepFreeze([
  ...ROPES.map((r) => ({ id: r.id, role: 'usher', rope: r.id, hall: null, halls: r.halls.slice() })),
  ...HALLS.map((h) => ({ id: `security-${h.id}`, role: 'security', rope: null, hall: h.id, halls: [h.id] })),
  ...HALLS.map((h) => ({ id: `photographer-${h.id}`, role: 'photographer', rope: null, hall: h.id, halls: [h.id] })),
]);

export const VOLUNTEER_SPACE_IDS = Object.freeze(VOLUNTEER_SPACES.map((s) => s.id));

const SPACE_INDEX = new Map(VOLUNTEER_SPACES.map((s) => [s.id, s]));

/** The volunteer space record, or null. */
export function spaceById(id) {
  return SPACE_INDEX.get(id) ?? null;
}

/** The Security space id of a hall. */
export function securitySpace(hall) {
  return `security-${hall}`;
}

/** The Photographer space id of a hall. */
export function photographerSpace(hall) {
  return `photographer-${hall}`;
}

/** Volunteer roles (R1.10). */
export const VOLUNTEER_ROLES = Object.freeze(['usher', 'security', 'photographer']);

/** R3.3.1 - rows, columns, diagonals as hall code ids. */
export const LINES = deepFreeze({
  rows: [1, 2, 3].map((r) => HALLS.filter((h) => h.row === r).map((h) => h.id)),
  columns: [1, 2, 3].map((c) => HALLS.filter((h) => h.col === c).map((h) => h.id)),
  diagonals: [
    ['artist-alley', 'main-hall', 'food-trucks'],
    ['cosplay-arena', 'main-hall', 'photo-ops'],
  ],
});

/** R3.3.1 hall kinds. */
export const CORNER_HALLS = Object.freeze(HALLS.filter((h) => h.kind === 'corner').map((h) => h.id));
export const EDGE_HALLS = Object.freeze(HALLS.filter((h) => h.kind === 'edge').map((h) => h.id));
export const CENTRE_HALL = 'main-hall';

/** R1.4 - selfie and celebrity colours, in the engine's canonical order. */
export const COLOURS = Object.freeze(['green', 'red', 'orange']);

/** R1.4 - the symbol printed for each colour (for colour-blind cues). */
export const COLOUR_SYMBOL = Object.freeze({ green: 'thumbs-up', red: 'heart', orange: 'star' });

/** Display names of the colours. */
export const COLOUR_NAME = Object.freeze({ green: 'green', red: 'red', orange: 'orange' });

/** R1.8 - badges, lowest first. */
export const BADGES = Object.freeze(['N00b', 'VIP', 'AAA']);

/** R1.8 / R9.1 key 1 - higher is further forward. */
export const BADGE_RANK = Object.freeze({ N00b: 0, VIP: 1, AAA: 2 });

/** Default player colours (ui-design-v1 section 8.7), used when the config gives none. */
export const DEFAULT_PLAYER_COLOURS = Object.freeze(['blue', 'yellow', 'pink', 'green', 'red']);
