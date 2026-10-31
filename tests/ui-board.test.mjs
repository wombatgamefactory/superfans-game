// ui-board.test.mjs - a scripted human plays a whole 2-player game against a Medium bot
// using ONLY real pointer clicks on what the page highlights (board targets,
// action buttons, banner buttons, popups). Counts the generic-button
// fallbacks (target: zero), checks the end screen, the console and a few
// interaction rules (refusals explain themselves, undo, Cancel).
//
// Run: node tests/ui-board.test.mjs

import assert from 'node:assert/strict';
import path from 'node:path';
import { startServer, launch, openPage, rng, playToEnd, pointerClick, settle, tempDir } from './helpers/ui-harness.mjs';

const out = tempDir('ui-board');
const server = await startServer();
const browser = await launch();
let failed = false;
try {
  const { page, errors } = await openPage(browser, server, 'seats=human,medium&seed=11&speed=instant', { width: 1600, height: 1000 });
  await settle(page);

  // --- a refusal explains itself: arm Move 2, click a hall that is not legal -----------------
  await pointerClick(page, '.sf-action[data-action="move2"]');
  await page.waitForSelector('.sf-action.is-armed');
  const cancelBtn = await page.locator('#sf-stage [data-act="cancel"]').count();
  assert.equal(cancelBtn, 1, 'Cancel is on the banner while an action is half-made');
  const dimmed = page.locator('#sf-stage .sf-hall.is-dimmed, #sf-stage .sf-crew.is-dimmed');
  assert.ok((await dimmed.count()) > 0 || (await page.locator('#sf-stage .is-legal').count()) > 0, 'targets are highlighted');
  // click an opponent Crew while picking my own: dimmed, still clickable, the engine's reason is shown
  const foe = page.locator('#sf-stage .sf-crew.is-dimmed').first();
  if (await foe.count()) {
    await pointerClick(page, '#sf-stage .sf-crew.is-dimmed', 0);
    await page.waitForSelector('.sf-toast--refuse', { timeout: 3000 });
    const text = await page.locator('.sf-toast--refuse').first().innerText();
    assert.ok(text.length > 10, `refusal toast carries a reason: ${text}`);
  }
  // Escape cancels
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('.sf-action.is-armed'));

  // --- undo: take a New N00b, then undo it; the state is exactly as before ---------------------------
  {
    const before = await page.evaluate(() => ({ seq: window.__sf.state.seq, coffee: window.__sf.state.players[0].coffee, n: window.__sf.actions.length }));
    assert.equal(await page.locator('[data-act="undo"][disabled]').count(), 1, 'Undo is disabled before anything is done');
    await page.evaluate(() => window.__sf.setSpeed('normal')); // the bot waits ~0.7 s, so Undo has a window
    await pointerClick(page, '.sf-action[data-action="newNoob"]');
    await page.waitForTimeout(100);
    // a full Entrance asks which neighbouring hall gets the new N00b
    if (await page.locator('.sf-action.is-armed').count()) await pointerClick(page, '#sf-stage .sf-hall.is-legal', 0);
    await page.waitForFunction((n) => window.__sf.actions.length > n, before.n);
    // Undo stays available until another player acts: undo at once, before the bot's paced move
    assert.equal(await page.locator('[data-act="undo"][disabled]').count(), 0, 'Undo is on after my action');
    await pointerClick(page, '[data-act="undo"]');
    const after = await page.evaluate(() => ({ seq: window.__sf.state.seq, coffee: window.__sf.state.players[0].coffee, n: window.__sf.actions.length }));
    assert.deepEqual(after, before, 'Undo restores the state and the action list');
    await page.evaluate(() => window.__sf.setSpeed('instant'));
    await page.evaluate(() => window.__sf.driver.kick());
    await settle(page);
  }

  // --- play the whole game ------------------------------------------------------------------------
  const rand = rng(2024);
  const t0 = Date.now();
  const result = await playToEnd(page, rand, 'board', { maxSteps: 3000 });
  assert.ok(result.finished, `the game reached the end screen within the step cap (${result.steps} steps)`);
  await page.waitForSelector('.sf-end', { timeout: 10000 });
  const fallback = await page.evaluate(() => ({ n: window.__sf.fallbackCount, types: window.__sf.fallbackTypes, incidents: window.__sf.incidents }));
  console.log(`played ${result.steps} steps in ${((Date.now() - t0) / 1000).toFixed(1)} s:`, JSON.stringify(result.counts));
  console.log(`generic fallbacks: ${fallback.n} ${fallback.types.join(',')}`);
  assert.equal(fallback.n, 0, 'no action needed the generic fallback list');
  assert.deepEqual(fallback.incidents, [], 'no bot failures');

  // --- the end screen ----------------------------------------------------------------------------------
  const title = await page.locator('.sf-end__title').innerText();
  assert.ok(/wins/.test(title), `a winner is named: ${title}`);
  const rows = await page.locator('[data-end-panel="scores"] .sf-table tbody tr').count();
  assert.equal(rows, 2, 'one row per player');
  const html = await page.locator('.sf-end').innerHTML();
  assert.ok(!/undefined|NaN/.test(html), 'the end screen never prints undefined or NaN');
  await page.screenshot({ path: path.join(out, 'end-board-game.png') });

  assert.deepEqual(errors, [], 'no console or page errors');
  console.log('ui-board: all checks passed');
} catch (err) {
  failed = true;
  console.error(err);
} finally {
  await browser.close();
  await server.close();
}
process.exit(failed ? 1 : 0);
