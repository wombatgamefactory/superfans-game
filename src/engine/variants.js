// variants.js - the 12 rule variants of spec R26, exactly by name.
//
// This table is the ONE list of variants. The setup screen builds its "Rules
// variants" panel from it and the simulator builds its `--variant.<name>=`
// flags from it, so a variant added here appears in both with no other change.
//
// A game stores its resolved variants at `state.variants` (frozen at
// createGame). Logic reads `state.variants.<name>`, never this table.
//
// A value that is legal here but whose rules are not written yet is listed in
// UNIMPLEMENTED_VARIANT_VALUES; createGame refuses it loudly instead of
// silently playing the default.

/**
 * @typedef {object} VariantDef
 * @property {string} name        exact name from spec R26.1
 * @property {string} label       UI label from R26.1
 * @property {'enum'} type
 * @property {string[]} values    allowed values, default first
 * @property {string} default
 * @property {string} description one line for the setup screen (R26.2)
 * @property {string} rule        spec rule numbers
 * @property {string} ruling      the ruling question
 */

/** @type {VariantDef[]} R26.1, in display order. */
export const VARIANTS = [
  {
    name: 'queueCapacity',
    label: 'Hall queue size',
    type: 'enum',
    values: ['printed-board', 'rulebook'],
    default: 'printed-board',
    description: 'Crew per hall by players 2/3/4/5: 4/6/7/7 as printed on the board, or 5/7/8/8 as Rule book v1',
    rule: 'R3.6, R5.9.1, R21.3',
    ruling: 'Q2',
  },
  {
    name: 'celebrityColours',
    label: 'Celebrity colours',
    type: 'enum',
    values: ['random-slots', 'fixed-slots'],
    default: 'random-slots',
    description: 'Green, red and orange dealt at random to Hours 1-3 (then repeated), or always green, red, orange',
    rule: 'R4.3',
    ruling: 'Q1',
  },
  {
    name: 'coffeeCap',
    label: 'Coffee cap',
    type: 'enum',
    values: ['every-gain', 'coffee-break-only'],
    default: 'every-gain',
    description: 'Coffee never exceeds 12, or only the Coffee Break stops at 12',
    rule: 'R7.3',
    ruling: 'Q3',
  },
  {
    name: 'fivePlayerOpening',
    label: 'Crowded opening',
    type: 'enum',
    values: ['overfill', 'fallback'],
    default: 'overfill',
    description: 'At 4-5 players all opening Crew enter the Entrance, or the overflow is placed like a New N00b',
    rule: 'R5.9.1',
    ruling: 'Q6',
  },
  {
    name: 'usherInHall',
    label: 'Ushers count in halls',
    type: 'enum',
    values: ['both-halls', 'neither'],
    default: 'both-halls',
    description: 'For hall-based cards an Usher is in both halls its rope touches, or in neither',
    rule: 'R13.7.1',
    ruling: 'Q8',
  },
  {
    name: 'homeBase',
    label: 'Home Base card',
    type: 'enum',
    values: ['three-crew', 'as-printed'],
    default: 'three-crew',
    description: 'Home Base scores halls with 3+ of your Crew and a Volunteer, or its printed text (same as Obsessed)',
    rule: 'scoring_31 (R19.10)',
    ruling: 'Q9',
  },
  {
    name: 'achiever',
    label: 'Achiever Swag card',
    type: 'enum',
    values: ['hand-size', 'draw-two-keep-one'],
    default: 'hand-size',
    description: 'Achiever raises your Achievement hand size by 1, or draws 2 and keeps 1',
    rule: 'swag_orange_07 (R16.8), R19.1, R22.3',
    ruling: 'Q10',
  },
  {
    name: 'clubHandLimits',
    label: 'Club selfie hand limits',
    type: 'enum',
    values: ['off', 'on'],
    default: 'off',
    description: 'Ignore the printed selfie limits on Meeple Militia and TCG Traders, or apply them',
    rule: 'R17.7, R17.6.6, R17.6.7',
    ruling: 'Q11',
  },
  {
    name: 'finalBoard',
    label: 'Hour 5 figures at the end',
    type: 'enum',
    values: ['figures-stay', 'figures-removed'],
    default: 'figures-stay',
    description: 'The Hour 5 figures and markers stay for final scoring, or are cleared first',
    rule: 'R20.6, R22.3',
    ruling: 'Q12',
  },
  {
    name: 'militiaRoll',
    label: 'Meeple Militia roll',
    type: 'enum',
    values: ['coin', 'fixed'],
    default: 'coin',
    description: 'Each of the 6 tokens is kept on a coin flip, or always 3 kept and 3 VP',
    rule: 'R17.6.6',
    ruling: 'Q15',
  },
  {
    name: 'clubs',
    label: 'Club cards',
    type: 'enum',
    values: ['random', 'off'],
    default: 'random',
    description: 'One Club card dealt to each player, or no Clubs (testing)',
    rule: 'R5.3, R17',
    ruling: 'Q31',
  },
  {
    name: 'firstPlayer',
    label: 'First player',
    type: 'enum',
    values: ['random', 'seat-0'],
    default: 'random',
    description: 'First player chosen at random, or seat 0 (testing)',
    rule: 'R5.9',
    ruling: 'Q31',
  },
];

