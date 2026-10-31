// end-screen.js - the results: ranks, ties, seat badges and each player's
// arithmetic, with a few game-stat tiles.
//
// Rendering is defensive: if a stat is missing its tile is left out, and the
// screen never prints "undefined". Ranks come from the engine (scoreGame):
// `rank` after the R22.6 tie-break, `vpRank` before it (shared ranks).

import { scoreGame, hallName, achievementCard, clubCard, EVENTS, getConstants } from '../engine/index.js';
import { art, escapeHtml, crewPiece, ICON, SELFIE_COLOURS } from './art.js';
import { confettiHtml } from './modals.js';

const GROUPS = [
  { id: 'celeb', label: 'Celebrities', sources: ['celebrity'] },
  { id: 'ach', label: 'Achievements', sources: ['achievement-pass', 'achievement-final', 'achievement-swag'] },
  { id: 'pass', label: 'Pass card', sources: ['pass-slot'] },
  { id: 'exch', label: 'Selfie Exchange', sources: ['exchange', 'final-selfies'] },
  { id: 'swag', label: 'Swag and Club', sources: ['swag', 'club', 'militia'] },
];

const SWATCH = { celeb: 'var(--zone-star)', ach: 'var(--zone-goal)', pass: 'var(--zone-pass)', exch: 'var(--celeb-orange)', swag: 'var(--zone-swag)' };

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

function groupTotal(p, g) {
  return g.sources.reduce((n, s) => n + (p.bySource[s] || 0), 0);
}

function seatChip(seat) {
  return seat.kind === 'bot' ? `<span class="sf-chip sf-chip--bot">${escapeHtml(seat.level)} bot</span>` : '<span class="sf-chip sf-chip--human">Human</span>';
}

/** The arithmetic text of each group for one seat, from the VP events. */
function arithmetic(events, seat) {
  const mine = events.filter((e) => e.type === EVENTS.VP && e.player === seat);
  const celeb = new Map();
  for (const e of mine.filter((x) => x.source === 'celebrity')) {
    const k = `${e.detail.hour}:${e.detail.slot}`;
    celeb.set(k, (celeb.get(k) || 0) + e.amount);
  }
  const ach = mine.filter((x) => x.source.startsWith('achievement')).map((x) => (x.detail.multiplier > 1 && x.source === 'achievement-final' ? `${x.amount / x.detail.multiplier}×${x.detail.multiplier}` : `${x.amount}`));
  const pass = mine.filter((x) => x.source === 'pass-slot').map((x) => x.amount);
  const exch = mine.filter((x) => x.source === 'exchange' || x.source === 'final-selfies').reduce((n, x) => n + x.amount, 0);
  return {
    celeb: [...celeb.values()].join(' + '),
    ach: ach.join(' + '),
    pass: pass.join(' + '),
    exch: exch ? `${exch / 2} trade${exch / 2 === 1 ? '' : 's'} × 2` : '',
  };
}

function titleAndSub(state, sc, seats) {
  const best = sc.players.find((p) => p.rank === 1);
  const winner = state.players[best.seat];
  const club = winner.club ? clubCard(winner.club) : null;
  const tops = sc.sharedTop;
  let title = `${winner.name}${club ? `'s ${club.name}` : ''} wins!`;
  let sub = `${best.vp} VP after five Hours.`;
  if (tops.length > 1) {
    const names = tops.map((s) => state.players[s].name);
    sub += ` ${names.slice(0, -1).join(', ')} and ${names[names.length - 1]} tied on ${best.vp}; ${winner.name} takes first on the tie-break (closest to the First Player marker, clockwise).`;
    title = `${winner.name}${club ? `'s ${club.name}` : ''} wins on the tie-break!`;
  } else {
    // a tie lower down the table
    const byVp = new Map();
    for (const p of sc.players) byVp.set(p.vp, [...(byVp.get(p.vp) || []), p]);
    const tie = [...byVp.values()].find((g) => g.length > 1);
    if (tie) {
      const sorted = [...tie].sort((x, y) => x.rank - y.rank);
      const names = sorted.map((q) => q.name);
      sub += ` ${names.slice(0, -1).join(', ')} and ${names[names.length - 1]} tied on ${tie[0].vp}; ${sorted[0].name} is ahead on the tie-break.`;
    }
  }
  if (sc.players.length && seats && state.flags.turnCapped) sub += ' (The game ended at a digital safety limit.)';
  return { title, sub };
}

