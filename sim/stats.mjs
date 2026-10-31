// stats.mjs - small statistics helpers shared by the aggregator and the report.
// Pure functions, no engine imports.

/** Adds `n` to `obj[key]` (creating it). */
export function inc(obj, key, n = 1) {
  obj[key] = (obj[key] ?? 0) + n;
}

/** Adds every number of `from` into `into` (flat objects of counters). */
export function addInto(into, from) {
  for (const k of Object.keys(from)) into[k] = (into[k] ?? 0) + from[k];
  return into;
}

export function sum(xs) {
  let t = 0;
  for (let i = 0; i < xs.length; i++) t += xs[i];
  return t;
}

export function mean(xs) {
  return xs.length === 0 ? null : sum(xs) / xs.length;
}

/** Sample standard deviation (n - 1). */
export function sd(xs) {
  if (xs.length < 2) return null;
  const m = mean(xs);
  let t = 0;
  for (const x of xs) t += (x - m) * (x - m);
  return Math.sqrt(t / (xs.length - 1));
}

export function min(xs) {
  return xs.length === 0 ? null : xs.reduce((a, b) => (b < a ? b : a));
}

export function max(xs) {
  return xs.length === 0 ? null : xs.reduce((a, b) => (b > a ? b : a));
}

/** Percentile by linear interpolation, p in 0..100. */
export function percentile(xs, p) {
  if (xs.length === 0) return null;
  const s = xs.slice().sort((a, b) => a - b);
  const i = (p / 100) * (s.length - 1);
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return s[lo] + (s[hi] - s[lo]) * (i - lo);
}

/** Summary of a list of numbers: n, mean, sd, min, p25, median, p75, max. */
export function describe(xs) {
  if (xs.length === 0) return { n: 0, mean: null, sd: null, min: null, p25: null, median: null, p75: null, max: null };
  return {
    n: xs.length,
    mean: mean(xs),
    sd: sd(xs),
    min: min(xs),
    p25: percentile(xs, 25),
    median: percentile(xs, 50),
    p75: percentile(xs, 75),
    max: max(xs),
  };
}

/**
 * How many standard errors `observed` wins out of `n` games is from the expected
 * `p` (binomial). Returns { rate, expected, sigma, n } - sigma null when n or p is degenerate.
 */
export function rateVs(wins, n, p) {
  if (n === 0) return { rate: null, expected: p, sigma: null, n };
  const rate = wins / n;
  const se = Math.sqrt((p * (1 - p)) / n);
  return { rate, expected: p, sigma: se > 0 ? (rate - p) / se : null, n };
}

/**
 * As rateVs but the expected chance differs per game: `ps` is the list of per-game
 * expected probabilities (Poisson-binomial variance).
 */
export function rateVsEach(wins, ps) {
  const n = ps.length;
  if (n === 0) return { rate: null, expected: null, sigma: null, n };
  const expected = sum(ps) / n;
  let variance = 0;
  for (const p of ps) variance += p * (1 - p);
  const rate = wins / n;
  const se = Math.sqrt(variance) / n;
  return { rate, expected, sigma: se > 0 ? (rate - expected) / se : null, n };
}

/** Histogram: `edges` are the lower bounds of the bins; the last bin is open-ended. */
export function histogram(xs, edges) {
  const bins = edges.map((lo, i) => ({ lo, hi: i + 1 < edges.length ? edges[i + 1] : null, n: 0 }));
  for (const x of xs) {
    let i = edges.length - 1;
    while (i > 0 && x < edges[i]) i--;
    bins[i].n++;
  }
  return bins;
}

/** Sorted-key copy of a plain object (stable JSON output). */
export function sortedKeys(obj) {
  const out = {};
  for (const k of Object.keys(obj).sort()) out[k] = obj[k];
  return out;
}

/** Rounds to `d` decimals, keeping null. */
export function round(x, d = 2) {
  if (x === null || x === undefined || Number.isNaN(x)) return x ?? null;
  const f = 10 ** d;
  return Math.round(x * f) / f;
}