/**
 * Legal values whose rules are not written yet (task T9 writes them).
 * createGame throws on any of these. T9 empties this table.
 */
export const UNIMPLEMENTED_VARIANT_VALUES = Object.freeze({
  fivePlayerOpening: ['fallback'], // needs the opening-placement decision (contract "placeOpeningCrew")
  achiever: ['draw-two-keep-one'], // needs Swag (buySwag) first
  clubHandLimits: ['on'], // needs the discard-to-limit decision
  militiaRoll: ['fixed'], // needs Club powers first
});

const BY_NAME = new Map(VARIANTS.map((v) => [v.name, v]));

/** The names, in spec order. */
export const VARIANT_NAMES = Object.freeze(VARIANTS.map((v) => v.name));

/** The definition of one variant, or null if there is no variant of that name. */
export function getVariantDef(name) {
  return BY_NAME.get(name) ?? null;
}

/** All defaults as a fresh plain object. */
export function defaultVariants() {
  const out = {};
  for (const v of VARIANTS) out[v.name] = v.default;
  return out;
}

function unknownVariantMessage(name) {
  return `Unknown variant "${name}". The variants are: ${VARIANT_NAMES.join(', ')}.`;
}

/**
 * Turns text (a command-line flag or URL value) into a variant value. Every
 * Superfans variant is an enum of strings, so this only checks the name.
 */
export function parseVariantValue(name, text) {
  if (!BY_NAME.has(name)) throw new Error(unknownVariantMessage(name));
  return text;
}

/**
 * Checks a set of overrides and returns the complete variants object: every
 * variant present, defaults filled in. Rejects an unknown name or a value
 * outside the variant's allowed values, naming the problem. Does NOT reject
 * unimplemented values (createGame does, so the table stays usable by the UI).
 *
 * @param {object} [overrides] `{ variantName: value }`
 * @returns {object} a fresh plain object with all 12 variants
 */
export function resolveVariants(overrides = {}) {
  if (overrides === null || typeof overrides !== 'object' || Array.isArray(overrides)) {
    throw new Error('Variants must be given as an object of { name: value }.');
  }
  const out = defaultVariants();
  for (const name of Object.keys(overrides)) {
    const def = BY_NAME.get(name);
    if (!def) throw new Error(unknownVariantMessage(name));
    const value = overrides[name];
    if (!def.values.includes(value)) {
      throw new Error(
        `Illegal value ${JSON.stringify(value)} for variant "${name}". Allowed: ${def.values.map((v) => `"${v}"`).join(', ')}.`,
      );
    }
    out[name] = value;
  }
  return out;
}

/** Whether a value is implemented in this build (false for UNIMPLEMENTED_VARIANT_VALUES). */
export function isVariantValueImplemented(name, value) {
  const list = UNIMPLEMENTED_VARIANT_VALUES[name];
  return !(list && list.includes(value));
}

/** The variants whose value differs from the default, as `{ name: value }`. For banners, records, the analytics hash. */
export function nonDefaultVariants(variants) {
  const out = {};
  for (const v of VARIANTS) {
    if (variants[v.name] !== v.default) out[v.name] = variants[v.name];
  }
  return out;
}
