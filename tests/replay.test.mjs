// replay.test.mjs - the downloadable game record replays to the same scores.
//
//  1. headless games of 2, 3 and 5 players: build a record, round-trip it through JSON, replay it
//     with replayRecord(): same scores, same ranks, same final state hash;
//  2. a damaged record is refused with a reason (an action dropped, a score changed, a wrong schema);
//  3. tools/replay.mjs as a command: exit 0 for a good record, 1 for a damaged one, 2 for a missing file;
//  4. in the browser: an all-bot game is played, the "Download game record" button is clicked, and the
//     downloaded file replays with tools/replay.mjs to the scores the end screen showed.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { playGame } from './helpers/headless-game.mjs';
import { startServer, launch, openPage, tempDir, REPO } from './helpers/ui-harness.mjs';
import { buildRecord, replayRecord, validateRecord, RECORD_SCHEMA } from '../src/ui/record.js';

const TOOL = path.join(REPO, 'tools', 'replay.mjs');
const dir = tempDir('replay');
let checks = 0;
const ok = (cond, msg) => {
  assert.ok(cond, msg);
  checks++;
};

function recordOf(g) {
  return JSON.parse(JSON.stringify(buildRecord({ state: g.state, seats: g.seats, actions: g.actions, events: g.events, version: 'test', durationMs: 120000 })));
}

function runTool(file, ...extra) {
  return spawnSync(process.execPath, [TOOL, file, '--quiet', ...extra], { encoding: 'utf8' });
}

// ---- 1. headless games ----
for (const [n, seed] of [[2, 'r2'], [3, 'r3'], [5, 'r5']]) {
  const g = playGame(n, seed);
  ok(g.over, `${n}p game finished`);
  const rec = recordOf(g);
  assert.equal(rec.schema, RECORD_SCHEMA);
  assert.deepEqual(validateRecord(rec), []);
  ok(rec.finished && rec.actions.length === g.actions.length, 'every chosen action is in the record');
  ok(rec.actions.every((a, i) => a.n === i + 1 && typeof a.seat === 'number' && typeof a.hour === 'number' && a.action && a.action.type), 'actions carry n, seat, hour and the action');
  ok(rec.config.seed !== undefined && rec.config.players.length === n, 'config has the seed and the players');
  ok(rec.stats && rec.stats.seats.length === n, 'stats are in the record');
  const r = replayRecord(rec);
  assert.deepEqual(r.problems, [], `${n}p replay problems`);
  ok(r.ok && r.hashOk === true, `${n}p record replays (hash matches)`);
  ok(r.scores.every((s) => s.vp === rec.finalScores.find((f) => f.seat === s.seat).vp), `${n}p same scores`);
  // stats agree with the engine's own scores, source by source
  for (const p of rec.stats.seats) {
    const fs_ = rec.finalScores.find((f) => f.seat === p.seat);
    ok(p.vp.total === fs_.vp, `${n}p stats VP total = final score for seat ${p.seat + 1}`);
    for (const [src, vp] of Object.entries(fs_.bySource)) if (vp) ok((p.vp.bySource[src] || 0) === vp, `${n}p stats ${src} = scoreGame for seat ${p.seat + 1}`);
  }
  const file = path.join(dir, `record-${n}p.json`);
  fs.writeFileSync(file, JSON.stringify(rec));
  const res = runTool(file);
  ok(res.status === 0 && /REPLAY OK/.test(res.stdout), `${n}p tools/replay.mjs exit 0 (${res.stdout}${res.stderr})`);
}

// ---- 2. damaged records ----
{
  const rec = recordOf(playGame(3, 'dmg'));
  const dropped = JSON.parse(JSON.stringify(rec));
  dropped.actions.pop();
  const r1 = replayRecord(dropped);
  ok(!r1.ok && r1.problems.length > 0, 'a record missing its last action does not verify');
  const cooked = JSON.parse(JSON.stringify(rec));
  cooked.finalScores[0].vp += 5;
  const r2 = replayRecord(cooked);
  ok(!r2.ok && r2.problems.some((p) => /VP/.test(p)), 'a changed score is caught');
  const bad = JSON.parse(JSON.stringify(rec));
  bad.schema = 'something-else';
  ok(!replayRecord(bad).ok, 'a wrong schema is refused');
  const swapped = JSON.parse(JSON.stringify(rec));
  swapped.actions[3].action = { ...swapped.actions[3].action, type: 'noSuchAction' };
  const r3 = replayRecord(swapped);
  ok(!r3.ok && r3.problems.some((p) => /replay failed/.test(p)), 'an action the engine refuses stops the replay with its position');
  const f = path.join(dir, 'damaged.json');
  fs.writeFileSync(f, JSON.stringify(cooked));
  ok(runTool(f).status === 1, 'tools/replay.mjs exits 1 for a damaged record');
  ok(runTool(path.join(dir, 'missing.json')).status === 2, 'tools/replay.mjs exits 2 for a missing file');
  ok(spawnSync(process.execPath, [TOOL], { encoding: 'utf8' }).status === 2, 'tools/replay.mjs exits 2 with no argument');
}

// ---- 4. the browser download ----
{
  const server = await startServer();
  const browser = await launch();
  try {
    const { page, errors } = await openPage(browser, server, 'seats=m,e,e&seed=21&speed=instant');
    await page.waitForFunction(() => window.__sf.screen === 'end', null, { timeout: 120000 });
    const shown = await page.evaluate(() => [...document.querySelectorAll('[data-end-panel="scores"] .sf-table tbody tr')].map((tr) => ({ name: tr.querySelector('.sf-table__name').textContent, total: Number(tr.querySelector('.sf-table__total').textContent) })));
    ok(shown.length === 3, 'the end screen lists three players');
    const [download] = await Promise.all([page.waitForEvent('download'), page.click('[data-act="download-record"]')]);
    const file = path.join(dir, 'browser-record.json');
    await download.saveAs(file);
    ok(/^superfans-game-record-[0-9a-z-]+\.json$/.test(download.suggestedFilename()), `download name is kebab-case: ${download.suggestedFilename()}`);
    const rec = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(rec.schema, RECORD_SCHEMA);
    ok(rec.finished && rec.seats.length === 3 && rec.seats.every((s) => s.kind === 'bot'), 'the browser record is finished with three bot seats');
    for (const s of shown) ok(rec.finalScores.some((f) => f.name === s.name && f.vp === s.total), `record has ${s.name} on ${s.total}`);
    const res = runTool(file);
    ok(res.status === 0 && /REPLAY OK/.test(res.stdout), `the downloaded record replays: ${res.stdout}${res.stderr}`);
    assert.deepEqual(errors, [], `console errors: ${errors.join(' | ')}`);
    await page.close();
  } finally {
    await browser.close();
    await server.close();
  }
}

console.log(`replay.test: ${checks} checks passed`);
