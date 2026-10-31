// bots-bridge.js - the UI's one door to the bots.
//
// Interface agreed with the bot task: src/bots/index.js exports
//   BOT_LEVELS = ['easy', 'medium', 'hard']
//   chooseAction(state, level, rng, { jitter }) -> an action of getValidActions(state)
//   isAsyncLevel(level)  (true for a level that answers with a Promise)
// While that file does not exist the random bot answers every level, so the
// page and its tests run. The module is loaded with a dynamic import for that
// reason; once src/bots/index.js is in place nothing here needs to change.

let impl = null;

export const FALLBACK_LEVELS = ['easy', 'medium', 'hard'];

/** Loads the bots. Resolves with { levels, real } and never rejects. */
export async function loadBots() {
  try {
    const mod = await import('../bots/index.js');
    impl = {
      levels: Array.isArray(mod.BOT_LEVELS) ? mod.BOT_LEVELS.map((l) => (typeof l === 'string' ? l : l.id)) : FALLBACK_LEVELS,
      choose: (state, level, rng) => mod.chooseAction(state, level, rng),
      real: true,
    };
  } catch {
    const mod = await import('../bots/randomBot.js');
    impl = {
      levels: FALLBACK_LEVELS,
      choose: (state, level, rng) => mod.chooseRandomAction(state, rng),
      real: false,
    };
  }
  return { levels: impl.levels, real: impl.real };
}

export function botLevels() {
  return impl ? impl.levels : FALLBACK_LEVELS;
}

/** An action (or a Promise of one) for state.toAct. */
export function chooseBotAction(state, level, rng) {
  if (!impl) throw new Error('The bots are not loaded yet.');
  return impl.choose(state, level, rng);
}
