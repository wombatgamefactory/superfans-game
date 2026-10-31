// analytics.test.mjs - the analytics hooks send the right events and parameters, and nothing at all
// while the measurement id is empty.
//
//  1. unit: inert while the id is empty (no sink call, no script tag, no request); with an id and a sink the
//     event arrives cleaned (numbers, booleans, short strings only); the parameter builders and the closed
//     list of reason codes;
//  2. browser, id empty: a whole all-bot game sends nothing and requests nothing from googletagmanager;
//  3. browser, id set + sink: a scripted bot game gives game_start, five hour_end and one game_end with the
//     documented parameters; every event name and parameter is in EVENT_TABLE; no player name or seed appears
//     in any value; a human game gives rules_opened, illegal_action_attempted and game_abandoned on pagehide
//     (once), and no game_abandoned after a finished game.

import assert from 'node:assert/strict';
import { startServer, launch, openPage, pointerClick } from './helpers/ui-harness.mjs';
import { playGame } from './helpers/headless-game.mjs';
import { CONFIG } from '../src/ui/config.js';
import {
  track, setSink, analyticsOn, clean, EVENT_TABLE, gameStartParams, hourEndParams, gameEndParams, gameAbandonedParams,
  reasonCode, safeToken, variantsHash, leaderSeatType, _resetForTests,
} from '../src/ui/analytics.js';
import { scoreGame } from '../src/engine/index.js';
import { collectStats, winnerSources } from '../src/ui/stats.js';

let checks = 0;
const ok = (cond, msg) => {
  assert.ok(cond, msg);
  checks++;
};

// ---- 0. the shipped config is empty ----
assert.equal(CONFIG.GA4_MEASUREMENT_ID, '', 'config.js must keep GA4_MEASUREMENT_ID empty');
assert.equal(CONFIG.BUG_REPORT_EMAIL, '', 'config.js must keep BUG_REPORT_EMAIL empty');
checks += 2;

// ---- 1. unit ----
{
  const seen = [];
  setSink((e, p) => seen.push([e, p]));
  ok(analyticsOn() === false, 'analytics is off with an empty id');
  ok(track('game_start', { player_count: 2 }) === false && seen.length === 0, 'nothing is sent while the id is empty, even with a sink');
  CONFIG.GA4_MEASUREMENT_ID = 'G-TEST1234';
  ok(analyticsOn() === true, 'analytics is on with an id');
  ok(track('game_start', { player_count: 2, nested: { a: 1 }, fn: () => 1, long: 'x'.repeat(300), list: ['a', 'b'], bad: NaN, flag: true }) === true, 'track returns true when sunk');
  const [name, params] = seen[0];
  ok(name === 'game_start' && params.player_count === 2 && params.flag === true, 'numbers and booleans pass');
  ok(params.long.length === 100 && params.list === 'a,b', 'long strings are cut and lists joined');
  ok(!('nested' in params) && !('fn' in params) && !('bad' in params), 'objects, functions and NaN are dropped');
  setSink(null);
  CONFIG.GA4_MEASUREMENT_ID = 'G-TEST1234';
  // no sink, no document (Node): must not throw and must report false
  ok(track('x', {}) === false, 'with no sink and no DOM track() reports false and does not throw');
  CONFIG.GA4_MEASUREMENT_ID = '';
  _resetForTests();
  ok(clean(null) && Object.keys(clean(undefined)).length === 0, 'clean() is total');
}

