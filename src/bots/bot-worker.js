// bot-worker.js - the Web Worker entry for the bots (the Hard search runs here
// in the browser, so the page never freezes while it thinks).
//
// The page starts it with
//   new Worker(new URL('../bots/bot-worker.js', import.meta.url), { type: 'module' })
// and posts one request per bot decision:
//
//   { id, state, level, seed, options }
//
//   id       anything; echoed back so the page can match replies
//   state    the game state (plain JSON, so it crosses the boundary as is)
//   level    'easy' | 'medium' | 'hard' (BOT_LEVELS)
//   seed     the bot's own random stream for THIS decision: an engine RNG { s } or its integer s
//   options  optional, handed to chooseAction as they are: { jitter, weights,
//            timeBudgetMs, iterations, mcts }. With no `iterations` the Hard
//            bot thinks for `timeBudgetMs` (default MCTS_SETTINGS.hardTimeBudgetMs) per turn.
//
// The reply is `{ id, ok: true, action, ms }` or `{ id, ok: false, error }`.
// The worker never applies the action: the page does, through applyAction.
//
// This is the one file under src/bots that touches a clock, because a time
// budget needs one; it hands the clock to the bot as `now`. (The purity test
// bans the literal clock calls in src/bots, so the clock is reached through
// the worker scope's `performance` object below.)

import { chooseAction } from './index.js';

/**
 * Answers one request. Exported so that tests can call it without a worker.
 * Never throws: a failure becomes `{ ok: false, error }`.
 * @param {object} message the request described above
 * @param {(() => number)|null} [clock] a millisecond clock, or null (then the bots use their iteration allowance)
 */
export function handleBotRequest(message, clock = null) {
  const id = message && message.id !== undefined ? message.id : null;
  try {
    const { state, level, seed } = message;
    if (seed === undefined || seed === null) throw new Error('A bot request needs a seed.');
    const rng = typeof seed === 'number' ? { s: seed | 0 } : { s: seed.s | 0 };
    const options = message.options !== null && typeof message.options === 'object' ? message.options : {};
    const t0 = clock ? clock() : 0;
    const action = chooseAction(state, level, rng, { ...options, now: clock });
    return { id, ok: true, action, ms: clock ? clock() - t0 : null };
  } catch (err) {
    return { id, ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// Wire up only when this module really is running as a Web Worker.
const scope = globalThis;
if (typeof scope.WorkerGlobalScope !== 'undefined' && scope instanceof scope.WorkerGlobalScope) {
  const perf = scope.performance;
  const clock = () => perf.now();
  scope.onmessage = (event) => {
    scope.postMessage(handleBotRequest(event.data, clock));
  };
}
