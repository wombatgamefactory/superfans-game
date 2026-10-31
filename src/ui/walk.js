// walk.js - the Celebrity Walk as an animation.
//
// The engine resolves the whole Walk inside the one applyAction call that ends
// the Hour (R20.1: no decisions), and returns it as events. This module
// replays those events over a COPY of the state from before the action: the
// figure hops hall to hall along its route (celebrityEntered), the hall
// flashes, a floating chip shows each Selfie gained (Prime Position,
// Photographer), and each destination scoring opens the arithmetic popup and
// waits for Continue. When it ends the page goes back to the real state.
//
// Nothing here works out a rule: every number comes from an event.

import { EVENTS, cloneState, celebrityCard, hallName, HALLS, scheduleSlot } from '../engine/index.js';
import { art, escapeHtml, ICON } from './art.js';

/** Applies the simple numeric effect of an event to a display copy of the state. */
export function patchDisplay(display, ev) {
  const p = ev.player !== undefined && ev.player !== null ? display.players[ev.player] : null;
  switch (ev.type) {
    case EVENTS.COFFEE_GAIN:
      if (p) p.coffee = Math.min(12, p.coffee + ev.amount);
      break;
    case EVENTS.COFFEE_SPEND:
      if (p) p.coffee = Math.max(0, p.coffee - ev.amount);
      break;
    case EVENTS.SELFIE_GAIN:
      if (p) for (const c of ['green', 'red', 'orange']) p.selfies[c] += ev.gain[c] || 0;
      break;
    case EVENTS.SELFIE_SPEND:
      if (p) for (const c of ['green', 'red', 'orange']) p.selfies[c] = Math.max(0, p.selfies[c] - (ev.pay[c] || 0));
      break;
    case EVENTS.VP:
      if (p) p.vp += ev.amount;
      break;
    case EVENTS.PASSED:
      if (p) p.passSlot = Math.max(1, p.passSlot);
      break;
    default:
      break;
  }
}

function hallCentrePercent(hall) {
  const h = HALLS.find((x) => x.id === hall);
  return { x: ((50 + (h.col - 1) * 114) / 328) * 100, y: ((50 + (h.row - 1) * 114) / 328) * 100 };
}

/**
 * @param {object} host
 *   view                the ui-state view object
 *   setDisplay(state)   draw this state instead of the real one (null = the real one)
 *   render()            redraw
 *   wait(ms)            a Promise that resolves after ms (speed-aware)
 *   showScore(data)     a Promise that resolves when the player presses Continue
 *   addFloat(f)         show a floating chip
 * @param {object} before the state before the action that ran the Walk
 * @param {object[]} events the events of that action
 * @returns {Promise<boolean>} whether a Walk was played
 */
export async function playWalk(host, before, events) {
  const first = events.findIndex((e) => e.type === EVENTS.CELEBRITY_ENTERED);
  if (first < 0) return false;
  const { view } = host;
  const display = cloneState(before);
  for (const ev of events.slice(0, first)) patchDisplay(display, ev);
  display.phase = 'walk';
  const walkers = [];
  for (const ev of events) {
    if (ev.type === EVENTS.CELEBRITY_ENTERED && !walkers.some((w) => w.slot === ev.slot)) {
      walkers.push({ slot: ev.slot, card: ev.celebrity, colour: ev.colour, doneTo: 0 });
    }
  }
  view.walk = { stepText: 'Celebrity Walk', text: `${walkers.map((w) => celebrityCard(w.card).name).join(' and ')} set off`, feed: [], routes: walkers };
  host.setDisplay(display);
  host.render();
  await host.wait(500);

  let buffered = [];
  const gains = new Map(); // hall -> lines for the scoring popup
  for (let i = first; i < events.length; i += 1) {
    const ev = events[i];
    if (ev.type === EVENTS.CELEBRITY_ENTERED) {
      const entry = display.schedule.find((s) => s.slot === ev.slot);
      if (entry) entry.figure = ev.hall;
      const w = walkers.find((x) => x.slot === ev.slot);
      if (w) w.doneTo = ev.step;
      const c = celebrityCard(ev.celebrity);
      view.walk.stepText = `Hall ${ev.step} of ${ev.of}`;
      view.walk.text = `${c.name} enters ${hallName(ev.hall)}`;
      view.walk.feed.push({ text: `${c.name} enters ${hallName(ev.hall)}.`, colour: null });
      view.flash = { ...view.flash, halls: [ev.hall] };
      host.render();
      await host.wait(700);
    } else if (ev.type === EVENTS.SELFIE_GAIN && (ev.cause === 'walk-prime' || ev.cause === 'walk-photographer')) {
      patchDisplay(display, ev);
      const who = display.players[ev.player];
      const colour = ['green', 'red', 'orange'].find((c) => ev.gain[c] > 0) ?? 'green';
      const why = ev.cause === 'walk-prime' ? 'Prime Position' : 'Photographer';
      const text = `${who.name}: +1 ${colour} Selfie (${why})`;
      view.walk.feed.push({ text: `${text}.`, colour: who.colour });
      const pos = hallCentrePercent(ev.detail && ev.detail.hall ? ev.detail.hall : 'main-hall');
      host.addFloat({ colour: who.colour, x: Math.min(60, Math.max(2, pos.x - 14)), y: pos.y - 4 + (ev.cause === 'walk-photographer' ? 7 : 0), html: `${art(ICON.selfie[colour], { alt: '' })}+1 ${escapeHtml(who.name)} &middot; ${why}` });
      const key = ev.detail && ev.detail.hall;
      if (key) gains.set(key, [...(gains.get(key) || []), { colour, text: `${who.name} takes +1 ${colour} Selfie (${why}).` }]);
      view.flash = { ...view.flash, gain: [ev.player] };
      host.render();
      await host.wait(450);
    } else if (ev.type === EVENTS.VP) {
      buffered.push(ev);
    } else if (ev.type === EVENTS.CELEBRITY_SCORED) {
      view.flash = { ...view.flash, halls: [ev.hall] };
      const placed = events.slice(i).find((e) => e.type === EVENTS.CELEBRITY_PLACED);
      const next = placed ? `Next: ${celebrityCard(placed.celebrity).name} steps onto the floor.` : '';
      view.walk.text = `${celebrityCard(ev.celebrity).name} scores ${hallName(ev.hall)}`;
      host.render();
      await host.showScore({ event: ev, selfies: gains.get(ev.hall) || [], next });
      for (const b of buffered) patchDisplay(display, b);
      view.walk.feed.push({ text: `${celebrityCard(ev.celebrity).name} scores ${hallName(ev.hall)}.`, colour: null });
      buffered = [];
      host.render();
      await host.wait(350);
    }
  }
  view.walk = null;
  view.flash = { pour: [], gain: [], halls: [], crew: [], seq: -1 };
  host.setDisplay(null);
  host.render();
  return true;
}

export { scheduleSlot };