// builders against a real finished game
{
  const g = playGame(3, 'an1');
  ok(g.over, 'game finished');
  const seats = g.seats;
  const scores = scoreGame(g.state);
  const stats = collectStats(g.events, g.state.players, seats);
  const start = gameStartParams(seats, {}, 'v-test');
  assert.deepEqual(Object.keys(start), EVENT_TABLE.game_start);
  ok(start.player_count === 3 && start.human_players === 1 && start.bot_players === 2 && start.bot_levels === 'easy,easy' && start.variants_hash === 'default' && start.version === 'v-test', 'game_start params');
  ok(variantsHash({ clubs: 'off' }) !== 'default' && variantsHash({ clubs: 'off' }) === variantsHash({ clubs: 'off' }), 'variants_hash is stable and not "default" for a variant');
  const he = hourEndParams(seats, [3, 9, 9], 2);
  assert.deepEqual(Object.keys(he), EVENT_TABLE.hour_end);
  ok(he.hour === 2 && he.score_spread === 6 && he.leader_seat_type === 'bot', 'hour_end params (two bots tied on top = bot)');
  ok(leaderSeatType(seats, [9, 9, 0]) === 'tie' && leaderSeatType(seats, [9, 1, 1]) === 'human', 'leader_seat_type: tie across kinds, sole leader');
  const end = gameEndParams({ seats, scores, hoursPlayed: g.state.hour, durationMs: 14 * 60000, winnerSources: winnerSources(stats, scores), achievementsCompleted: stats.achievementsCompletedTotal }, 'v-test');
  assert.deepEqual(Object.keys(end), EVENT_TABLE.game_end);
  const ranked = [...scores.players].sort((a, b) => a.rank - b.rank);
  ok(end.winning_score === ranked[0].vp && end.margin === ranked[0].vp - ranked[1].vp && end.duration_minutes === 14 && end.hours_played === 5, 'game_end scores, margin, minutes, hours');
  ok(['human', 'bot', 'shared'].includes(end.winner_seat_type), 'winner_seat_type is from the closed list');
  ok(typeof end.top_vp_source === 'string' && end.top_vp_source !== 'none' && end.achievements_completed_total === stats.achievementsCompletedTotal, 'top_vp_source and achievements_completed_total');
  const ab = gameAbandonedParams(seats, 3, 90000, 'v-test');
  assert.deepEqual(Object.keys(ab).sort(), [...EVENT_TABLE.game_abandoned].sort());
  ok(ab.hour_reached === 3 && ab.transport_type === 'beacon', 'game_abandoned params');
  // reason codes: a closed list, never the sentence
  const codes = new Set();
  for (const t of ['You need 2 coffee.', 'The Entrance is full (7 of 7).', 'Main Hall is not next to Entrance.', 'It is Ann\'s decision (take your turn), not yours.', 'You have passed this Hour', 'Choose an action first (the blue buttons)', 'zzz something odd']) codes.add(reasonCode(t));
  ok([...codes].every((c) => /^[a-z-]+$/.test(c) && c.length < 30), `reason codes are short tokens: ${[...codes].join(', ')}`);
  ok(reasonCode('zzz something odd') === 'other' && reasonCode(undefined) === 'other', 'unknown text -> other');
  ok(safeToken('move2 <script>') === 'move2script' && safeToken('') === 'unknown', 'safeToken strips everything but letters and digits');
}

