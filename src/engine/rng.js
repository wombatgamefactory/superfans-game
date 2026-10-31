// rng.js - the seeded random number generator.
//
// An RNG is a plain JSON object `{ s: <int32> }`. Every function here takes
// that object and advances it in place. Nothing in src/engine or src/bots may
// use any other source of randomness (spec R23.4).
//
// Two streams, never mixed:
//   - the GAME stream lives at `state.rng` and is the only stream the engine
//     reads; a game is a pure function of (config, seed, action list);
//   - each BOT gets its own stream, made by the driver with `makeRng(botSeed)`
//     or `forkRng`, so a bot's choices never change the game's shuffles.
//
// The generator is mulberry32: 32 bits of state, one multiply-xorshift round
// per number. Small, fast and good enough for shuffling decks.

/** Turns any seed (integer, float or string) into a well-mixed int32. */
export function hashSeed(seed) {
  let h = 0x9e3779b9 | 0;
  const text = typeof seed === 'string' ? seed : `#${Number(seed)}`;
  for (let i = 0; i < text.length; i++) {
    h = Math.imul(h ^ text.charCodeAt(i), 0x85ebca6b);
    h = (h << 13) | (h >>> 19);
  }
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) | 0;
}

/**
 * Makes a new RNG from a seed. The same seed always gives the same stream.
 * @param {number|string} seed
 * @returns {{ s: number }} plain JSON, safe to store in the game state
 */
export function makeRng(seed) {
  if (seed === null || seed === undefined || (typeof seed === 'number' && !Number.isFinite(seed))) {
    throw new Error('makeRng needs a seed: a finite number or a string.');
  }
  return { s: hashSeed(seed) };
}

/** A copy of an RNG that then advances independently. */
export function cloneRng(rng) {
  return { s: rng.s };
}

/** Next float in [0, 1). Advances the RNG. */
export function rngNext(rng) {
  let t = (rng.s = (rng.s + 0x6d2b79f5) | 0);
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

/** Next integer in [0, n). Advances the RNG. */
export function rngInt(rng, n) {
  return Math.floor(rngNext(rng) * n);
}

/** A uniformly chosen element of a non-empty array. Advances the RNG. */
export function rngPick(rng, array) {
  return array[rngInt(rng, array.length)];
}

/** Fisher-Yates shuffle IN PLACE. Returns the same array. Advances the RNG. */
export function shuffle(rng, array) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = rngInt(rng, i + 1);
    const tmp = array[i];
    array[i] = array[j];
    array[j] = tmp;
  }
  return array;
}

/**
 * Splits off a new, independent RNG. Advances the parent by one number.
 * Used for the setup sub-streams, each bot seat, and each determinisation.
 */
export function forkRng(rng) {
  return { s: hashSeed(`fork:${(rngNext(rng) * 4294967296) >>> 0}`) };
}
