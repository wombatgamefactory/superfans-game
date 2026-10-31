// real-player.js - wires the T16 features to the page's choke points.
//
// main.js exports registerHooks({ onGameStart, onAction, onGameEnd, onRefusal, onRender }).
// This module registers one set of callbacks that feed:
//   - analytics.js        (game_start, hour_end, game_end, game_abandoned, illegal_action_attempted, rules_opened)
//   - bug-report-capture  (the action and event ring buffers)
//   - history.js          (your last games, in this browser only)
// and mounts the bug reporter and the end-screen tabs.
//
// Everything here is wrapped so that a failure costs the player nothing: a broken
// hook never reaches the game (main.js also catches), and analytics is a no-op
// until CONFIG.GA4_MEASUREMENT_ID is set.

import { EVENTS, scoreGame, describeAction, nonDefaultVariants, topFrame } from '../engine/index.js';
import {
  track, gameStartParams, hourEndParams, gameEndParams, trackAbandoned, reasonCode, safeToken,
} from './analytics.js';
import { collectStats, winnerSources } from './stats.js';
import { addGame, summarise, installHistoryClear } from './history.js';
import { installEndTabs } from './stats-view.js';
import { installBugReporter } from './bug-report-ui.js';
import { startLogs, logAction, logEvent } from './bug-report-capture.js';
import { getPending } from './ui-state.js';

/** At most this many illegal_action_attempted events per game (a player jabbing a button must not flood GA). */
export const REFUSAL_CAP = 40;

/**
 * @param {object} opts
 *   registerHooks   main.js's registerHooks
 *   getContext      () => { state, seats, actions, screen, seed, ... } the page's facts, read fresh each call
 * @returns {object} handles for the tests (bug reporter API)
 */
export function installRealPlayerTools({ registerHooks, getContext }) {
  const session = { startedAt: 0, ended: true, refusals: 0, lastHumanActor: null, rulesOpen: false, hourSent: new Set() };

  installEndTabs();
  installHistoryClear();

  const bug = installBugReporter({
    getContext: () => {
      const c = getContext();
      return {
        state: c.state,
        seats: c.seats,
        replay: { actions: (c.actions || []).map((a) => a.action) },
        lastHumanActor: session.lastHumanActor,
        screen: c.screen,
        ui: {
          seed: c.seed,
          incidents: c.incidents,
          fallbackCount: c.fallbackCount,
          humanActions: c.humanActions,
          speed: c.speed,
          generic: c.generic,
          pending: safe(() => ({ ...getPending() })),
          modal: c.modal,
          undoDepth: c.undoDepth,
        },
      };
    },
  });

  registerHooks({
    onGameStart(info) {
      try {
        session.startedAt = performance.now();
        session.ended = false;
        session.refusals = 0;
        session.lastHumanActor = null;
        session.hourSent = new Set();
        startLogs();
        track('game_start', gameStartParams(info.seats, nonDefaultVariants(info.state.variants)));
      } catch (err) {
        logEvent('error', `analytics game_start: ${err && err.message}`);
      }
    },

    onAction(events, info) {
      try {
        if (info.how !== 'bot' && info.how !== 'fallback') session.lastHumanActor = info.seat;
        const act = events.find((e) => e.type === EVENTS.ACTION && !e.auto);
        logAction({
          seq: info.state.seq,
          seat: info.seat,
          name: info.state.players[info.seat] ? info.state.players[info.seat].name : null,
          text: safe(() => describeAction(info.before, info.action)),
          how: info.how,
          action: info.action,
          engineText: act ? act.text : null,
        });
        // hour_end: the VP is read from the state BEFORE the action plus the VP events, in order (undo-proof)
        const seats = getContext().seats;
        const vp = info.before.players.map((p) => p.vp);
        for (const e of events) {
          if (e.type === EVENTS.VP) vp[e.player] += e.amount;
          else if (e.type === EVENTS.HOUR_START && e.hour > 1) sendHourEnd(seats, vp, e.hour - 1);
          else if (e.type === EVENTS.PHASE_START && e.phase === 'final') sendHourEnd(seats, vp, 5);
        }
      } catch (err) {
        logEvent('error', `onAction hook: ${err && err.message}`);
      }
    },

    onGameEnd(info) {
      try {
        session.ended = true;
        const scores = info.scores ?? scoreGame(info.state);
        const stats = collectStats(info.events, info.state.players, info.seats);
        track(
          'game_end',
          gameEndParams({
            seats: info.seats,
            scores,
            hoursPlayed: info.state.hour,
            durationMs: info.durationMs,
            winnerSources: winnerSources(stats, scores),
            achievementsCompleted: stats.achievementsCompletedTotal,
          }),
        );
        addGame(summarise({ state: info.state, scores, seats: info.seats, durationMs: info.durationMs }));
      } catch (err) {
        logEvent('error', `onGameEnd hook: ${err && err.message}`);
      }
    },

    onRefusal(info) {
      try {
        logEvent('refusal', info.text);
        if (session.refusals >= REFUSAL_CAP) return;
        session.refusals += 1;
        const pending = getPending();
        const frame = info.state ? topFrame(info.state) : null;
        track('illegal_action_attempted', {
          action_type: safeToken(pending.armed || (frame && frame.kind) || 'unknown'),
          reason_code: reasonCode(info.text),
        });
      } catch {
        // swallowed
      }
    },

    onRender() {
      try {
        const open = !!document.querySelector('#sf-modal-root [data-modal="rules"]');
        if (open && !session.rulesOpen) track('rules_opened', {});
        session.rulesOpen = open;
      } catch {
        // swallowed
      }
    },
  });

  function sendHourEnd(seats, vp, hour) {
    if (session.hourSent.has(hour)) return; // an undo cannot cross an Hour, but never send one twice
    session.hourSent.add(hour);
    track('hour_end', hourEndParams(seats, vp, hour));
  }

  // The tab closes or navigates away with a game still running.
  window.addEventListener('pagehide', () => {
    try {
      if (session.ended) return;
      const c = getContext();
      if (!c || !c.state || c.screen !== 'game' || c.state.phase === 'ended') return;
      session.ended = true;
      trackAbandoned(c.seats, c.state.hour, performance.now() - session.startedAt);
    } catch {
      // swallowed
    }
  });

  return bug;
}

function safe(fn) {
  try {
    return fn();
  } catch {
    return null;
  }
}