/** Stat tiles built from the events of the whole game. Missing data leaves a tile out. */
function statTiles(state, events, seats) {
  const tiles = [];
  const scored = events.filter((e) => e.type === EVENTS.CELEBRITY_SCORED);
  let best = null;
  for (const e of scored) {
    e.totals.forEach((vp, seat) => {
      if (!best || vp > best.vp) best = { vp, seat, hall: e.hall, hour: e.hour, celebrity: e.celebrity };
    });
  }
  if (best && best.vp > 0) {
    const c = state.players[best.seat];
    tiles.push({ icon: ICON.star, value: `${best.vp} VP`, label: `Biggest payout: ${c.name} at ${hallName(best.hall)}, Hour ${best.hour}` });
  }
  const spent = state.players.map(() => 0);
  for (const e of events) if (e.type === EVENTS.COFFEE_SPEND) spent[e.player] += e.amount;
  const totalSpent = spent.reduce((a, b) => a + b, 0);
  if (totalSpent > 0) {
    tiles.push({ icon: ICON.coffee, value: `${totalSpent}`, label: `Coffee spent across the table (${state.players.map((p, i) => `${p.name} ${spent[i]}`).join(', ')})` });
  }
  const taken = { green: 0, red: 0, orange: 0 };
  let takenTotal = 0;
  for (const e of events) {
    if (e.type !== EVENTS.SELFIE_GAIN || !['take-selfie', 'walk-prime', 'walk-photographer'].includes(e.cause)) continue;
    for (const c of SELFIE_COLOURS) {
      taken[c] += e.gain[c] || 0;
      takenTotal += e.gain[c] || 0;
    }
  }
  if (takenTotal > 0) tiles.push({ icon: ICON.selfie.red, value: `${takenTotal}`, label: `Selfies taken (green ${taken.green}, red ${taken.red}, orange ${taken.orange})` });
  const arrivals = {};
  for (const e of events) {
    if (e.type === EVENTS.CREW_MOVED) arrivals[e.to] = (arrivals[e.to] || 0) + 1;
    if (e.type === EVENTS.CREW_PLACED) arrivals[e.hall] = (arrivals[e.hall] || 0) + 1;
  }
  const busiest = Object.entries(arrivals).sort((a, b) => b[1] - a[1])[0];
  if (busiest) tiles.push({ icon: ICON.footprints, value: hallName(busiest[0]), label: `Busiest hall: ${busiest[1]} Crew arrivals` });
  // leader after each Hour and lead changes
  const leaders = [];
  const running = state.players.map(() => 0);
  let hourOf = 1;
  const snapshot = () => {
    const top = Math.max(...running);
    const leads = running.map((v, s) => (v === top ? s : -1)).filter((s) => s >= 0);
    leaders.push(leads.length === 1 ? state.players[leads[0]].name : 'a tie');
  };
  for (const e of events) {
    if (e.type === EVENTS.HOUR_START && e.hour > hourOf) {
      snapshot();
      hourOf = e.hour;
    }
    if (e.type === EVENTS.VP) running[e.player] += e.amount;
  }
  if (leaders.length) {
    let changes = 0;
    for (let i = 1; i < leaders.length; i += 1) if (leaders[i] !== leaders[i - 1]) changes += 1;
    tiles.push({ icon: ICON.trophy, value: plural(changes, 'lead change', 'lead changes'), label: `Leader at the end of Hours 1 to ${leaders.length}: ${leaders.join(', ')}` });
  }
  const passes = events.filter((e) => e.type === EVENTS.PASSED && e.first);
  if (passes.length) {
    const by = {};
    for (const e of passes) by[e.player] = (by[e.player] || 0) + 1;
    const top = Object.entries(by).sort((a, b) => b[1] - a[1])[0];
    tiles.push({ icon: ICON.rest, value: `${top[1]} of ${passes.length}`, label: `Hours ${state.players[top[0]].name} passed first and took the ${getConstants(state).PASS.PASS_FIRST_PASSER_COFFEE} coffee bonus` });
  }
  return tiles;
}

