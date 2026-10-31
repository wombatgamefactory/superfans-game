// scoring.js - every VP the game awards goes through `addVp` (with its R22.7
// source), plus the two scoring procedures that need no decision: destination
// scoring (R21) and the end of final scoring (R22.3, R22.4), and `scoreGame`
// (R22.6 ranks and tie-break).
//
// BOOKKEEPING INVARIANT: for every seat, the sum of `vp` events equals
// `players[seat].vp` equals `scoreGame(state).players[seat].vp`, and the same
// by source. The simulator asserts it.

import { getConstants } from './state.js';
import { emit, EVENTS, VP_SOURCES } from './events.js';
import { queue, seatsFrom, selfieTotal } from './queries.js';
import { countAchievement } from './achievements.js';

/** R1.5, R22.7 - adds VP to a seat with its source. Zero or less does nothing. */
export function addVp(state, seat, amount, source, detail = {}) {
  if (!(amount > 0)) return;
  if (!VP_SOURCES.includes(source)) throw new Error(`Engine bug: unknown VP source "${source}".`);
  const p = state.players[seat];
  p.vp += amount;
  p.vpBySource[source] += amount;
  emit({ type: EVENTS.VP, player: seat, amount, source, detail });
}

/**
 * R21.2 - what each Crew in a destination queue scores under a method.
 * @returns {Array<{ player, crew, position, badge, vp }>} one entry per Crew in the hall, in queue order
 */
export function destinationPayouts(state, cardId, hall) {
  const K = getConstants(state);
  const card = K.CELEBRITIES.CELEBRITIES[cardId];
  const v = card.VALUES;
  const q = queue(state, hall);
  const N = q.length;
  const out = [];
  let ranked = 0; // in-order-no-n00bs: VIP/AAA Crew counted so far
  q.forEach((c, i) => {
    let vp = 0;
    switch (card.METHOD) {
      case 'everyone':
        vp = v[0];
        break;
      case 'by-badge':
        vp = c.badge === 'AAA' ? v[2] : c.badge === 'VIP' ? v[1] : v[0];
        break;
      case 'everyone-no-n00bs':
        vp = c.badge === 'N00b' ? 0 : v[0];
        break;
      case 'in-order':
        vp = i < v.length ? v[i] : 0; // positions beyond the list score 0 (R21.3)
        break;
      case 'in-order-no-n00bs':
        if (c.badge !== 'N00b') {
          vp = ranked < v.length ? v[ranked] : 0;
          ranked++;
        }
        break;
      case 'count-total': {
        const [b1, b2] = K.CELEBRITIES.COUNT_TOTAL_BANDS;
        vp = N <= b1 ? v[0] : N <= b2 ? v[1] : v[2];
        break;
      }
      default:
        throw new Error(`Engine bug: unknown scoring method "${card.METHOD}" on ${cardId}.`);
    }
    out.push({ player: c.owner, crew: c.id, position: i + 1, badge: c.badge, vp });
  });
  return out;
}

/** R20.4, R21.1 - the destination hall of a schedule slot scores. */
export function scoreDestination(state, entry) {
  const K = getConstants(state);
  const hall = entry.figure;
  const method = K.CELEBRITIES.CELEBRITIES[entry.card].METHOD;
  const payouts = destinationPayouts(state, entry.card, hall);
  const totals = state.players.map(() => 0);
  for (const p of payouts) {
    totals[p.player] += p.vp;
    addVp(state, p.player, p.vp, 'celebrity', {
      card: entry.card,
      slot: entry.slot,
      hall,
      method,
      hour: state.hour,
      crew: p.crew,
      position: p.position,
      badge: p.badge,
    });
  }
  emit({
    type: EVENTS.CELEBRITY_SCORED,
    celebrity: entry.card,
    slot: entry.slot,
    colour: entry.colour,
    hall,
    method,
    hour: state.hour,
    payouts,
    totals,
  });
  return totals;
}

/**
 * R19.3, R19.4 - scores one Achievement for a seat now and discards it
 * (public, R19.7). Removes it from the hand. Returns the VP.
 *
 * @param {'pass'|'swag'|'final'} when
 */
export function scoreAchievement(state, seat, cardId, multiplier, when) {
  const K = getConstants(state);
  const p = state.players[seat];
  const { count, choice } = countAchievement(state, seat, cardId);
  const laurel = K.ACHIEVEMENTS.ACHIEVEMENT_LAUREL[cardId];
  const vp = count * laurel * multiplier;
  const i = p.hand.indexOf(cardId);
  if (i >= 0) p.hand.splice(i, 1);
  state.achievements.discard.push({ card: cardId, owner: seat, scored: true });
  const source = when === 'pass' ? 'achievement-pass' : when === 'swag' ? 'achievement-swag' : 'achievement-final';
  emit({
    type: EVENTS.ACHIEVEMENT_SCORED,
    player: seat,
    card: cardId,
    count,
    laurel,
    multiplier,
    vp,
    choice,
    when,
    hour: state.hour,
    tripled: multiplier === K.ACHIEVEMENTS.ACHIEVEMENT_FINAL_MULTIPLIER && when === 'final',
  });
  addVp(state, seat, vp, source, { card: cardId, count, multiplier, hour: state.hour, choice });
  return vp;
}

