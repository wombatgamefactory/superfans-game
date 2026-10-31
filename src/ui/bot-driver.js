// bot-driver.js - runs the bot seats, visibly paced.
//
// The loop: ask the bot for `state.toAct`, receive an action (a value or a
// Promise: the Hard search bot will later run in a Web Worker), and hand it to
// the page's own commit path (the same one a human click takes).
//
// Anti-livelock guard: every proposal should come from getValidActions, so a
// refusal can only mean an engine or bot bug. A refused action, a thrown error
// and a timeout each count as a failure; after MAX_BOT_FAILURES in a row the
// driver applies a random legal action, logs the incident, and counts again.
// The counter is reset by every action that is applied.

import { getValidActions, makeRng, rngNext, rngPick, actionKey } from '../engine/index.js';
import { chooseBotAction } from './bots-bridge.js';

/** Milliseconds between a bot's turn becoming current and its move, by speed. */
export const PACING = { normal: 700, fast: 200, instant: 0 };

export const MAX_BOT_FAILURES = 3;

/** How long to wait for an asynchronous bot before calling it a failure. */
const BOT_TIMEOUT_MS = 30000;

/**
 * @param {object} hooks
 *   getState()          the current game state
 *   shouldRun()         true when a bot move should be asked for now
 *   levelFor(seat)      the bot level of a seat
 *   speed()             'normal' | 'fast' | 'instant'
 *   apply(action, how)  the page's commit path; returns a Promise/object { ok, error? }; how = 'bot' | 'fallback'
 *   incident(text)      log a driver incident
 */
export function createBotDriver(hooks) {
  let timer = null;
  let inflight = null; // { seq, toAct }
  let failures = 0;
  let epoch = 0;
  let botRng = makeRng('bots:0');
  let faultsLeft = 0;

  function seed(value) {
    botRng = makeRng(`bots:${value}`);
    failures = 0;
  }

  function cancel() {
    epoch += 1;
    if (timer !== null) clearTimeout(timer);
    timer = null;
    inflight = null;
  }

  /** Called whenever the situation may have changed: schedules a bot move if one is due. */
  function kick() {
    if (timer !== null || inflight !== null) return;
    if (!hooks.shouldRun()) return;
    const delay = PACING[hooks.speed()] ?? PACING.normal;
    timer = setTimeout(() => {
      timer = null;
      void request();
    }, delay);
  }

  async function request() {
    if (!hooks.shouldRun() || inflight !== null) return;
    const state = hooks.getState();
    const level = hooks.levelFor(state.toAct);
    const mine = epoch;
    inflight = { seq: state.seq, toAct: state.toAct };
    let action = null;
    let error = null;
    try {
      if (faultsLeft > 0) {
        faultsLeft -= 1;
        throw new Error('injected fault (test)');
      }
      const seedForCall = { s: Math.floor(rngNext(botRng) * 2147483647) | 0 };
      action = await withTimeout(Promise.resolve(chooseBotAction(state, level, seedForCall)), BOT_TIMEOUT_MS);
    } catch (err) {
      error = err;
    }
    if (mine !== epoch) return; // cancelled while thinking
    inflight = null;
    const now = hooks.getState();
    if (now.seq !== state.seq || now.toAct !== state.toAct) {
      kick();
      return;
    }
    if (error) {
      onFailure(`The ${level} bot raised an error: ${error.message ?? error}`);
      return;
    }
    const result = await hooks.apply(action, 'bot');
    if (mine !== epoch) return;
    if (result && result.ok) {
      failures = 0;
    } else {
      onFailure(`The engine refused the ${level} bot's action (${result ? result.error : 'no result'}).`);
    }
  }

  function onFailure(text) {
    failures += 1;
    hooks.incident(`Bot failure ${failures} of ${MAX_BOT_FAILURES}: ${text}`);
    if (failures >= MAX_BOT_FAILURES) {
      failures = 0;
      const state = hooks.getState();
      const legal = getValidActions(state);
      if (legal.length > 0) {
        const pick = rngPick(botRng, legal);
        hooks.incident(`Applying a random legal action (${actionKey(pick)}) for ${hooks.levelFor(state.toAct)} instead.`);
        void Promise.resolve(hooks.apply(pick, 'fallback')).then(() => kick());
        return;
      }
    }
    kick();
  }

  return {
    kick,
    cancel,
    seed,
    injectFaults(n) { faultsLeft = n; },
    get failures() { return failures; },
    get busy() { return timer !== null || inflight !== null; },
  };
}

function withTimeout(promise, ms) {
  let t;
  const timeout = new Promise((_, reject) => {
    t = setTimeout(() => reject(new Error('timed out')), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(t));
}
