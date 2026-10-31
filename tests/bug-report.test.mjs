// bug-report.test.mjs - the bug reporter's three promises, and the dialog.
//
//  1. NEVER THROWS: buildReport() over states from the start, middle and end of 2, 3 and 5 player games, over a
//     null state, over garbage input, and with every section forced to fail in turn;
//  2. NEVER MUTATES: hashState of the live game is the same before and after a capture;
//  3. STRINGIFY-SAFE and REPLAYABLE: the report survives JSON, and its replay section rebuilds the same state hash;
//  4. diagnostics explain themselves: block reasons per action type, the legal list agrees with the ladder;
//  5. caps and archive helpers; kebab-case file names;
//  6. browser: the button is on every screen, Ctrl+Shift+B opens the dialog, Download gives a replayable file,
//     the email option is hidden while BUG_REPORT_EMAIL is empty, Escape closes, no console errors.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { playGame } from './helpers/headless-game.mjs';
import { startServer, launch, openPage, tempDir } from './helpers/ui-harness.mjs';
import { hashState, cloneState, replayGame } from '../src/engine/index.js';
import { CONFIG } from '../src/ui/config.js';
import {
  buildReport, capValue, addToArchive, makeReportId, reportFileName, slugOf, logAction, logEvent, getLogs, resetLogs, startLogs,
  CAPS, LOG_SIZES, UNCAPPED_SECTIONS, REPORT_SCHEMA_VERSION, CATEGORIES,
} from '../src/ui/bug-report-capture.js';

let checks = 0;
const ok = (cond, msg) => {
  assert.ok(cond, msg);
  checks++;
};

// ---- 5. helpers first ----
{
  ok(makeReportId(new Date(2026, 9, 31, 14, 30, 15), (b) => b.fill(7)) === 'sfbug-20261031-143015-hhhh', 'report id is stamped and has a random suffix');
  ok(slugOf('The Queue was FULL!!') === 'the-queue-was-full' && slugOf('') === 'report' && slugOf('   ') === 'report', 'slugs');
  const name = reportFileName('sfbug-1', 'Bad Scoring?');
  ok(name === 'superfans-bug-sfbug-1-bad-scoring.json' && !/\s/.test(name) && name === name.toLowerCase(), `file names are kebab-case: ${name}`);
  const circular = { a: 1 };
  circular.self = circular;
  const capped = capValue({ circular, fn() {}, big: 10n, nan: NaN, long: 'x'.repeat(CAPS.string + 50), arr: Array.from({ length: CAPS.array + 20 }, (_, i) => i), m: new Map([[1, 2]]), deep: { a: { b: { c: { d: { e: { f: { g: { h: { i: { j: { k: { l: { m: 1 } } } } } } } } } } } } } });
  const text = JSON.stringify(capped);
  ok(typeof text === 'string' && capped.circular.self === '[circular]' && capped.fn === '[function]' && capped.big === '10' && capped.nan === 'NaN', 'capValue makes anything JSON-safe');
  ok(capped.long.length < CAPS.string + 60 && capped.arr.length === CAPS.array + 1, 'strings and arrays are capped');
  let list = [];
  for (let i = 0; i < 30; i++) list = addToArchive(list, { id: `r${i}`, text: 'x'.repeat(100) });
  ok(list.length === 20 && list[0].id === 'r10' && list[19].id === 'r29', 'archive keeps the newest 20');
  list = addToArchive([{ id: 'a', text: 'x'.repeat(10) }], { id: 'b', text: 'y'.repeat(30) }, { count: 20, bytes: 20 });
  ok(list.length === 1 && list[0].id === 'b', 'the newest entry is always kept, however large');
  ok(addToArchive([{ id: 'a', text: '1' }], { id: 'a', text: '2' }).length === 1, 'an entry with the same id replaces the old one');
  resetLogs();
  for (let i = 0; i < LOG_SIZES.actions + 10; i++) logAction({ seq: i, fn() {} });
  for (let i = 0; i < LOG_SIZES.events + 10; i++) logEvent('refusal', `r${i}`, { circular });
  logAction(undefined);
  logEvent();
  ok(getLogs().actionLog.length === LOG_SIZES.actions && getLogs().eventLog.length === LOG_SIZES.events, 'ring buffers are bounded');
  startLogs();
  ok(getLogs().actionLog.length === 0 && getLogs().eventLog.length > 0, 'a new game clears the action log and keeps the event log');
  ok(CATEGORIES.length === 6 && UNCAPPED_SECTIONS.includes('gameState') && UNCAPPED_SECTIONS.includes('replay'), 'categories and uncapped sections');
}

