// bots.mjs - finds the bot levels the simulator can play.
//
// Interface (src/bots/index.js, written by the bot task):
//   BOT_LEVELS                      the level names
//   chooseAction(state, level, rng, opts = { jitter })   a synchronous action from getValidActions(state)
//   isAsyncLevel(level)             true for levels that need a Promise (search bots); not playable here
//
// The level `random` is ALWAYS available (src/bots/randomBot.js), whatever state index.js is in,
// so the harness and its test never depend on another task being finished.

import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { chooseRandomAction } from '../src/bots/randomBot.js';

const here = dirname(fileURLToPath(import.meta.url));
const INDEX = join(here, '..', 'src', 'bots', 'index.js');

let cached = null;

/**
 * Loads the bot table once per process.
 * @returns {Promise<{ levels: string[], hasIndex: boolean, warning: string|null,
 *   choose: (state, level, rng, opts) => object, isAsync: (level) => boolean }>}
 */
export async function loadBots() {
  if (cached) return cached;
  let mod = null;
  let warning = null;
  if (existsSync(INDEX)) {
    try {
      mod = await import(pathToFileURL(INDEX).href);
    } catch (err) {
      warning = `src/bots/index.js exists but did not load (${String(err && err.message ? err.message : err).split('\n')[0]}); only the random level is available.`;
    }
  }
  const real = mod && typeof mod.chooseAction === 'function';
  if (mod && !real) warning = 'src/bots/index.js does not export chooseAction; only the random level is available.';
  const names = real && Array.isArray(mod.BOT_LEVELS) ? mod.BOT_LEVELS.map((l) => (typeof l === 'string' ? l : l.id ?? l.level ?? l.name)) : [];
  const levels = ['random', ...names.filter((n) => n && n !== 'random')];
  const isAsync = (level) => level !== 'random' && real && typeof mod.isAsyncLevel === 'function' && mod.isAsyncLevel(level) === true;
  cached = {
    levels,
    hasIndex: Boolean(real),
    warning,
    isAsync,
    choose(state, level, rng, opts) {
      if (level === 'random') return chooseRandomAction(state, rng);
      return mod.chooseAction(state, level, rng, opts);
    },
  };
  return cached;
}

/**
 * Turns --bots into the list of levels for a run, or throws a helpful error.
 * @param {string[]|null} requested the --bots list, or null for the default
 * @param {number} players
 */
export async function resolveLevels(requested, players) {
  const bots = await loadBots();
  let list = requested;
  if (list === null) list = [bots.levels.includes('medium') ? 'medium' : 'random'];
  if (list.length > players) throw new Error(`--bots lists ${list.length} levels but there are only ${players} players.`);
  for (const level of list) {
    if (!bots.levels.includes(level)) {
      throw new Error(`Unknown bot level "${level}". Available now: ${bots.levels.join(', ')}.${bots.warning ? ' ' + bots.warning : ''}`);
    }
    if (bots.isAsync(level)) {
      throw new Error(`Bot level "${level}" is asynchronous (a search bot) and cannot be played by this synchronous simulator.`);
    }
  }
  const out = list.slice();
  while (out.length < players) out.push(list[list.length - 1]);
  return out;
}
