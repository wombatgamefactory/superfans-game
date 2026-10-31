// ui-generic.test.mjs - the generic layer: every legal action is a labelled button.
//
//  1. A 3-player all-bot game plays itself to the end screen (a demo game), with no console errors.
//  2. A 2-player game with ?generic=1 and one scripted human who uses ONLY the generic buttons
//     reaches the end screen.
//  3. A 2-human hotseat game shows the handover curtain between the two humans and never shows
//     the other player's Achievements.
//
// Run: node tests/ui-generic.test.mjs

import assert from 'node:assert/strict';
import path from 'node:path';
import { startServer, launch, openPage, rng, playToEnd, pointerClick, settle, tempDir } from './helpers/ui-harness.mjs';

const out = tempDir('ui-generic');
const server = await startServer();
const browser = await launch();
let failed = false;
try {
  // ---- 1. all bots: a demo game -------------------------------------------------------------------
  {
    const { page, errors } = await openPage(browser, server, 'seats=easy,medium,easy&seed=5&speed=instant', { width: 1500, height: 950 });
    await page.waitForSelector('.sf-end', { timeout: 150000 });
    const title = await page.locator('.sf-end__title').innerText();
    assert.ok(/wins/.test(title), `demo game names a winner: ${title}`);
    assert.equal(await page.locator('[data-end-panel="scores"] .sf-table tbody tr').count(), 3);
    const incidents = await page.evaluate(() => window.__sf.incidents);
    assert.deepEqual(incidents, [], 'no bot failures in the demo game');
    assert.deepEqual(errors, [], 'no console errors in the demo game');
    await page.screenshot({ path: path.join(out, 'end-demo.png') });
    await page.close();
    console.log('1. all-bot demo game finished');
  }

  // ---- 2. generic layer only -----------------------------------------------------------------------
  {
    const { page, errors } = await openPage(browser, server, 'seats=human,medium&seed=21&speed=instant&generic=1', { width: 1500, height: 950 });
    await settle(page);
    const first = await page.locator('[data-gen]').count();
    assert.ok(first >= 2, `generic buttons are offered (${first})`);
    const label = await page.locator('[data-gen]').first().innerText();
    assert.ok(label.length > 3, `buttons carry the engine's description: ${label}`);
    const rand = rng(99);
    const t0 = Date.now();
    const r = await playToEnd(page, rand, 'generic', { maxSteps: 5000 });
    assert.ok(r.finished, `generic game reached the end (${r.steps} steps)`);
    await page.waitForSelector('.sf-end', { timeout: 20000 });
    console.log(`2. generic game finished in ${r.steps} steps, ${((Date.now() - t0) / 1000).toFixed(1)} s`);
    assert.deepEqual(errors, [], 'no console errors in the generic game');
    await page.close();
  }

  // ---- 3. hotseat handover and hidden hands -----------------------------------------------------------
  {
    const { page, errors } = await openPage(browser, server, 'seats=human,human&seed=7&speed=instant', { width: 1500, height: 950 });
    await page.waitForSelector('.sf-handover', { timeout: 10000 });
    assert.equal(await page.locator('.sf-handover').count(), 1, 'the curtain is up before the first human plays');
    // while the curtain is up, no Achievement picture is visible anywhere on the page
    const seenBefore = await page.evaluate(() => [...document.querySelectorAll('img')].filter((i) => /achievement-\d/.test(i.src) && i.closest('#sf-players')).length);
    assert.equal(seenBefore, 0, 'no Achievement face is rendered before the first handover');
    await pointerClick(page, '[data-act="handover-ok"]');
    await page.waitForFunction(() => !document.querySelector('.sf-handover'));
    const mine = await page.evaluate(() => [...document.querySelectorAll('#sf-players img')].filter((i) => /achievement-\d/.test(i.src)).length);
    assert.equal(mine, 2, 'the player whose turn it is sees their own 2 Achievements');
    // pass (confirm) and score / bin the Achievement until the other human is up; then the curtain returns
    let sawCurtain = false;
    const rand = rng(5);
    for (let i = 0; i < 400 && !sawCurtain; i += 1) {
      const sel = await page.evaluate(() => !!document.querySelector('.sf-handover'));
      if (sel) {
        sawCurtain = true;
        const others = await page.evaluate(() => [...document.querySelectorAll('#sf-players img')].filter((x) => /achievement-\d/.test(x.src)).length);
        assert.equal(others, 0, 'no Achievement faces are visible behind the curtain');
        break;
      }
      const ready = await page.locator('.sf-action[data-action="pass"].is-ready').count();
      if (ready) {
        await pointerClick(page, '.sf-action[data-action="pass"]');
        if (await page.locator('[data-act="pass-ok"]').count()) await pointerClick(page, '[data-act="pass-ok"]');
        await page.waitForTimeout(80);
        if (await page.locator('#sf-modal-root [data-do]').count()) await pointerClick(page, '#sf-modal-root [data-do]', 0);
      } else if (await page.locator('[data-act="reward:coffee"]').count()) {
        await pointerClick(page, '[data-act="reward:coffee"]');
      } else {
        break;
      }
      await page.waitForTimeout(100);
    }
    assert.ok(sawCurtain, 'the handover curtain appears when the turn passes to the other human');
    assert.deepEqual(errors, [], 'no console errors in the hotseat game');
    await page.close();
    console.log('3. hotseat handover works');
  }
  console.log('ui-generic: all checks passed');
} catch (err) {
  failed = true;
  console.error(err);
} finally {
  await browser.close();
  await server.close();
}
process.exit(failed ? 1 : 0);