// ---- 1-4. fuzz over real positions ----
let reports = 0;
for (const [n, seed] of [[2, 'bg2'], [3, 'bg3'], [5, 'bg5']]) {
  const g = playGame(n, seed, { snapshots: 30 });
  const positions = [{ state: playGame(n, seed, { stopAfter: 0 }).state, actions: [] }];
  g.snapshots.forEach((s, i) => positions.push({ state: s, actions: g.actions.slice(0, (i + 1) * 30) }));
  positions.push({ state: g.state, actions: g.actions });
  ok(positions.length >= 3, `${n}p: start, middle and end positions`);
  for (const pos of positions) {
    const live = pos.state;
    const before = hashState(live);
    const pristine = JSON.stringify(live);
    let report;
    assert.doesNotThrow(() => {
      report = buildReport({ state: live, seats: g.seats, replay: { actions: pos.actions.map((a) => a.action) }, lastHumanActor: 0, screen: 'game', ui: { note: 'fuzz' }, words: { title: 't', category: CATEGORIES[0], expected: 'e', actual: 'a' } });
    }, 'buildReport never throws');
    reports++;
    ok(hashState(live) === before && JSON.stringify(live) === pristine, 'capture leaves the live state untouched');
    const round = JSON.parse(JSON.stringify(report));
    ok(round.schemaVersion === REPORT_SCHEMA_VERSION && round.game === 'superfans', 'schema and game');
    assert.deepEqual(round.capture.sectionsWithErrors, [], `sections with errors: ${round.capture.sectionsWithErrors}`);
    assert.deepEqual(round.capture.errorPaths, [], `errors inside sections: ${round.capture.errorPaths}`);
    ok(round.stateHash === before && round.gameState && round.replay.actionCount === pos.actions.length, 'state hash, full state and full action list are in');
    ok(round.replayCheck && round.replayCheck.ok === true, `the report's replay rebuilds the same state (${JSON.stringify(round.replayCheck)})`);
    // the replay section really is enough on its own
    const again = replayGame(round.replay.config, round.replay.actions);
    ok(hashState(again) === before, 'replayGame(report.replay) gives the live state hash');
    const d = round.diagnostics;
    ok(d.reporter && d.score && d.players.length === n, 'diagnostics: reporter, score, players');
    if (live.phase !== 'ended') {
      ok(d.decision && d.decision.prompt, 'diagnostics: the pending decision in words');
      ok(d.legal.count > 0 && d.legal.actions.every((a) => a.key && a.text), 'diagnostics: every legal action has a key and text');
      ok(d.legalAgreement.ok === true, 'diagnostics: every offered action passes the block-reason ladder');
      const types = Object.keys(d.actionTypes);
      ok(types.length >= 30 && types.every((t) => 'bareProbe' in d.actionTypes[t] && 'legalNow' in d.actionTypes[t]), 'diagnostics: a block-reason probe for every action type');
    }
  }
}
ok(reports >= 9, `${reports} reports built`);

// forced section failures are contained
{
  const g = playGame(3, 'bgf', { stopAfter: 40 });
  const input = { state: g.state, seats: g.seats, replay: { actions: g.actions.map((a) => a.action) } };
  const sections = ['environment', 'table', 'gameState', 'replay', 'replayCheck', 'diagnostics', 'actionLog', 'eventLog', 'ui', 'timestamp', 'words', 'stateHash'];
  for (const name of sections) {
    let r;
    assert.doesNotThrow(() => {
      r = buildReport(input, { failSections: [name] });
    });
    ok(r[name] && r[name].error && /forced failure/.test(r[name].error), `${name}: a forced failure becomes { error } in its place`);
    ok(r.capture.sectionsWithErrors.includes(name) && r.id && r.schemaVersion, `${name}: the rest of the report is still there`);
    ok(typeof JSON.stringify(r) === 'string', `${name}: still JSON`);
  }
  let r = buildReport(input, { failSections: sections });
  ok(r.id && r.capture.sectionsWithErrors.length >= sections.length, 'every section failing at once still gives a report');
  // no state, bad input
  for (const bad of [undefined, null, {}, { state: null }, { state: {} }, { state: { players: 'x' }, seats: 7 }, { state: g.state, seats: null, replay: 5, ui: (() => { const c = {}; c.c = c; return c; })() }, 'string', 42]) {
    assert.doesNotThrow(() => {
      r = buildReport(bad);
    }, "garbage input");
    ok(typeof JSON.stringify(r) === 'string' && r.id, 'garbage in, a report out');
  }
  assert.doesNotThrow(() => buildReport(input, { config: null }));
  // a corrupt state: the report is still produced and the broken sections say so
  const broken = cloneState(g.state);
  broken.stack = null;
  broken.crew = 'nope';
  r = buildReport({ state: broken, seats: g.seats, replay: { actions: [] } });
  ok(r.id && r.capture.sectionsWithErrors.length + r.capture.errorPaths.length > 0, `a corrupt state gives a report with errors marked: ${r.capture.errorPaths.slice(0, 4)}`);
}

