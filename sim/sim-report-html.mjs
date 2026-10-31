// sim-report-html.mjs - one self-contained HTML report from simulator output files.
//
//   node sim/sim-report-html.mjs <sim-output.json> [more.json ...] [--name=<label>] [--out=<file.html>] [--title="..."]
//
// Each input file (one player count, one bot setup) becomes one "run" column/panel. The report is
// recomputed from the per-game records with aggregate() (sim/aggregate.mjs), and the OK/WARN
// verdicts come from sim/health.mjs: no thresholds are duplicated here.
//
// Output goes OUTSIDE the repo, default
//   <system temp dir>/superfans-sim-reports/<name>.html   (pass --out=<file.html> to choose)
// and is never overwritten: if the file exists, -v2, -v3 ... is appended.
// Everything is inline (SVG charts, CSS, a little vanilla JS); the page opens offline.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, dirname, join, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { aggregate } from './aggregate.mjs';

const DEFAULT_DIR = join(tmpdir(), 'superfans-sim-reports');

// ---- small helpers -------------------------------------------------------------------

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const num = (x) => typeof x === 'number' && Number.isFinite(x);
const f = (x, d = 1) => (num(x) ? x.toFixed(d) : '-');
const pc = (x, d = 0) => (num(x) ? `${(x * 100).toFixed(d)}%` : '-');
const sg = (x) => (num(x) ? `${x >= 0 ? '+' : ''}${x.toFixed(1)}σ` : '');
const sum = (xs) => xs.reduce((a, b) => a + b, 0);

/** Short, distinct colour classes for categorical series (CSS vars, light and dark). */
const NCOLOURS = 10;
const cc = (i) => `c${i % NCOLOURS}`;

// ---- SVG chart primitives ------------------------------------------------------------

const W = 720;

function svgWrap(h, label, body) {
  return `<svg class="chart" viewBox="0 0 ${W} ${h}" role="img" aria-label="${esc(label)}" preserveAspectRatio="xMinYMin meet">${body}</svg>`;
}

function legend(keys, colourOf) {
  return `<ul class="legend">${keys.map((k) => `<li><span class="sw ${colourOf(k)}"></span>${esc(k)}</li>`).join('')}</ul>`;
}

/** Horizontal stacked bars. rows: [{label, segs:[{key, value, idx}]}], total scale = max row total. */
function stackedH(rows, { unit = '', label = '', minLabel = 0.07, fmt = (v) => f(v, 1), scaleMax = null } = {}) {
  const left = 150;
  const right = 70;
  const rowH = 30;
  const top = 6;
  const h = top + rows.length * rowH + 22;
  const inner = W - left - right;
  const max = scaleMax ?? Math.max(1e-9, ...rows.map((r) => sum(r.segs.map((s) => s.value))));
  let out = '';
  rows.forEach((r, i) => {
    const y = top + i * rowH;
    out += `<text class="axl" x="${left - 8}" y="${y + 19}" text-anchor="end">${esc(r.label)}</text>`;
    let x = left;
    for (const s of r.segs) {
      const w = (s.value / max) * inner;
      if (w <= 0) continue;
      out += `<rect class="${cc(s.idx)}" x="${x.toFixed(1)}" y="${y + 3}" width="${w.toFixed(1)}" height="${rowH - 8}"><title>${esc(r.label)}: ${esc(s.key)} ${esc(fmt(s.value))}${esc(unit)}</title></rect>`;
      if (w / inner >= minLabel) out += `<text class="vl" x="${(x + w / 2).toFixed(1)}" y="${y + 19}" text-anchor="middle">${esc(fmt(s.value))}</text>`;
      x += w;
    }
    out += `<text class="axl" x="${x + 6}" y="${y + 19}">${esc(fmt(sum(r.segs.map((s) => s.value))))}${esc(unit)}</text>`;
  });
  return svgWrap(h, label, out);
}

/** Vertical stacked columns. cols: [{label, segs:[{key,value,idx}]}]. */
function stackedV(cols, { label = '', fmt = (v) => f(v, 0), height = 190 } = {}) {
  const left = 44;
  const bottom = 26;
  const top = 8;
  const h = height + bottom + top;
  const inner = W - left - 10;
  const max = Math.max(1e-9, ...cols.map((c) => sum(c.segs.map((s) => s.value))));
  const step = inner / cols.length;
  const bw = Math.min(70, step * 0.62);
  let out = axisY(left, top, height, max, W - 10, fmt);
  cols.forEach((c, i) => {
    const cx = left + step * i + step / 2;
    let y = top + height;
    for (const s of c.segs) {
      const hh = (s.value / max) * height;
      if (hh <= 0) continue;
      y -= hh;
      out += `<rect class="${cc(s.idx)}" x="${(cx - bw / 2).toFixed(1)}" y="${y.toFixed(1)}" width="${bw.toFixed(1)}" height="${hh.toFixed(1)}"><title>${esc(c.label)}: ${esc(s.key)} ${esc(fmt(s.value))}</title></rect>`;
    }
    out += `<text class="axl" x="${cx.toFixed(1)}" y="${top + height + 17}" text-anchor="middle">${esc(c.label)}</text>`;
  });
  return svgWrap(h, label, out);
}

function axisY(left, top, height, max, right, fmt) {
  let out = '';
  const ticks = 4;
  for (let i = 0; i <= ticks; i++) {
    const v = (max * i) / ticks;
    const y = top + height - (height * i) / ticks;
    out += `<line class="grid" x1="${left}" x2="${right}" y1="${y.toFixed(1)}" y2="${y.toFixed(1)}"/>`;
    out += `<text class="axl" x="${left - 6}" y="${(y + 4).toFixed(1)}" text-anchor="end">${esc(fmt(v))}</text>`;
  }
  return out;
}

/**
 * Vertical grouped bars. groups: [{label, bars:[{label, value, idx, err?, note?}]}]. err = half-width of the whisker.
 * refLine = { value, label } dashed horizontal line.
 */
