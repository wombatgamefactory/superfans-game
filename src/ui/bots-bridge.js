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
  if (level === 'hard' && impl.real) {
    const w = hardWorker();
    if (w !== null) return askWorker(w, state, level, rng);
  }
  return impl.choose(state, level, rng);
}

// T15: Hard (the search bot) thinks in a Web Worker (src/bots/bot-worker.js)
// with a clock and its default time budget per turn, so the page never
// freezes. If workers are unavailable or the worker fails, Hard runs inline
// (synchronously, on its fixed playout allowance) instead.
let worker = null;
let workerBroken = false;
let nextId = 1;
const pending = new Map();

function hardWorker() {
  if (workerBroken || typeof Worker === 'undefined') return null;
  if (worker !== null) return worker;
  try {
    worker = new Worker(new URL('../bots/bot-worker.js', import.meta.url), { type: 'module' });
  } catch {
    workerBroken = true;
    return null;
  }
  worker.onmessage = (event) => {
    const reply = event.data;
    const p = pending.get(reply.id);
    if (!p) return;
    pending.delete(reply.id);
    if (reply.ok) p.resolve(reply.action);
    else p.reject(new Error(reply.error));
  };
  worker.onerror = () => {
    workerBroken = true;
    worker = null;
    for (const p of pending.values()) p.reject(new Error('The Hard bot worker failed; Hard now thinks on the page.'));
    pending.clear();
  };
  return worker;
}

function askWorker(w, state, level, rng) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    w.postMessage({ id, state, level, seed: rng && typeof rng.s === 'number' ? rng.s : id });
  });
}