/**
 * R22.3, R22.4 - the automatic part of final scoring, for every seat in turn
 * order from the Hour 5 first player (R22.1): the last Achievement(s), the best
 * one tripled (R22.3, R23.5), then leftover selfies at E3 (R22.4).
 * Records a summary at `state.final`.
 */
export function applyFinalScoring(state) {
  const K = getConstants(state);
  const triple = K.ACHIEVEMENTS.ACHIEVEMENT_FINAL_MULTIPLIER;
  const single = K.ACHIEVEMENTS.ACHIEVEMENT_OTHER_MULTIPLIER;
  const summary = [];
  for (const seat of seatsFrom(state, state.firstPlayer)) {
    const p = state.players[seat];
    // Which card is tripled: the one worth most at x1; ties go to the lower card id.
    const values = p.hand
      .map((card) => ({ card, base: countAchievement(state, seat, card).count * K.ACHIEVEMENTS.ACHIEVEMENT_LAUREL[card] }))
      .sort((a, b) => b.base - a.base || (a.card < b.card ? -1 : 1));
    const scored = [];
    values.forEach((entry, i) => {
      const vp = scoreAchievement(state, seat, entry.card, i === 0 ? triple : single, 'final');
      scored.push({ card: entry.card, multiplier: i === 0 ? triple : single, vp });
    });
    // R22.4 - leftover selfies, automatically, as often as possible.
    const total = selfieTotal(p.selfies);
    const exchanges = Math.floor(total / K.FINAL.FINAL_SELFIES_PER_EXCHANGE);
    let selfieVp = 0;
    if (exchanges > 0) {
      let toPay = exchanges * K.FINAL.FINAL_SELFIES_PER_EXCHANGE;
      const pay = { green: 0, red: 0, orange: 0 };
      // Spend the most plentiful colours first (no rule depends on which).
      while (toPay > 0) {
        const c = ['green', 'red', 'orange'].reduce((a, b) => (p.selfies[b] - pay[b] > p.selfies[a] - pay[a] ? b : a));
        pay[c]++;
        toPay--;
      }
      for (const c of ['green', 'red', 'orange']) p.selfies[c] -= pay[c];
      emit({ type: EVENTS.SELFIE_SPEND, player: seat, pay, cause: 'final-selfies' });
      selfieVp = exchanges * K.FINAL.FINAL_VP_PER_EXCHANGE;
      addVp(state, seat, selfieVp, 'final-selfies', { selfies: exchanges * K.FINAL.FINAL_SELFIES_PER_EXCHANGE, exchanges });
    }
    summary.push({ seat, achievements: scored, selfieExchanges: exchanges, selfieVp });
  }
  state.final = { order: seatsFrom(state, state.firstPlayer), players: summary };
}

/**
 * R22.6 - the scores and ranks. Valid at any moment (mid-game it ranks the
 * current VP). Ties are broken by clockwise order from the holder of the First
 * Player marker (that seat first), which orders everybody: `rank` is 1..n with
 * no repeats. `vpRank` is the rank on VP alone (tied players share it), for
 * "shared win" displays and analytics.
 *
 * @returns {{ players: Array<{ seat, name, vp, bySource, rank, vpRank }>, order: number[], winner: number, sharedTop: number[], final: boolean }}
 */
export function scoreGame(state) {
  const order0 = seatsFrom(state, state.firstPlayer);
  const tieIndex = new Map(order0.map((s, i) => [s, i]));
  const order = state.players
    .map((p) => p.seat)
    .sort((a, b) => state.players[b].vp - state.players[a].vp || tieIndex.get(a) - tieIndex.get(b));
  const rank = {};
  order.forEach((s, i) => {
    rank[s] = i + 1;
  });
  const players = state.players.map((p) => ({
    seat: p.seat,
    name: p.name,
    vp: p.vp,
    bySource: { ...p.vpBySource },
    rank: rank[p.seat],
    vpRank: 1 + state.players.filter((q) => q.vp > p.vp).length,
  }));
  const top = state.players[order[0]].vp;
  return {
    players,
    order,
    winner: order[0],
    sharedTop: order.filter((s) => state.players[s].vp === top),
    final: state.phase === 'ended',
  };
}