function barsV(groups, { label = '', fmt = (v) => f(v, 0), height = 190, max = null, refLine = null } = {}) {
  const left = 48;
  const bottom = 34;
  const top = 14;
  const h = height + bottom + top;
  const inner = W - left - 10;
  const all = groups.flatMap((g) => g.bars);
  const m = max ?? Math.max(1e-9, ...all.map((b) => b.value + (b.err ?? 0)), refLine ? refLine.value : 0) * 1.08;
  const gstep = inner / groups.length;
  let out = axisY(left, top, height, m, W - 10, fmt);
  groups.forEach((g, gi) => {
    const gx = left + gstep * gi;
    const bstep = (gstep * 0.84) / g.bars.length;
    const bw = Math.min(46, bstep * 0.8);
    g.bars.forEach((b, bi) => {
      const cx = gx + gstep * 0.08 + bstep * bi + bstep / 2;
      const hh = (b.value / m) * height;
      const y = top + height - hh;
      out += `<rect class="${cc(b.idx ?? 0)}" x="${(cx - bw / 2).toFixed(1)}" y="${y.toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(0, hh).toFixed(1)}"><title>${esc(g.label)} ${esc(b.label)}: ${esc(fmt(b.value))}${b.note ? ` (${esc(b.note)})` : ''}</title></rect>`;
      if (num(b.err)) {
        const y1 = top + height - ((b.value + b.err) / m) * height;
        const y2 = top + height - (Math.max(0, b.value - b.err) / m) * height;
        out += `<g class="err"><line x1="${cx.toFixed(1)}" x2="${cx.toFixed(1)}" y1="${y1.toFixed(1)}" y2="${y2.toFixed(1)}"/><line x1="${(cx - 5).toFixed(1)}" x2="${(cx + 5).toFixed(1)}" y1="${y1.toFixed(1)}" y2="${y1.toFixed(1)}"/><line x1="${(cx - 5).toFixed(1)}" x2="${(cx + 5).toFixed(1)}" y1="${y2.toFixed(1)}" y2="${y2.toFixed(1)}"/></g>`;
      }
      out += `<text class="axl" x="${cx.toFixed(1)}" y="${top + height + 14}" text-anchor="middle">${esc(b.label)}</text>`;
      if (b.note) out += `<text class="axl dim" x="${cx.toFixed(1)}" y="${top + height + 27}" text-anchor="middle">${esc(b.note)}</text>`;
    });
    if (groups.length > 1 && g.label) out += `<text class="axl grp" x="${(gx + gstep / 2).toFixed(1)}" y="${top - 3}" text-anchor="middle">${esc(g.label)}</text>`;
  });
  if (refLine) {
    const y = top + height - (refLine.value / m) * height;
    out += `<line class="ref" x1="${left}" x2="${W - 10}" y1="${y.toFixed(1)}" y2="${y.toFixed(1)}"/><text class="axl ref-l" x="${W - 12}" y="${(y - 4).toFixed(1)}" text-anchor="end">${esc(refLine.label)}</text>`;
  }
  return svgWrap(h, label, out);
}

/** Simple line chart with markers. series: [{name, idx, points:[number|null]}], xLabels. */
function lines(series, xLabels, { label = '', fmt = (v) => f(v, 1), height = 190 } = {}) {
  const left = 48;
  const bottom = 26;
  const top = 10;
  const h = height + bottom + top;
  const inner = W - left - 20;
  const vals = series.flatMap((s) => s.points).filter(num);
  const max = Math.max(1e-9, ...vals) * 1.1;
  const step = inner / Math.max(1, xLabels.length - 1);
  let out = axisY(left, top, height, max, W - 20, fmt);
  xLabels.forEach((l, i) => {
    out += `<text class="axl" x="${(left + 10 + step * i * (inner - 20) / inner).toFixed(1)}" y="${top + height + 17}" text-anchor="middle">${esc(l)}</text>`;
  });
  const px = (i) => left + 10 + (step * i * (inner - 20)) / inner;
  for (const s of series) {
    const pts = s.points.map((v, i) => (num(v) ? [px(i), top + height - (v / max) * height, v, i] : null)).filter(Boolean);
    out += `<polyline class="ln s${s.idx % NCOLOURS}" points="${pts.map((p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ')}"/>`;
    for (const p of pts) out += `<circle class="${cc(s.idx)}" cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="4"><title>${esc(s.name)} ${esc(xLabels[p[3]])}: ${esc(fmt(p[2]))}</title></circle>`;
  }
  return svgWrap(h, label, out);
}

// ---- tables --------------------------------------------------------------------------