// ---- browser ----
const server = await startServer();
const browser = await launch();
const names = ['Easy Bot', 'Medium Bot', 'Pip', 'Player 1'];
try {
  // ---- 2. id empty: nothing is sent, nothing is requested ----
  {
    const { page, errors } = await openPage(browser, server, 'seats=m,e&seed=31&speed=instant&autostart=0');
    const requests = [];
    page.on('request', (r) => requests.push(r.url()));
    await page.evaluate(async () => {
      const a = await import('/src/ui/analytics.js');
      window.__events = [];
      a.setSink((e, p) => window.__events.push([e, p]));
    });
    await page.click('[data-start]');
    await page.waitForFunction(() => window.__sf.screen === 'end', null, { timeout: 120000 });
    const n = await page.evaluate(() => window.__events.length);
    ok(n === 0, `no event with an empty id (got ${n})`);
    ok(!requests.some((u) => /googletagmanager|google-analytics/.test(u)), 'no request to Google while the id is empty');
    ok((await page.locator('script[src*="googletagmanager"]').count()) === 0, 'no gtag script tag');
    ok(await page.evaluate(() => typeof window.gtag === 'undefined'), 'no window.gtag');
    assert.deepEqual(errors, [], errors.join(' | '));
    await page.close();
  }

  // ---- 3a. id set + sink: a whole bot game ----
  let botEvents;
  {
    const { page, errors } = await openPage(browser, server, 'seats=m,e&seed=32&speed=instant&autostart=0');
    await page.evaluate(async () => {
      const cfg = await import('/src/ui/config.js');
      const a = await import('/src/ui/analytics.js');
      cfg.CONFIG.GA4_MEASUREMENT_ID = 'G-TEST1234';
      window.__events = [];
      a.setSink((e, p) => window.__events.push([e, p]));
    });
    await page.click('[data-start]');
    await page.waitForFunction(() => window.__sf.screen === 'end', null, { timeout: 120000 });
    botEvents = await page.evaluate(() => window.__events);
    const by = (n) => botEvents.filter(([e]) => e === n);
    ok(by('game_start').length === 1, 'one game_start');
    ok(by('hour_end').length === 5, `five hour_end (got ${by('hour_end').length})`);
    ok(by('hour_end').map(([, p]) => p.hour).join() === '1,2,3,4,5', 'hour_end for hours 1 to 5 in order');
    ok(by('game_end').length === 1, 'one game_end');
    ok(by('game_abandoned').length === 0, 'no game_abandoned after a finished game');
    const gs = by('game_start')[0][1];
    ok(gs.player_count === 2 && gs.human_players === 0 && gs.bot_players === 2 && gs.bot_levels === 'easy,medium' && gs.variants_hash === 'default' && gs.version === CONFIG.VERSION, `game_start params ${JSON.stringify(gs)}`);
    const ge = by('game_end')[0][1];
    ok(ge.player_count === 2 && ge.winner_seat_type === 'bot' && ge.hours_played === 5 && ge.winning_score > 0 && ge.margin >= 0 && typeof ge.top_vp_source === 'string' && ge.achievements_completed_total >= 0 && ge.version === CONFIG.VERSION, `game_end params ${JSON.stringify(ge)}`);
    // the winner's score agrees with the end screen
    const top = await page.evaluate(() => Math.max(...[...document.querySelectorAll('[data-end-panel="scores"] .sf-table__total')].map((e) => Number(e.textContent))));
    ok(ge.winning_score === top, `game_end winning_score ${ge.winning_score} = end screen ${top}`);
    for (const [e, p] of botEvents) {
      ok(Object.keys(EVENT_TABLE).includes(e), `event ${e} is in EVENT_TABLE`);
      ok(Object.keys(p).every((k) => EVENT_TABLE[e].includes(k)), `${e} params ${Object.keys(p)} are documented`);
      ok(Object.values(p).every((v) => typeof v === 'number' || typeof v === 'boolean' || (typeof v === 'string' && v.length <= 100)), `${e} values are simple`);
    }
    const blob = JSON.stringify(botEvents);
    ok(!names.some((n) => blob.includes(n)) && !blob.includes('"32"') && !/\bseed\b/.test(blob), 'no player name or seed in any value');
    assert.deepEqual(errors, [], errors.join(' | '));
    await page.close();
  }

  // ---- 3b. a human game: rules_opened, a refusal, abandon on pagehide ----
  {
    const { page, errors } = await openPage(browser, server, 'seats=h,m&seed=33&speed=instant&autostart=0');
    await page.evaluate(async () => {
      const cfg = await import('/src/ui/config.js');
      const a = await import('/src/ui/analytics.js');
      cfg.CONFIG.GA4_MEASUREMENT_ID = 'G-TEST1234';
      window.__events = [];
      a.setSink((e, p) => window.__events.push([e, p]));
    });
    await page.click('[data-start]');
    await page.waitForFunction(() => window.__sf.screen === 'game' && window.__sf.state && window.__sf.seats[window.__sf.state.toAct].kind === 'human' && !window.__sf.busy, null, { timeout: 20000 });
    // a refusal: arm Move 2, pick one of our Crew, then click a hall that Crew cannot reach
    for (let attempt = 0; attempt < 5; attempt++) {
      await pointerClick(page, '.sf-action[data-action="move2"]');
      await page.waitForTimeout(250);
      if (await page.evaluate(() => window.__sf.pending.armed === 'move2')) break;
    }
    await page.waitForFunction(() => window.__sf.pending.armed === 'move2' && document.querySelectorAll('[data-target^="crew:"].is-legal').length > 0, null, { timeout: 10000 });
    await pointerClick(page, '[data-target^="crew:"].is-legal', 0);
    await pointerClick(page, '[data-target^="hall:"]:not(.is-legal)', 0);
    await page.waitForTimeout(200);
    // rules
    await page.click('[data-act="rules"]');
    await page.waitForSelector('#sf-modal-root [data-modal="rules"]');
    await page.click('[data-act="close-modal"]');
    await page.waitForSelector('#sf-modal-root [data-modal="rules"]', { state: 'detached' });
    const ev = await page.evaluate(() => window.__events);
    ok(ev.filter(([e]) => e === 'game_start').length === 1, 'human game: game_start');
    ok(ev.filter(([e]) => e === 'rules_opened').length === 1, 'rules_opened fires once');
    const ill = ev.filter(([e]) => e === 'illegal_action_attempted');
    ok(ill.length === 1, `a refused click sends one illegal_action_attempted (got ${ill.length})`);
    ok(ill[0][1].action_type === 'move2' && ill[0][1].reason_code === 'too-far', `refusal carries tokens only: ${JSON.stringify(ill[0][1])}`);
    // pagehide -> game_abandoned once
    await page.evaluate(() => {
      window.dispatchEvent(new Event('pagehide'));
      window.dispatchEvent(new Event('pagehide'));
    });
    const ev2 = await page.evaluate(() => window.__events);
    const ab = ev2.filter(([e]) => e === 'game_abandoned');
    ok(ab.length === 1, `exactly one game_abandoned (got ${ab.length})`);
    ok(ab[0][1].hour_reached === 1 && ab[0][1].transport_type === 'beacon' && ab[0][1].human_players === 1 && ab[0][1].player_count === 2, `game_abandoned params ${JSON.stringify(ab[0][1])}`);
    assert.deepEqual(errors, [], errors.join(' | '));
    await page.close();
  }

  // ---- 3c. the real gtag path (Google's script is answered with an empty file; no network) ----
  {
    const { page, errors } = await openPage(browser, server, 'seats=m,e&seed=34&speed=instant&autostart=0&ga_debug=1');
    const gtagRequests = [];
    await page.route(/googletagmanager.com/, (route) => {
      gtagRequests.push(route.request().url());
      route.fulfill({ status: 200, contentType: 'text/javascript', body: '' });
    });
    await page.evaluate(async () => {
      const cfg = await import('/src/ui/config.js');
      cfg.CONFIG.GA4_MEASUREMENT_ID = 'G-TEST1234';
    });
    await page.click('[data-start]');
    await page.waitForFunction(() => window.__sf.screen === 'end', null, { timeout: 120000 });
    const layer = await page.evaluate(() => (window.dataLayer || []).map((a) => Array.from(a)));
    ok(layer.length > 0 && layer[0][0] === 'js', 'gtag("js") first');
    const conf = layer.find((a) => a[0] === 'config');
    ok(conf && conf[1] === 'G-TEST1234' && conf[2].anonymize_ip === true && conf[2].debug_mode === true, `config call has anonymize_ip and (with ?ga_debug=1) debug_mode: ${JSON.stringify(conf)}`);
    const names = layer.filter((a) => a[0] === 'event').map((a) => a[1]);
    ok(names[0] === 'game_start' && names.filter((n) => n === 'hour_end').length === 5 && names[names.length - 1] === 'game_end', `events reach gtag in order: ${names.join(',')}`);
    ok(gtagRequests.length === 1 && /id=G-TEST1234/.test(gtagRequests[0]), 'the gtag script is requested once, with the id');
    ok((await page.locator('script[src*="googletagmanager.com/gtag/js"]').count()) === 1, 'one gtag script tag');
    assert.deepEqual(errors, [], errors.join(' | '));
    await page.close();
  }
} finally {
  await browser.close();
  await server.close();
}

console.log(`analytics.test: ${checks} checks passed`);