// ---- 6. browser ----
const server = await startServer();
const browser = await launch();
const dir = tempDir('bug');
try {
  const { page, errors } = await openPage(browser, server, 'seats=h,m&seed=41&speed=instant&autostart=0');
  ok((await page.locator('#bug-report-btn').count()) === 1, 'the button is on the landing page');
  ok((await page.locator('#bug-report-btn').evaluate((el) => el.parentElement === document.body)), 'the button is mounted on document.body');
  await page.click('[data-start]');
  await page.waitForFunction(() => window.__sf.screen === 'game' && window.__sf.state && window.__sf.seats[window.__sf.state.toAct].kind === 'human' && !window.__sf.busy, null, { timeout: 20000 });
  ok((await page.locator('#bug-report-btn').count()) === 1, 'still one button during play (it survives re-renders)');
  await page.keyboard.press('Control+Shift+B');
  await page.waitForSelector('#bug-modal [data-bug-field="dialog"]');
  ok(true, 'Ctrl+Shift+B opens the dialog');
  const hasEmail = CONFIG.BUG_REPORT_EMAIL.trim() !== '';
  ok((await page.locator('#bug-modal [data-bug-act="mailto"]').count()) === (hasEmail ? 1 : 0), `email option shown only when BUG_REPORT_EMAIL is set (set: ${hasEmail})`);
  await page.fill('[data-bug-field="title"]', 'Queue looks wrong');
  await page.fill('[data-bug-field="actual"]', 'It said full.');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('[data-bug-act="download"]')]);
  const file = path.join(dir, 'report.json');
  await dl.saveAs(file);
  ok(/^superfans-bug-sfbug-\d{8}-\d{6}-[a-z0-9]{4}-queue-looks-wrong\.json$/.test(dl.suggestedFilename()), `download name ${dl.suggestedFilename()}`);
  const rep = JSON.parse(fs.readFileSync(file, 'utf8'));
  ok(rep.words.title === 'Queue looks wrong' && rep.words.actual === 'It said full.' && rep.screen === 'game', 'the report holds the words and the screen');
  ok(rep.replayCheck.ok === true && rep.environment.viewport.width > 0 && rep.diagnostics.controls.items.length > 0, 'replay ok, environment and controls scraped');
  ok(rep.diagnostics.reporter.seat === 0 && rep.table.seats.length === 2, 'the reporter is the human at seat 1');
  const archived = await page.evaluate(() => JSON.parse(localStorage.getItem('superfans-bug-reports-v1')).length);
  ok(archived === 1, 'the report is archived in localStorage');
  const opened = await page.evaluate(() => document.getElementById('app').hasAttribute('inert'));
  ok(opened, 'the game behind the dialog is inert');
  await page.keyboard.press('Escape');
  await page.waitForSelector('#bug-modal', { state: 'detached' });
  ok(!(await page.evaluate(() => document.getElementById('app').hasAttribute('inert'))), 'Escape closes the dialog');
  // a failing section in the page is contained too
  await page.evaluate(() => window.__sfBug.failSections(['diagnostics']));
  const forced = await page.evaluate(() => window.__sfBug.capture());
  ok(forced.diagnostics.error && forced.capture.sectionsWithErrors.includes('diagnostics') && forced.id, 'a forced section failure in the page is contained');
  await page.evaluate(() => window.__sfBug.failSections([]));
  // the live game still works afterwards
  ok((await page.evaluate(() => window.__sf.screen)) === 'game', 'the game carries on');
  assert.deepEqual(errors, [], `console errors: ${errors.join(' | ')}`);
  await page.close();

  // the end screen has the button too
  const demo = await openPage(browser, server, 'seats=m,e&seed=42&speed=instant');
  await demo.page.waitForFunction(() => window.__sf.screen === 'end', null, { timeout: 120000 });
  ok((await demo.page.locator('#bug-report-btn').count()) === 1, 'the button is on the end screen');
  await demo.page.keyboard.press('Control+Shift+B');
  await demo.page.waitForSelector('#bug-modal');
  const endReport = await demo.page.evaluate(() => window.__sfBug.frozen());
  ok(endReport.screen === 'end' && endReport.replayCheck.ok === true && endReport.diagnostics.decision === null, 'an end-screen report replays and has no pending decision');
  assert.deepEqual(demo.errors, [], demo.errors.join(' | '));
  await demo.page.close();
} finally {
  await browser.close();
  await server.close();
}

console.log(`bug-report.test: ${checks} checks passed`);
