// stats-view.js - the end screen's "Stats" tab: one card per player (VP by
// source, coffee, Selfies, actions by type, Achievements, Swag, Club power,
// celebrity scoring per Hour) and a lead-over-time chart in inline SVG.
//
// Input is the object collectStats() returns (built from engine events).
// Rendering is defensive: a missing part leaves its block out and the page never
// prints "undefined". Colours come from the CSS tokens, never hard-coded.

import { hallName } from '../engine/index.js';
import { art, escapeHtml, ICON, SELFIE_COLOURS } from './art.js';

const SOURCE_LABEL = {
  celebrity: 'Celebrities',
  'achievement-pass': 'Achievements (on passing)',
  'achievement-final': 'Last Achievement (x3)',
  'achievement-swag': 'Achievement via Swag',
  'pass-slot': 'Pass card',
  exchange: 'Selfie Exchange',
  'final-selfies': 'Leftover Selfies',
  swag: 'Swag cards',
  club: 'Club power',
  militia: 'Militia tokens',
};

const SOURCE_COLOUR = {
  celebrity: 'var(--zone-star)',
  'achievement-pass': 'var(--zone-goal)',
  'achievement-final': 'var(--zone-goal)',
  'achievement-swag': 'var(--zone-goal)',
  'pass-slot': 'var(--zone-pass)',
  exchange: 'var(--celeb-orange)',
  'final-selfies': 'var(--celeb-orange)',
  swag: 'var(--zone-swag)',
  club: 'var(--zone-swag)',
  militia: 'var(--zone-swag)',
};

const COFFEE_LABEL = {
  'coffee-break': 'Coffee Break',
  usher: 'Ushers',
  'first-pass': 'Passing first',
  'achievement-discard': 'Binned Achievements',
  'pass-slot': 'Pass card',
  exchange: 'Selfie Exchange',
  swag: 'Swag',
  club: 'Club',
};

const ACTION_LABEL = {
  move2: 'Move 2',
  move3: 'Move 1 Crew x3',
  newNoob: 'New N00b',
  upgrade: 'Upgrade',
  volunteer: 'Volunteer',
  takeSelfie: 'Take a Selfie',
  buySwag: 'Buy Swag',
  clubPower: 'Club power',
  pass: 'Pass',
  passReward: 'Pass reward',
  passAchievement: 'Pass Achievement',
  exchange: 'Selfie Exchange',
  strikeAPose: 'Strike a Pose',
  rareFinds: 'Rare Finds',
};

const WHEN_LABEL = { pass: 'on passing', final: 'at the end (x3)', swag: 'via Swag' };

const humanise = (type) => ACTION_LABEL[type] ?? String(type).replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase());
const label = (map, key) => map[key] ?? String(key).replace(/-/g, ' ');

function bars(entries, max, colourOf = () => 'var(--zone-act-2)') {
  if (!entries.length) return '<p class="sf-stats__none">Nothing yet.</p>';
  return `<ul class="sf-bars">${entries
    .map(([key, value, text]) => `<li class="sf-bars__row"><span class="sf-bars__label">${escapeHtml(text)}</span><span class="sf-bars__track"><span class="sf-bars__fill" style="width:${max > 0 ? Math.max(3, (value / max) * 100) : 0}%;background:${colourOf(key)}"></span></span><span class="sf-bars__value">${value}</span></li>`)
    .join('')}</ul>`;
}

function sortedEntries(obj) {
  return Object.entries(obj || {}).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
}

function selfiePills(by) {
  return SELFIE_COLOURS.map((c) => `<span class="sf-pill sf-pill--${c}" title="${c}"><b>${by[c] || 0}</b> ${c}</span>`).join('');
}