/** @returns {string} markup of the whole end screen */
export function renderEnd(state, seats, events, extra = {}) {
  const sc = scoreGame(state);
  const { title, sub } = titleAndSub(state, sc, seats);
  const byRank = [...sc.players].sort((a, b) => a.rank - b.rank);
  const podium = byRank.slice(0, 3);
  const podiumOrder = podium.length === 3 ? [podium[1], podium[0], podium[2]] : podium.length === 2 ? [podium[1], podium[0]] : podium;
  const pod = podiumOrder
    .map((p) => {
      const pl = state.players[p.seat];
      const badge = p.rank === 1 ? 'AAA' : p.rank === 2 ? 'VIP' : 'N00b';
      const shared = sc.players.some((q) => q.seat !== p.seat && q.vp === p.vp);
      return `<div class="sf-podium__step sf-podium__step--${p.rank} sf-pc--${pl.colour}"><span class="sf-podium__rank">${shared && p.vpRank !== p.rank ? '=' : ''}${p.vpRank === p.rank || !shared ? p.rank : p.vpRank}</span>${crewPiece(pl.colour, badge, { px: true })}${escapeHtml(pl.name)}${seatChip(seats[p.seat])}${p.vp}</div>`;
    })
    .join('');
  const rows = byRank
    .map((p) => {
      const pl = state.players[p.seat];
      const club = pl.club ? clubCard(pl.club) : null;
      const ar = arithmetic(events, p.seat);
      const total = Math.max(1, p.vp);
      const bar = GROUPS.map((g) => `<span class="sf-src--${g.id}" style="width:${(groupTotal(p, g) / total) * 100}%" title="${g.label}: ${groupTotal(p, g)}"></span>`).join('');
      const tied = sc.players.some((q) => q.seat !== p.seat && q.vp === p.vp);
      const finalAch = state.final ? state.final.players.find((f) => f.seat === p.seat) : null;
      const tripled = finalAch ? finalAch.achievements.find((a) => a.multiplier > 1) : null;
      const tripledName = tripled ? achievementCard(tripled.card) : null;
      return `<tr class="${p.rank === 1 ? 'is-winner ' : ''}sf-pc--${pl.colour}">
        <td>${tied && p.vpRank !== p.rank ? '=' : ''}${tied ? p.vpRank : p.rank}</td>
        <td><div class="sf-table__who"><span class="sf-score-marker"></span><div><span class="sf-table__name">${escapeHtml(pl.name)}</span> ${seatChip(seats[p.seat])}<span class="sf-table__arith">${club ? escapeHtml(club.name) : ''}${tied && p.rank > 1 ? ' &middot; behind on the tie-break' : ''}${tied && p.rank === 1 ? ' &middot; wins the tie-break' : ''}</span></div></div></td>
        <td>${groupTotal(p, GROUPS[0])}<span class="sf-table__arith">${escapeHtml(ar.celeb)}</span></td>
        <td>${groupTotal(p, GROUPS[1])}<span class="sf-table__arith">${escapeHtml(ar.ach)}${tripledName ? ` (last: ${escapeHtml(tripledName.name)} ×3)` : ''}</span></td>
        <td>${groupTotal(p, GROUPS[2])}<span class="sf-table__arith">${escapeHtml(ar.pass)}</span></td>
        <td>${groupTotal(p, GROUPS[3])}<span class="sf-table__arith">${escapeHtml(ar.exch)}</span></td>
        <td>${groupTotal(p, GROUPS[4])}</td>
        <td><div class="sf-vpbar">${bar}</div></td>
        <td class="sf-table__total">${p.vp}</td>
      </tr>`;
    })
    .join('');
  const tiles = statTiles(state, events, seats)
    .map((t) => `<div class="sf-panel sf-stat">${art(t.icon, { alt: '' })}<span class="sf-stat__value">${escapeHtml(t.value)}</span><span class="sf-stat__label">${escapeHtml(t.label)}</span></div>`)
    .join('');
  const legend = GROUPS.map((g) => `<span style="--sw:${SWATCH[g.id]}">${g.label}</span>`).join('');
  return `<div class="sf-endpage">${confettiHtml(70)}
  <main class="sf-end" style="position:relative;z-index:1">
    <div class="sf-end__hero">
      <div>
        ${art('logo-wordmark', { alt: 'Superfans', style: 'height:56px;border-radius:10px;box-shadow:var(--clay-drop)' })}
        <h1 class="sf-end__title" style="margin-top:14px">${escapeHtml(title)}</h1>
        <p class="sf-end__sub" style="margin:6px 0 0">${escapeHtml(sub)}</p>
        <div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:18px">
          <button class="sf-btn sf-btn--go sf-btn--big" data-act="play-again">Play again</button>
          <button class="sf-btn" data-act="new-game">New setup</button>
          <button class="sf-btn" data-act="download-record" title="Save the full game record as JSON">&#8681; Download game record</button>
          ${extra.bugButton ?? ''}
        </div>
      </div>
      <div class="sf-podium" aria-label="Podium">${pod}</div>
    </div>
    <section aria-label="Scores">
      <div class="sf-table-wrap">
        <table class="sf-table">
          <thead><tr><th>Rank</th><th>Player</th><th>Celebrities</th><th>Achievements</th><th>Pass card</th><th>Selfie Exchange</th><th>Swag and Club</th><th>Where it came from</th><th>Total</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
        <div class="sf-table__foot">
          <div class="sf-legend" style="margin-bottom:6px">${legend}</div>
          Tie-break: the tied player closest to the First Player marker, clockwise, at the end of Hour 5 wins (the First Player counts as closest). Each player's last Achievement scores three times over; leftover coffee scores nothing.
        </div>
      </div>
    </section>
    ${tiles ? `<section><h2 style="font-size:var(--fs-xl);margin-bottom:12px">Game stats</h2><div class="sf-stats">${tiles}</div></section>` : ''}
    <div id="sf-end-extra"></div>
  </main></div>`;
}

export { ICON };
