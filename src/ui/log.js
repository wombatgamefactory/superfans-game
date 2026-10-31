// log.js - turns the events of an applied action into game-log lines.
//
// The engine returns events and keeps no log; this page keeps the lines. The
// log is part of the undo snapshot (see main.js). Secret events (an unseen
// Achievement drawn or binned) never produce a line that names the card.

import { EVENTS, hallName, celebrityCard, swagCard, achievementCard } from '../engine/index.js';

function nameOf(state, seat) {
  return seat === null || seat === undefined ? 'Someone' : state.players[seat].name;
}

function selfieText(gain) {
  const parts = ['green', 'red', 'orange'].filter((c) => gain[c] > 0).map((c) => `${gain[c]} ${c}`);
  return parts.length ? `${parts.join(' + ')} Selfie${parts.length === 1 && gain[['green', 'red', 'orange'].find((c) => gain[c] > 0)] === 1 ? '' : 's'}` : 'no Selfies';
}

/**
 * Log lines for the events of one applyAction call.
 * @param {object} state a state to read names from (before or after: names never change)
 * @param {object[]} events
 * @param {number} hour the Hour the action happened in
 * @returns {{ hour: number, seat: number | null, text: string, kind: string }[]}
 */
export function eventsToLog(state, events, hour) {
  const out = [];
  const push = (seat, text, kind = 'action') => out.push({ hour, seat, text, kind });
  const coffeeBreak = [];
  for (const ev of events) {
    switch (ev.type) {
      case EVENTS.ACTION:
        push(ev.player, `${nameOf(state, ev.player)}: ${ev.text}${ev.auto ? ' (automatic: the only choice)' : ''}`, ev.auto ? 'auto' : 'action');
        break;
      case EVENTS.HOUR_START:
        push(null, `Hour ${ev.hour} begins.`, 'hour');
        break;
      case EVENTS.PHASE_START:
        if (ev.phase === 'walk') push(null, 'Celebrity Walk.', 'walk');
        break;
      case EVENTS.COFFEE_GAIN:
        if (ev.cause === 'coffee-break') coffeeBreak.push(ev);
        break;
      case EVENTS.PASSED:
        push(ev.player, `${nameOf(state, ev.player)} passes${ev.first ? ' first' : ''}.`, 'pass');
        break;
      case EVENTS.CELEBRITY_ENTERED: {
        const c = celebrityCard(ev.celebrity);
        push(null, `${c.name} enters ${hallName(ev.hall)}.`, 'walk');
        break;
      }
      case EVENTS.SELFIE_GAIN:
        if (ev.cause === 'walk-prime' || ev.cause === 'walk-photographer') {
          push(ev.player, `${nameOf(state, ev.player)} gains ${selfieText(ev.gain)} (${ev.cause === 'walk-prime' ? 'Prime Position' : 'Photographer'}).`, 'walk');
        }
        break;
      case EVENTS.CELEBRITY_SCORED: {
        const c = celebrityCard(ev.celebrity);
        const totals = state.players.map((p, i) => ({ p, vp: ev.totals[i] || 0 })).filter((t) => t.vp > 0);
        push(null, `${c.name} scores ${hallName(ev.hall)}: ${totals.length ? totals.map((t) => `${t.p.name} ${t.vp} VP`).join(', ') : 'nobody was there'}.`, 'score');
        break;
      }
      case EVENTS.ACHIEVEMENT_SCORED: {
        const card = achievementCard(ev.card);
        push(ev.player, `${nameOf(state, ev.player)} scores the Achievement "${card ? card.name : ev.card}": ${ev.vp} VP${ev.tripled ? ' (tripled)' : ''}.`, 'score');
        break;
      }
      case EVENTS.SWAG_BOUGHT: {
        const card = swagCard(ev.card);
        push(ev.player, `${nameOf(state, ev.player)} buys ${card ? card.name : ev.card}.`, 'swag');
        break;
      }
      case EVENTS.DECK_RESHUFFLED:
        push(null, `The ${ev.deck} deck is reshuffled.`, 'info');
        break;
      case EVENTS.SAFETY_STOP:
        push(null, 'A digital safety limit was reached.', 'info');
        break;
      case EVENTS.GAME_END:
        push(null, 'The convention closes. Final scores are in.', 'hour');
        break;
      default:
        break;
    }
  }
  if (coffeeBreak.length > 0) {
    push(null, `Coffee Break: ${coffeeBreak.map((e) => `${nameOf(state, e.player)} +${e.amount}`).join(', ')} coffee.`, 'info');
  }
  return out;
}