function playerCard(p, rank) {
  const vpEntries = sortedEntries(p.vp.bySource).map(([k, v]) => [k, v, label(SOURCE_LABEL, k)]);
  const vpMax = vpEntries.length ? vpEntries[0][1] : 0;
  const actionEntries = sortedEntries(p.actions).map(([k, v]) => [k, v, humanise(k)]);
  const actMax = actionEntries.length ? actionEntries[0][1] : 0;
  const earned = sortedEntries(p.coffee.earnedByCause).map(([k, v]) => `${v} ${label(COFFEE_LABEL, k).toLowerCase()}`).join(', ');
  const spent = sortedEntries(p.coffee.spentByCause).map(([k, v]) => `${v} ${humanise(k).toLowerCase()}`).join(', ');
  const ach = p.achievements.length
    ? `<ul class="sf-stats__list">${p.achievements.map((a) => `<li><b>${escapeHtml(a.name)}</b> <span>${a.vp} VP, ${escapeHtml(WHEN_LABEL[a.when] ?? a.when)}, Hour ${Math.min(a.hour, 5)}${a.vp === 0 ? ' (scored for nothing)' : ''}</span></li>`).join('')}</ul>`
    : '<p class="sf-stats__none">None completed.</p>';
  const swag = p.swag.length
    ? `<ul class="sf-stats__list">${p.swag.map((w) => `<li><b>${escapeHtml(w.name)}</b> <span>${w.cost} Selfies, Hour ${Math.min(w.hour, 5)}${w.vp ? `, ${w.vp} VP` : ''}</span></li>`).join('')}</ul>`
    : '<p class="sf-stats__none">None bought.</p>';
  const club = p.club
    ? `<p><b>${escapeHtml(p.club.name)}</b>: used ${p.club.uses} time${p.club.uses === 1 ? '' : 's'}${p.club.vp ? `, worth ${p.club.vp} VP` : ''}${Object.keys(p.club.options).length ? ` (${Object.entries(p.club.options).map(([o, n]) => `${escapeHtml(o)} x${n}`).join(', ')})` : ''}.</p>`
    : '<p class="sf-stats__none">No Club in this game.</p>';
  const celeb = p.celebrityByHour
    .map((v, i) => `<span class="sf-hourchip${v ? ' has' : ''}" title="Hour ${i + 1}"><small>H${i + 1}</small>${v}</span>`)
    .join('');
  const conv = sortedEntries(p.selfies.conversions).map(([k, v]) => `${k} x${v}`).join(', ');
  const seatChip = p.kind === 'bot' ? `<span class="sf-chip sf-chip--bot">${escapeHtml(p.level ?? 'bot')} bot</span>` : p.kind === 'human' ? '<span class="sf-chip sf-chip--human">Human</span>' : '';
  return `<article class="sf-panel sf-pstats sf-pc--${escapeHtml(p.colour)}" data-stats-seat="${p.seat}" aria-label="Stats for ${escapeHtml(p.name)}">
    <header class="sf-pstats__head"><span class="sf-score-marker"></span><h3>${escapeHtml(p.name)}</h3> ${seatChip}<span class="sf-pstats__rank">${rank ? `#${rank}` : ''}</span><span class="sf-pstats__vp"><b>${p.vp.total}</b> VP</span></header>
    <section><h4>Where the VP came from</h4>${bars(vpEntries, vpMax, (k) => SOURCE_COLOUR[k] ?? 'var(--ink-muted)')}</section>
    <section><h4>Celebrity scoring, Hour by Hour</h4><div class="sf-hourchips">${celeb}</div></section>
    <section><h4>Coffee</h4>
      <p class="sf-pstats__big"><b>${p.coffee.earned}</b> earned <span aria-hidden="true">/</span> <b>${p.coffee.spent}</b> spent${p.coffee.lostToCap ? ` <span aria-hidden="true">/</span> <b class="sf-pstats__warn">${p.coffee.lostToCap}</b> lost to the cap` : ''}</p>
      ${earned ? `<p class="sf-stats__fine">Earned from: ${escapeHtml(earned)}.</p>` : ''}${spent ? `<p class="sf-stats__fine">Spent on: ${escapeHtml(spent)}.</p>` : ''}
    </section>
    <section><h4>Selfies</h4>
      <p class="sf-stats__fine">Gained (all sources)</p><div class="sf-pills">${selfiePills(p.selfies.gainedByColour)}</div>
      <p class="sf-stats__fine">Spent</p><div class="sf-pills">${selfiePills(p.selfies.spentByColour)}</div>
      <p class="sf-stats__fine">Photographed on the floor and the Walk: <b>${p.selfies.taken}</b> (${SELFIE_COLOURS.map((c) => `${p.selfies.takenByColour[c] || 0} ${c}`).join(', ')})${conv ? `. Conversions: ${escapeHtml(conv)}` : ''}.</p>
    </section>
    <section><h4>Actions taken <small>${p.actionsTotal} chosen${p.autoActions ? `, ${p.autoActions} automatic` : ''}</small></h4>${bars(actionEntries, actMax, () => 'var(--zone-act-2)')}</section>
    <section><h4>Achievements completed <small>${p.achievementsCompleted}</small></h4>${ach}</section>
    <section><h4>Swag bought <small>${p.swag.length}</small></h4>${swag}</section>
    <section><h4>Club power</h4>${club}</section>
  </article>`;
}

/** The lead chart: cumulative VP of every player at the start and after each Hour, plus Final scoring. */
export function leadChartSvg(stats) {
  const seats = stats.seats;
  const series = [Array(seats.length).fill(0), ...stats.cumulativeVp];
  const labels = ['Start', 'Hour 1', 'Hour 2', 'Hour 3', 'Hour 4', 'Hour 5', 'Final'];
  const W = 720;
  const H = 320;
  const m = { l: 44, r: 20, t: 16, b: 40 };
  const maxVp = Math.max(10, ...series.flat());
  const niceMax = Math.ceil(maxVp / 10) * 10;
  const x = (i) => m.l + (i / (labels.length - 1)) * (W - m.l - m.r);
  const y = (v) => H - m.b - (v / niceMax) * (H - m.t - m.b);
  const grid = [];
  const step = niceMax / 5;
  for (let k = 0; k <= 5; k++) {
    const v = Math.round(step * k);
    grid.push(`<line x1="${m.l}" x2="${W - m.r}" y1="${y(v)}" y2="${y(v)}" class="sf-chart__grid"/><text x="${m.l - 8}" y="${y(v) + 4}" text-anchor="end" class="sf-chart__tick">${v}</text>`);
  }
  const xs = labels.map((t, i) => `<text x="${x(i)}" y="${H - m.b + 20}" text-anchor="middle" class="sf-chart__tick">${t}</text>`).join('');
  const lines = seats
    .map((p) => {
      const pts = series.map((row, i) => `${x(i).toFixed(1)},${y(row[p.seat]).toFixed(1)}`).join(' ');
      const dots = series
        .map((row, i) => {
          const led = i > 0 && stats.leaders[i - 1] === p.seat;
          return `<circle cx="${x(i).toFixed(1)}" cy="${y(row[p.seat]).toFixed(1)}" r="${led ? 6 : 3.5}" class="sf-chart__dot${led ? ' is-lead' : ''}"><title>${escapeHtml(p.name)}: ${row[p.seat]} VP after ${labels[i]}${led ? ' (leading)' : ''}</title></circle>`;
        })
        .join('');
      return `<g class="sf-pc--${escapeHtml(p.colour)} sf-chart__series" data-series="${p.seat}"><polyline points="${pts}" class="sf-chart__line"/>${dots}</g>`;
    })
    .join('');
  const legend = seats.map((p) => `<span class="sf-pc--${escapeHtml(p.colour)}"><i class="sf-chart__key"></i>${escapeHtml(p.name)}</span>`).join('');
  const ledBy = stats.leaders.map((s, i) => `<span class="sf-leadchip${s === null ? ' is-tie' : ''}">${labels[i + 1]}: <b>${s === null ? 'tied' : escapeHtml(seats[s].name)}</b></span>`).join('');
  return `<figure class="sf-chart" data-chart="lead">
    <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Victory points of each player after each Hour. Large dots mark who led.">
      <title>VP after each Hour</title>${grid.join('')}${xs}${lines}
    </svg>
    <figcaption><div class="sf-chart__legend">${legend}</div><div class="sf-chart__lead">Who led: ${ledBy}</div><div class="sf-stats__fine">${stats.leadChanges} lead change${stats.leadChanges === 1 ? '' : 's'} over the game (counted VP award by VP award). Large dots show the leader after each Hour; Final includes the last Achievement and leftover Selfies.</div></figcaption>
  </figure>`;
}

/** The celebrity table: who scored what at each destination. */
function celebrityTable(stats) {
  if (!stats.celebrities.length) return '';
  const head = stats.seats.map((p) => `<th class="sf-pc--${escapeHtml(p.colour)}">${escapeHtml(p.name)}</th>`).join('');
  const rows = stats.celebrities
    .map((c) => `<tr><td>Hour ${c.hour}</td><td>${escapeHtml(c.name)}</td><td>${escapeHtml(hallName(c.hall))}</td><td>${c.queueLen}</td>${c.totals.map((v) => `<td>${v || '-'}</td>`).join('')}</tr>`)
    .join('');
  return `<details class="sf-celebtable"><summary>Every celebrity scoring</summary><div class="sf-table-wrap"><table class="sf-table"><thead><tr><th>Hour</th><th>Celebrity</th><th>Hall</th><th>Queue</th>${head}</tr></thead><tbody>${rows}</tbody></table></div></details>`;
}

/**
 * @param {object} stats collectStats() result
 * @param {{ seat: number, rank: number }[]} ranks from scoreGame, to order the cards
 * @returns {string} markup of the Stats tab body
 */
export function renderStats(stats, ranks = []) {
  if (!stats || !Array.isArray(stats.seats) || !stats.seats.length) return '<p class="sf-stats__none">No stats are available for this game.</p>';
  const rankOf = new Map(ranks.map((r) => [r.seat, r.rank]));
  const order = [...stats.seats].sort((a, b) => (rankOf.get(a.seat) ?? a.seat) - (rankOf.get(b.seat) ?? b.seat));
  const best = stats.biggestPayout;
  const note = best
    ? `<p class="sf-stats__fine">Biggest single payout: <b>${best.vp} VP</b> to ${escapeHtml(stats.seats[best.seat].name)} at ${escapeHtml(hallName(best.hall))} in Hour ${best.hour}.</p>`
    : '';
  return `<div class="sf-statstab" data-statstab>
    <section class="sf-panel"><h3 class="sf-panel__title" style="font-size:var(--fs-lg)">${art(ICON.trophy, { alt: '' })} Lead over time</h3>${leadChartSvg(stats)}${note}</section>
    <div class="sf-pstats__grid">${order.map((p) => playerCard(p, rankOf.get(p.seat))).join('')}</div>
    ${celebrityTable(stats)}
  </div>`;
}

/** Wires the Scores / Stats tab buttons (delegated, installed once). */
export function installEndTabs() {
  if (typeof document === 'undefined' || installEndTabs.done) return;
  installEndTabs.done = true;
  document.addEventListener('click', (e) => {
    const b = e.target instanceof Element ? e.target.closest('[data-end-tab]') : null;
    if (!b) return;
    const page = b.closest('.sf-end');
    if (!page) return;
    const which = b.dataset.endTab;
    page.querySelectorAll('[data-end-tab]').forEach((x) => {
      const on = x.dataset.endTab === which;
      x.classList.toggle('is-selected', on);
      x.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    page.querySelectorAll('[data-end-panel]').forEach((panel) => {
      panel.hidden = panel.dataset.endPanel !== which;
    });
  });
}