/** cols: [{h, align?}], rows: [[cell]] where cell = value or {t: text, v: sortValue, cls}. */
function table(cols, rows, { sortable = true, id = '' } = {}) {
  const head = cols.map((c, i) => `<th${sortable ? ` data-col="${i}" tabindex="0" role="columnheader" aria-sort="none"` : ''} class="${c.align === 'l' ? 'l' : ''}">${esc(c.h)}</th>`).join('');
  const body = rows
    .map((r) => `<tr>${r.map((c, i) => {
      const o = c !== null && typeof c === 'object' ? c : { t: c };
      const v = o.v !== undefined ? o.v : o.t;
      return `<td class="${cols[i].align === 'l' ? 'l' : ''} ${o.cls ?? ''}" data-v="${esc(v)}">${o.html ?? esc(o.t)}</td>`;
    }).join('')}</tr>`)
    .join('');
  return `<div class="tw"><table class="${sortable ? 'sortable' : ''}"${id ? ` id="${id}"` : ''}><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}

const badge = (status) => `<span class="badge ${status === 'OK' ? 'ok' : status === 'WARN' ? 'warn' : 'na'}">${esc(status)}</span>`;

function winCell(rate, sigma) {
  if (!num(rate)) return { t: '-', v: -1 };
  const flag = num(sigma) && Math.abs(sigma) >= 2;
  return { t: `${pc(rate)} ${sg(sigma)}`, v: rate, cls: flag ? 'flag' : '' };
}

// ---- runs ----------------------------------------------------------------------------

function loadRun(file) {
  const data = JSON.parse(readFileSync(resolve(file), 'utf8'));
  if (data.schema !== 'superfans-sim-v1') throw new Error(`${file}: expected schema superfans-sim-v1, got ${data.schema}`);
  const a = aggregate(data.games, { players: data.players });
  const bots = [...new Set(data.plan.levels ?? [])].join('/');
  const analysed = data.games.filter((g) => !g.failed && !g.turnCapped);
  return { file, data, a, bots, analysed, id: `${data.players}p-${bots}`, label: `${data.players}p ${bots}` };
}

// ---- sections ------------------------------------------------------------------------

function sectionProvenance(runs) {
  const rows = runs.map(({ data, a, bots, label, file }) => {
    const p = data.plan;
    const v = Object.entries(p.variants ?? {}).map(([k, x]) => `${k}=${x}`).join(', ') || 'defaults';
    const k = (p.constantFlags ?? []).join(', ') || 'defaults';
    return [label, data.players, bots, p.games, a.counts.analysed, p.jitter, p.seed, p.rotate ? 'rotating' : 'fixed', v, k, p.label || '-', data.meta?.rulesId ?? '-', (data.meta?.generated ?? '').slice(0, 10), basename(file)];
  });
  return `<section id="provenance"><h2>1. What produced this report</h2>
<p class="note">Every number below comes from the files listed here. Bots, seed, variants and constants are as recorded in each file&rsquo;s plan; games that were turn-capped or failed are excluded from means (see the health table for counts).</p>
${table([{ h: 'run', align: 'l' }, { h: 'players' }, { h: 'bots', align: 'l' }, { h: 'games' }, { h: 'analysed' }, { h: 'jitter' }, { h: 'seed', align: 'l' }, { h: 'seats', align: 'l' }, { h: 'variants', align: 'l' }, { h: 'constants', align: 'l' }, { h: 'label', align: 'l' }, { h: 'rules', align: 'l' }, { h: 'generated', align: 'l' }, { h: 'file', align: 'l' }], rows)}</section>`;
}

function sectionHealth(runs) {
  const ids = runs[0].a.health.map((h) => h.id);
  const rows = ids.map((id) => {
    const first = runs.find((r) => r.a.health.find((h) => h.id === id)).a.health.find((h) => h.id === id);
    const cells = runs.map((r) => {
      const h = r.a.health.find((x) => x.id === id);
      if (!h) return { t: '-', v: '' };
      const val = !num(h.value) ? '-' : h.unit === '%' ? `${f(h.value, 1)}%` : f(h.value, h.unit === 'games' || h.unit === 'subsystems' ? 0 : 2);
      const sig = num(h.sigma) ? ` (${sg(h.sigma)})` : '';
      const det = h.detail && String(h.detail).length <= 24 ? ` ${h.detail}` : '';
      return { html: `${esc(val + sig + det)} ${badge(h.status)}`, v: num(h.value) ? h.value : -1, cls: h.status === 'WARN' ? 'warnc' : '' };
    });
    return [{ t: first.label }, { t: first.healthy }, ...cells];
  });
  const warns = runs.flatMap((r) => r.a.health.filter((h) => h.status === 'WARN').map((h) => ({ run: r.label, h })));
  const notes = warns.length
    ? `<h3>Why the WARNs matter</h3><ul class="warnlist">${warns.map((w) => `<li><b>${esc(w.run)}</b> &mdash; ${esc(w.h.label)}: ${esc(w.h.bad)}${w.h.detail && String(w.h.detail).length > 24 ? ` <span class="dim">(${esc(w.h.detail)})</span>` : ''}</li>`).join('')}</ul>`
    : '<p>No WARN rows.</p>';
  const counts = runs.map((r) => [r.label, r.a.counts.games, r.a.counts.analysed, r.a.counts.turnLimit, r.a.counts.decisionCapHits, r.a.counts.refusals, r.a.counts.errors, r.a.counts.integrity]);
  return `<section id="health"><h2>2. Summary health table</h2>
<p class="note">Thresholds are read from <code>sim/health.mjs</code> (the web-board-game skill table). Status is always printed as text as well as colour.</p>
${table([{ h: 'metric', align: 'l' }, { h: 'healthy', align: 'l' }, ...runs.map((r) => ({ h: r.label }))], rows)}
${notes}
<h3>Run integrity</h3>
${table([{ h: 'run', align: 'l' }, { h: 'games' }, { h: 'analysed' }, { h: 'turn-capped' }, { h: 'decision cap' }, { h: 'refusals' }, { h: 'crashes' }, { h: 'bookkeeping' }], counts)}</section>`;
}

function histogram(values, step, max) {
  const n = Math.ceil((max + 1) / step);
  const bins = Array.from({ length: n }, (_, i) => ({ lo: i * step, n: 0 }));
  for (const v of values) bins[Math.min(n - 1, Math.floor(v / step))].n++;
  return bins;
}

function sectionScores(runs) {
  const step = 10;
  const all = runs.flatMap((r) => r.analysed.flatMap((g) => g.scores));
  const maxScore = Math.max(10, ...all);
  const charts = runs
    .map((r) => {
      const win = r.analysed.map((g) => Math.max(...g.scores));
      const every = r.analysed.flatMap((g) => g.scores);
      const hAll = histogram(every, step, maxScore);
      const hWin = histogram(win, step, maxScore);
      // trim empty tail
      let last = hAll.length - 1;
      while (last > 0 && hAll[last].n === 0) last--;
      const cols = hAll.slice(0, last + 1).map((b, i) => ({
        label: `${b.lo}`,
        segs: [
          { key: 'winning scores', value: hWin[i].n, idx: 0 },
          { key: 'other scores', value: b.n - hWin[i].n, idx: 8 },
        ],
      }));
      const S = r.a.scores;
      return `<div class="panel"><h3>${esc(r.label)}</h3>${stackedV(cols, { label: `Score distribution ${r.label}`, fmt: (v) => String(Math.round(v)) })}
<p class="note">Bins of ${step} VP (label = lower edge). Winner mean ${f(S.winning.mean)} (sd ${f(S.winning.sd)}), all-score mean ${f(S.all.mean)}; margin ${f(r.a.margin.marginPct.mean)}% of winner, ${pc(r.a.margin.within10.value)} of games inside 10%.</p></div>`;
    })
    .join('');
  const rankRows = runs.flatMap((r) => r.a.scores.byRank.map((x) => [r.label, x.rank, f(x.mean), f(x.sd), f(x.min, 0), f(x.max, 0)]));
  return `<section id="scores"><h2>3. Score distributions</h2>${legend(['winning scores', 'other scores'], (k) => (k === 'winning scores' ? 'c0' : 'c8'))}<div class="grid2">${charts}</div>
<h3>Score by finishing rank</h3>${table([{ h: 'run', align: 'l' }, { h: 'rank' }, { h: 'mean' }, { h: 'sd' }, { h: 'min' }, { h: 'max' }], rankRows)}</section>`;
}

function sectionVp(runs) {
  const sources = [...new Set(runs.flatMap((r) => r.a.vpSources.rows.map((x) => x.source)))];
  const idx = (s) => sources.indexOf(s);
  const rows = runs.map((r) => ({
    label: r.label,
    segs: sources.map((s) => ({ key: s, value: r.a.vpSources.rows.find((x) => x.source === s)?.meanPerPlayer ?? 0, idx: idx(s) })),
  }));
  const perHour = runs
    .map((r) => {
      const cols = r.a.vpSources.byBucket.map((b) => ({
        label: b.bucket.replace('Final scoring', 'Final'),
        segs: sources.map((s) => ({ key: s, value: (b.shares[s] ?? 0) * 100, idx: idx(s) })),
      }));
      return `<div class="panel"><h3>${esc(r.label)}: share of each Hour&rsquo;s VP</h3>${stackedV(cols, { label: `VP source share per Hour ${r.label}`, fmt: (v) => `${Math.round(v)}%`, height: 170 })}</div>`;
    })
    .join('');
  const tableRows = runs.flatMap((r) => r.a.vpSources.rows.map((x) => [r.label, x.source, { t: pc(x.share, 1), v: x.share, cls: x.share >= 0.45 ? 'flag' : '' }, f(x.meanPerPlayer), f(x.winnerMean), f(x.otherMean), { t: f(x.winnerMean - x.otherMean), v: x.winnerMean - x.otherMean }]));
  return `<section id="vp"><h2>4. VP by source</h2>
<p class="note">Mean VP per player per game, stacked by source (from VP events). A single source above 45% is a WARN in the health table.</p>
${legend(sources, (s) => cc(idx(s)))}${stackedH(rows, { unit: '', label: 'Mean VP per player by source and run' })}
<h3>Share of each Hour&rsquo;s VP</h3><div class="grid2">${perHour}</div>
<h3>Table</h3>${table([{ h: 'run', align: 'l' }, { h: 'source', align: 'l' }, { h: 'share' }, { h: 'VP/player' }, { h: 'winner mean' }, { h: 'others mean' }, { h: 'winner - others' }], tableRows)}</section>`;
}

function sectionSeats(runs) {
  const panels = runs
    .map((r) => {
      const X = r.a.seats;
      const fair = 1 / r.a.players;
      const mk = (x, nameKey, i, idx) => {
        const n = x.n;
        const se = Math.sqrt((x.rate * (1 - x.rate)) / n);
        return { label: `${nameKey}${x[nameKey === 'S' ? 'seat' : 'position']}`, value: x.rate * 100, err: 2 * se * 100, idx, note: sg(x.sigma) };
      };
      const groups = [
        { label: 'by seat', bars: X.seat.map((x, i) => mk(x, 'S', i, 0)) },
        { label: 'by turn-order position (1 = Hour 1 first player)', bars: X.position.map((x, i) => mk(x, 'P', i, 1)) },
      ];
      return `<div class="panel"><h3>${esc(r.label)}</h3>${barsV(groups, { label: `Seat win rates ${r.label}`, fmt: (v) => `${Math.round(v)}%`, refLine: { value: fair * 100, label: `fair ${f(fair * 100, 1)}%` } })}
<p class="note">Whiskers = &plusmn;2 standard errors of the observed rate (n = ${X.seat[0].n}). Label under each bar = sigma from the fair share, which is what the health table judges (largest seat deviation ${f(X.maxSeatSigma, 2)}σ).</p></div>`;
    })
    .join('');
  const rows = runs.flatMap((r) => [
    ...r.a.seats.seat.map((x) => [r.label, `seat ${x.seat}`, x.wins, winCell(x.rate, x.sigma), f(x.meanRank, 2)]),
    ...r.a.seats.position.map((x) => [r.label, `position ${x.position}`, x.wins, winCell(x.rate, x.sigma), '-']),
  ]);
  const levelNote = runs.some((r) => r.a.levels?.mixed)
    ? '<h3>Win rate by bot level (mixed-level runs)</h3>' + table([{ h: 'run', align: 'l' }, { h: 'level', align: 'l' }, { h: 'seats' }, { h: 'wins' }, { h: 'win rate vs expected' }, { h: 'expected' }, { h: 'mean score' }], runs.filter((r) => r.a.levels?.mixed).flatMap((r) => r.a.levels.rows.map((x) => [r.label, x.level, x.seats, x.wins, winCell(x.rate, x.sigma), pc(x.expected), f(x.meanScore)])))
    : '';
  return `<section id="seats"><h2>5. Seat win rates</h2><div class="grid2">${panels}</div>${table([{ h: 'run', align: 'l' }, { h: 'who', align: 'l' }, { h: 'wins' }, { h: 'win rate (sigma)' }, { h: 'mean rank' }], rows)}${levelNote}</section>`;
}

/** One toggled panel per run so the long card tables do not multiply the page. */
function perRunTables(id, runs, build) {
  const opts = runs.map((r, i) => `<option value="${id}-${i}">${esc(r.label)}</option>`).join('');
  const body = runs.map((r, i) => `<div class="runtab" data-group="${id}" id="${id}-${i}"${i ? ' hidden' : ''}>${build(r)}</div>`).join('');
  return `<label class="pick">Run: <select data-group="${id}">${opts}</select></label>${body}`;
}

function sectionCards(runs) {
  const ach = perRunTables('ach', runs, (r) => `<h3>Achievements (${esc(r.label)})</h3><p class="note">held = dealt at any time; completed = scored for 1+ VP; win% = share of completions by the eventual winner (fair = 1/players, shaded = 2σ or more).</p>` +
    table([{ h: 'card', align: 'l' }, { h: 'name', align: 'l' }, { h: 'laurel' }, { h: 'held' }, { h: 'scored' }, { h: 'completed' }, { h: 'completion' }, { h: 'mean VP' }, { h: 'tripled' }, { h: 'discarded' }, { h: 'n' }, { h: 'win% (sigma)' }],
      r.a.cards.achievements.map((c) => [c.id.replace('scoring_', ''), c.name, c.laurel, c.held, c.scored, { t: c.completed, cls: c.held > 0 && c.completed === 0 ? 'flag' : '' }, { t: pc(c.completionRate), v: c.completionRate }, f(c.meanVp), c.tripled, c.discarded, c.winN, winCell(c.winRate, c.winSigma)])));
  const swag = perRunTables('swag', runs, (r) => `<h3>Swag (${esc(r.label)})</h3><p class="note">buy rate = purchases per game in which the card was in the market; win% = share of buyers who won.</p>` +
    table([{ h: 'card', align: 'l' }, { h: 'name', align: 'l' }, { h: 'colour', align: 'l' }, { h: 'cost' }, { h: 'seen' }, { h: 'bought' }, { h: 'buy rate' }, { h: 'mean Hour' }, { h: 'VP' }, { h: 'n' }, { h: 'buyer win% (sigma)' }],
      r.a.cards.swag.map((c) => [c.id.replace('swag_', ''), c.name, c.colour, c.cost, c.gamesSeen, { t: c.bought, cls: c.gamesSeen > 0 && c.bought === 0 ? 'flag' : '' }, { t: pc(c.buyRate), v: c.buyRate }, f(c.meanHour), c.vp, c.winN, winCell(c.winRate, c.winSigma)])));
  const clubs = perRunTables('clubs', runs, (r) => `<h3>Clubs (${esc(r.label)})</h3><p class="note">holder win% = share of games won by the seat holding the Club.</p>` +
    table([{ h: 'club', align: 'l' }, { h: 'name', align: 'l' }, { h: 'held' }, { h: 'uses / holder' }, { h: 'used in game' }, { h: 'VP' }, { h: 'holder mean score' }, { h: 'holder win% (sigma)' }],
      r.a.cards.clubs.map((c) => [c.id.replace('club_', ''), c.name, c.holders, f(c.usesPerHolder, 2), { t: pc(c.usedInGameShare), v: c.usedInGameShare }, c.vp, f(c.meanScoreHolder), winCell(c.winRate, c.winSigma)])));
  const celeb = perRunTables('celeb', runs, (r) => `<h3>Celebrities (${esc(r.label)})</h3><p class="note">winner share = fraction of the card&rsquo;s VP won by the eventual winner (fair ${pc(r.a.cards.celebrityRollups.fairWinnerShare)}); top-scorer wins = how often whoever scored most at it won the game.</p>` +
    table([{ h: 'card', align: 'l' }, { h: 'name', align: 'l' }, { h: 'rank', align: 'l' }, { h: 'method', align: 'l' }, { h: 'in schedule' }, { h: 'scored' }, { h: 'mean VP' }, { h: 'queue' }, { h: 'scoring crew' }, { h: 'winner share' }, { h: 'top-scorer wins (n)' }],
      r.a.cards.celebrities.map((c) => [c.id.replace('character_', ''), c.name, c.rank, c.method, c.appeared, c.scored, f(c.meanVp), f(c.meanQueue, 1), f(c.meanScoringCrew, 1), { t: pc(c.winnerShare), v: c.winnerShare }, { t: c.topN ? `${pc(c.topScorerWins)} (${c.topN})` : '-', v: c.topN ? c.topScorerWins : -1, cls: num(c.topSigma) && Math.abs(c.topSigma) >= 2 ? 'flag' : '' }])));
  return `<section id="cards"><h2>6. Per-card usage and win correlation</h2>
<p class="note">Click a column heading to sort. Win correlation compares a rate with 1/players; shaded cells are 2 sigma or more away, but with small n (the &ldquo;n&rdquo; column) treat them as hints, not findings. Pick which run to show.</p>
<h3 class="sub">Achievements</h3>${ach}<h3 class="sub">Swag</h3>${swag}<h3 class="sub">Clubs</h3>${clubs}<h3 class="sub">Celebrities</h3>${celeb}</section>`;
}

function sectionBranching(runs) {
  const hours = runs[0].a.branching.byHour.map((h) => h.name.replace('Final scoring', 'Final'));
  const turnStart = runs.map((r, i) => ({ name: r.label, idx: i, points: r.a.branching.turnStartByHour.map((h) => (h.n ? h.options : null)) }));
  const types = runs.map((r, i) => ({ name: r.label, idx: i, points: r.a.branching.turnStartByHour.map((h) => (h.n ? h.types : null)) }));
  const all = runs.map((r, i) => ({ name: r.label, idx: i, points: r.a.branching.byHour.map((h) => h.options) }));
  const leg = legend(runs.map((r) => r.label), (k) => cc(runs.findIndex((r) => r.label === k)));
  const rows = runs.flatMap((r) => r.a.branching.byHour.map((h, i) => [r.label, h.name, h.n, f(h.options), f(h.types, 2), f(r.a.branching.turnStartByHour[i].options), f(r.a.branching.turnStartByHour[i].types, 2)]));
  const ts = runs.map((r) => [r.label, ...r.a.branching.turnStartByType.map((t) => `${t.type} ${pc(t.offeredShare)}`).slice(0, 0)]);
  void ts;
  return `<section id="branching"><h2>7. Branching by Hour</h2>
<p class="note">Legal actions the engine offers. &ldquo;Turn start&rdquo; counts only the first decision of a turn (the health table&rsquo;s figure). Move 2 and Volunteer list one action per Crew x destination, so large numbers are partly by construction.</p>
${leg}<div class="grid2"><div class="panel"><h3>Legal actions at a turn&rsquo;s first decision</h3>${lines(turnStart, hours, { label: 'Turn-start legal actions by Hour' })}</div>
<div class="panel"><h3>Distinct action types at a turn&rsquo;s first decision</h3>${lines(types, hours, { label: 'Turn-start distinct types by Hour', fmt: (v) => f(v, 1) })}</div>
<div class="panel"><h3>Legal actions at every decision</h3>${lines(all, hours, { label: 'All-decision legal actions by Hour' })}</div></div>
${table([{ h: 'run', align: 'l' }, { h: 'Hour', align: 'l' }, { h: 'decisions' }, { h: 'mean legal' }, { h: 'types' }, { h: 'turn-start legal' }, { h: 'turn-start types' }], rows)}</section>`;
}

function sectionLeads(runs) {
  const panels = runs
    .map((r) => {
      const hist = r.a.leads.histogram;
      const groups = [{ label: '', bars: hist.map((b) => ({ label: b.hi === null ? `${b.lo}+` : b.hi - b.lo > 1 ? `${b.lo}-${b.hi - 1}` : `${b.lo}`, value: b.n, idx: 3 })) }];
      return `<div class="panel"><h3>${esc(r.label)}</h3>${barsV(groups, { label: `Lead changes per game ${r.label}`, fmt: (v) => String(Math.round(v)), height: 170 })}
<p class="note">Mean ${f(r.a.leads.leadChanges.mean, 2)} lead changes per game (median ${f(r.a.leads.leadChanges.median, 0)}, max ${f(r.a.leads.leadChanges.max, 0)}). Bars count games; bin widths grow at the right.</p></div>`;
    })
    .join('');
  const rows = runs.flatMap((r) => r.a.pacing.leaderAfterHourWins.map((l) => [r.label, `Hour ${l.afterHour}`, l.n, winCell(l.rate, l.sigma)]));
  return `<section id="leads"><h2>8. Lead-change histogram</h2><div class="grid2">${panels}</div>
<h3>Does the sole leader after each Hour go on to win?</h3>${table([{ h: 'run', align: 'l' }, { h: 'after', align: 'l' }, { h: 'n' }, { h: 'leader wins (sigma)' }], rows)}</section>`;
}

function sectionCoffee(runs) {
  const causes = [...new Set(runs.flatMap((r) => [...Object.keys(r.a.economy.coffeeEarned), ...Object.keys(r.a.economy.coffeeLostToCap)]))];
  const cidx = (c) => causes.indexOf(c);
  const lost = runs.map((r) => ({ label: r.label, segs: causes.map((c) => ({ key: c, value: r.a.economy.coffeeLostToCap[c] ?? 0, idx: cidx(c) })) }));
  const earned = runs.map((r) => ({ label: r.label, segs: causes.map((c) => ({ key: c, value: r.a.economy.coffeeEarned[c] ?? 0, idx: cidx(c) })) }));
  const sc = Math.max(...earned.map((e) => sum(e.segs.map((s) => s.value))), ...lost.map((e) => sum(e.segs.map((s) => s.value))));
  const rows = runs.map((r) => {
    const E = r.a.economy;
    return [r.label, f(E.coffeeEarnedTotal), f(E.coffeeLostTotal), { t: pc(E.coffeeWasteShare, 1), v: E.coffeeWasteShare, cls: E.coffeeWasteShare >= 0.3 ? 'flag' : '' }, f(E.coffeeSpentTotal), ...E.coffeeHeldAtFloorEnd.slice(0, 5).map((x) => f(x, 1))];
  });
  return `<section id="coffee"><h2>9. Coffee lost to the cap</h2>
<p class="note">Per player per game. &ldquo;Earned&rdquo; is coffee actually kept; &ldquo;lost&rdquo; is coffee offered but cut by the cap. The waste share is lost / (earned + lost). Shaded when 30% or more is wasted.</p>
${legend(causes, (c) => cc(cidx(c)))}
<h3>Coffee lost to the cap, by cause</h3>${stackedH(lost, { label: 'Coffee lost to cap by cause', scaleMax: sc, minLabel: 0.04 })}
<h3>Coffee earned (kept), by cause, same scale</h3>${stackedH(earned, { label: 'Coffee earned by cause', scaleMax: sc, minLabel: 0.04 })}
${table([{ h: 'run', align: 'l' }, { h: 'earned' }, { h: 'lost to cap' }, { h: 'wasted' }, { h: 'spent' }, { h: 'held end H1' }, { h: 'H2' }, { h: 'H3' }, { h: 'H4' }, { h: 'H5' }], rows)}</section>`;
}

function sectionActions(runs) {
  const types = [...new Set(runs.flatMap((r) => r.a.actions.rows.map((x) => x.type)))];
  const rows = types.map((t) => {
    const main = runs.some((r) => r.a.actions.rows.find((x) => x.type === t)?.main);
    return [{ t, cls: '' }, main ? 'main' : '', ...runs.flatMap((r) => {
      const x = r.a.actions.rows.find((y) => y.type === t);
      return [{ t: f(x?.perPlayer ?? 0, 2), v: x?.perPlayer ?? 0 }, { t: pc(x?.share ?? 0, 1), v: x?.share ?? 0 }];
    })];
  });
  rows.sort((a, b) => b[2].v - a[2].v);
  const top = rows.slice(0, 12).map((r) => r[0].t);
  const idx = (t) => top.indexOf(t);
  const mix = runs.map((r) => ({
    label: r.label,
    segs: top.map((t) => ({ key: t, value: r.a.actions.rows.find((x) => x.type === t)?.perPlayer ?? 0, idx: idx(t) })),
  }));
  const hourLabels = ['H1', 'H2', 'H3', 'H4', 'H5', 'Final'];
  const mainTypes = ['move2', 'move3', 'volunteer', 'upgrade', 'newNoob', 'buySwag', 'clubPower', 'takeSelfie', 'pass'];
  const hourPanels = runs.map((r) => {
    const present = mainTypes.filter((t) => r.a.actions.byHour[t]);
    const cols = hourLabels.map((l, hi) => ({ label: l, segs: present.map((t) => ({ key: t, value: r.a.actions.byHour[t][hi] ?? 0, idx: mainTypes.indexOf(t) })) }));
    return `<div class="panel"><h3>${esc(r.label)}: main-action mix by Hour</h3>${stackedV(cols, { label: `Main action mix by Hour ${r.label}`, fmt: (v) => f(v, 1), height: 170 })}</div>`;
  }).join('');
  const hourLegend = legend(mainTypes, (t) => cc(mainTypes.indexOf(t)));
  const mainShare = runs.map((r) => [r.label, f(r.a.length.mainActionsPerPlayer.mean), f(r.a.length.mainActionsPerPlayerPerHour.mean, 2), ...r.a.length.turnsPerHour.slice(0, 5).map((x) => f(x, 1)), ...r.a.length.passTurnsPerHour.slice(0, 5).map((x) => f(x, 1))]);
  return `<section id="actions"><h2>10. Action mix</h2>
<p class="note">Chosen actions per player per game (forced ones the engine applied itself are excluded here). The twelve most frequent types are stacked; the table lists every type.</p>
${legend(top, (t) => cc(idx(t)))}${stackedH(mix, { label: 'Action mix per player per game', minLabel: 0.05 })}
<h3>Main-action types by Hour (per player)</h3>${hourLegend}<div class="grid2">${hourPanels}</div>
<h3>Pace</h3>${table([{ h: 'run', align: 'l' }, { h: 'main actions / player' }, { h: 'per Hour' }, ...[1, 2, 3, 4, 5].map((h) => ({ h: `turns H${h}` })), ...[1, 2, 3, 4, 5].map((h) => ({ h: `pass-turns H${h}` }))], mainShare)}
<h3>Every action type</h3>${table([{ h: 'action', align: 'l' }, { h: 'kind', align: 'l' }, ...runs.flatMap((r) => [{ h: `${r.label} /player` }, { h: `${r.label} share` }])], rows)}</section>`;
}

// ---- page ----------------------------------------------------------------------------

const CSS = `
:root{--bg:#fbfaf7;--fg:#1f2430;--dim:#6a7080;--card:#ffffff;--line:#dcd9d0;--accent:#2b5fa8;--ok:#1e7a46;--okbg:#e1f3e8;--warn:#a53b00;--warnbg:#fde7d8;--flagbg:#fff1c2;
--c0:#4e79a7;--c1:#f28e2b;--c2:#e15759;--c3:#59a14f;--c4:#b07aa1;--c5:#edc948;--c6:#76b7b2;--c7:#ff9da7;--c8:#bab0ac;--c9:#9c755f}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#15181f;--fg:#e6e8ee;--dim:#98a0b2;--card:#1d212b;--line:#343a49;--accent:#86b2ee;--ok:#7fd3a0;--okbg:#17382a;--warn:#ffb083;--warnbg:#4a2a18;--flagbg:#4b4017;
--c0:#6f9fd0;--c1:#f5a54f;--c2:#ee7a7c;--c3:#74bc6c;--c4:#c697b9;--c5:#e9cf62;--c6:#8bcfca;--c7:#ffb3bb;--c8:#8c8f99;--c9:#b99278}}
:root[data-theme="dark"]{--bg:#15181f;--fg:#e6e8ee;--dim:#98a0b2;--card:#1d212b;--line:#343a49;--accent:#86b2ee;--ok:#7fd3a0;--okbg:#17382a;--warn:#ffb083;--warnbg:#4a2a18;--flagbg:#4b4017;
--c0:#6f9fd0;--c1:#f5a54f;--c2:#ee7a7c;--c3:#74bc6c;--c4:#c697b9;--c5:#e9cf62;--c6:#8bcfca;--c7:#ffb3bb;--c8:#8c8f99;--c9:#b99278}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,Segoe UI,Arial,sans-serif}
main{max-width:1100px;margin:0 auto;padding:16px}
h1{font-size:1.6rem;margin:.2em 0}h2{font-size:1.3rem;margin:1.6em 0 .4em;border-bottom:2px solid var(--line);padding-bottom:.2em}h3{font-size:1.05rem;margin:1.1em 0 .3em}h3.sub{margin-top:1.4em;font-size:1.15rem}
nav{display:flex;flex-wrap:wrap;gap:6px 14px;margin:.6em 0;font-size:.9rem}nav a{color:var(--accent)}
.note{color:var(--dim);font-size:.88rem;margin:.3em 0 .6em}.dim{color:var(--dim)}code{background:var(--card);border:1px solid var(--line);padding:0 4px;border-radius:3px}
.tw{overflow-x:auto;margin:.5em 0;border:1px solid var(--line);border-radius:6px;background:var(--card)}
table{border-collapse:collapse;width:100%;font-size:.84rem}th,td{padding:4px 8px;text-align:right;border-bottom:1px solid var(--line);white-space:nowrap}
th{background:var(--bg);position:sticky;top:0;cursor:default;user-select:none}table.sortable th{cursor:pointer}th.l,td.l{text-align:left}
table.sortable th[aria-sort="ascending"]::after{content:" \\25B2"}table.sortable th[aria-sort="descending"]::after{content:" \\25BC"}
td.flag{background:var(--flagbg)}td.warnc{background:var(--warnbg)}
.badge{display:inline-block;font-size:.72rem;font-weight:700;padding:0 6px;border-radius:9px;margin-left:4px}.badge.ok{background:var(--okbg);color:var(--ok)}.badge.warn{background:var(--warnbg);color:var(--warn)}.badge.na{background:var(--line);color:var(--dim)}
.warnlist li{margin:.2em 0}
.grid2{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,480px),1fr));gap:12px}
.panel{background:var(--card);border:1px solid var(--line);border-radius:6px;padding:4px 12px 10px;min-width:0}
svg.chart{width:100%;height:auto;display:block}
svg .axl{font-size:11px;fill:var(--dim)}svg .vl{font-size:10px;fill:#111;pointer-events:none}svg .grp{fill:var(--fg);font-weight:600}svg .dim{font-size:10px}
svg .grid{stroke:var(--line);stroke-width:1}svg .ref{stroke:var(--fg);stroke-width:1.2;stroke-dasharray:5 4}svg .ref-l{fill:var(--fg)}svg .err line{stroke:var(--fg);stroke-width:1.6}
svg .ln{fill:none;stroke-width:2}
.c0{fill:var(--c0);background:var(--c0)}.c1{fill:var(--c1);background:var(--c1)}.c2{fill:var(--c2);background:var(--c2)}.c3{fill:var(--c3);background:var(--c3)}.c4{fill:var(--c4);background:var(--c4)}.c5{fill:var(--c5);background:var(--c5)}.c6{fill:var(--c6);background:var(--c6)}.c7{fill:var(--c7);background:var(--c7)}.c8{fill:var(--c8);background:var(--c8)}.c9{fill:var(--c9);background:var(--c9)}
.s0{stroke:var(--c0)}.s1{stroke:var(--c1)}.s2{stroke:var(--c2)}.s3{stroke:var(--c3)}.s4{stroke:var(--c4)}.s5{stroke:var(--c5)}.s6{stroke:var(--c6)}.s7{stroke:var(--c7)}.s8{stroke:var(--c8)}.s9{stroke:var(--c9)}
.legend{list-style:none;display:flex;flex-wrap:wrap;gap:4px 14px;padding:0;margin:.3em 0;font-size:.82rem}.legend .sw{display:inline-block;width:12px;height:12px;border-radius:2px;margin-right:5px;vertical-align:-1px}
.pick{display:block;margin:.4em 0;font-size:.9rem}select{font:inherit;padding:2px 6px}
@media (max-width:600px){main{padding:12px 16px}}
`;

const JS = `
(function(){
  function val(td){var v=td.getAttribute('data-v');var n=parseFloat(v);return (v!==''&&!isNaN(n)&&/^[-+0-9.eE%σ ]+$/.test(v))?n:v.toLowerCase();}
  function sortBy(th){
    var table=th.closest('table'),i=+th.getAttribute('data-col'),dir=th.getAttribute('aria-sort')==='ascending'?'descending':'ascending';
    table.querySelectorAll('th').forEach(function(h){h.setAttribute('aria-sort','none');});
    th.setAttribute('aria-sort',dir);
    var body=table.tBodies[0],rows=Array.prototype.slice.call(body.rows);
    rows.sort(function(a,b){var x=val(a.cells[i]),y=val(b.cells[i]);var r=(typeof x==='number'&&typeof y==='number')?x-y:String(x).localeCompare(String(y),undefined,{numeric:true});return dir==='ascending'?r:-r;});
    rows.forEach(function(r){body.appendChild(r);});
  }
  document.querySelectorAll('table.sortable th[data-col]').forEach(function(th){
    th.addEventListener('click',function(){sortBy(th);});
    th.addEventListener('keydown',function(e){if(e.key==='Enter'||e.key===' '){e.preventDefault();sortBy(th);}});
  });
  document.querySelectorAll('select[data-group]').forEach(function(sel){
    sel.addEventListener('change',function(){
      document.querySelectorAll('.runtab[data-group="'+sel.getAttribute('data-group')+'"]').forEach(function(d){d.hidden=(d.id!==sel.value);});
    });
  });
})();
`;

export function renderHtml(runs, { title = 'Superfans simulation report' } = {}) {
  const sections = [sectionProvenance(runs), sectionHealth(runs), sectionScores(runs), sectionVp(runs), sectionSeats(runs), sectionCards(runs), sectionBranching(runs), sectionLeads(runs), sectionCoffee(runs), sectionActions(runs)];
  const nav = [['provenance', 'Provenance'], ['health', 'Health'], ['scores', 'Scores'], ['vp', 'VP sources'], ['seats', 'Seats'], ['cards', 'Cards'], ['branching', 'Branching'], ['leads', 'Lead changes'], ['coffee', 'Coffee'], ['actions', 'Action mix']];
  const bots = [...new Set(runs.map((r) => r.bots))].join(', ');
  const seeds = [...new Set(runs.map((r) => r.data.plan.seed))].join(', ');
  return `<!doctype html>
<html lang="en-GB"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><style>${CSS}</style></head>
<body><main>
<h1>${esc(title)}</h1>
<p class="note">Runs: ${esc(runs.map((r) => r.label).join(', '))}. Bots: ${esc(bots)}. Seed: ${esc(seeds)}. Generated ${esc(new Date().toISOString().slice(0, 10))} by <code>sim/sim-report-html.mjs</code> from the simulator&rsquo;s per-game records. Self-contained: no network needed.</p>
<nav>${nav.map(([id, t]) => `<a href="#${id}">${t}</a>`).join('')}</nav>
${sections.join('\n')}
</main><script>${JS}</script></body></html>
`;
}

/** First free path: name.html, name-v2.html, ... (never overwrites). */
export function freePath(dir, name) {
  let p = join(dir, `${name}.html`);
  for (let v = 2; existsSync(p); v++) p = join(dir, `${name}-v${v}.html`);
  return p;
}

function main(argv) {
  const files = [];
  let name = null;
  let out = null;
  let title = undefined;
  for (const arg of argv) {
    if (arg.startsWith('--name=')) name = arg.slice(7);
    else if (arg.startsWith('--out=')) out = arg.slice(6);
    else if (arg.startsWith('--title=')) title = arg.slice(8);
    else if (arg === '--help') {
      console.log('node sim/sim-report-html.mjs <sim-output.json> [more.json ...] [--name=label] [--out=file.html] [--title="..."]');
      return 0;
    } else if (arg.startsWith('--')) {
      console.error(`Unknown flag ${arg}`);
      return 2;
    } else files.push(arg);
  }
  if (!files.length) {
    console.error('Give one or more simulator output files (sim.mjs prints their paths).');
    return 2;
  }
  const runs = files.map(loadRun).sort((x, y) => x.data.players - y.data.players || x.bots.localeCompare(y.bots));
  for (const r of runs) if (r.a.empty) console.error(`Warning: ${r.label} has no analysable games.`);
  const live = runs.filter((r) => !r.a.empty);
  if (!live.length) return 1;
  const html = renderHtml(live, title ? { title } : {});
  let target;
  if (out) {
    target = resolve(out);
    if (existsSync(target)) {
      console.error(`${target} exists; refusing to overwrite. Pick another --out or use --name for automatic -v2.`);
      return 1;
    }
  } else {
    const date = new Date().toISOString().slice(0, 10);
    const base = (name ?? `${live.map((r) => r.id).join('-')}`).toLowerCase().replace(/[^a-z0-9]+/g, '-');
    target = freePath(DEFAULT_DIR, `sim-report-${base}-${date}`);
  }
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, html, 'utf8');
  console.log(`Wrote ${target}  (${(html.length / 1024).toFixed(0)} KB, ${live.length} run(s))`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(main(process.argv.slice(2)));
