// ui-responsive.test.mjs - every screen at five widths (T17).
//
// For 1920, 1366, 1024, 768 and 390 px wide windows it opens the landing page,
// the How to play view, a game in progress, the in-game Rules modal, a
// Celebrity Walk, the end screen and the hotseat handover; saves a screenshot
// of each; and checks there is no horizontal scroll and no console error.
// At one width it also drives the setup panel with real pointer clicks
// (colour de-duplication, seat limits, demo button, a rule variant reaching
// the engine) and checks `rules_opened` fires from the landing page.
// Regression for T16's report: after opening and closing Rules, a real
// pointer click on Move 2 must arm it.
//
// Run: node tests/ui-responsive.test.mjs     (screenshots go to the system temp dir)

import assert from 'node:assert/strict';
import path from 'node:path';
import { startServer, launch, openPage, pointerClick, settle, tempDir } from './helpers/ui-harness.mjs';

const WIDTHS = [
  [1920, 1080],
  [1366, 768],
  [1024, 768],
  [768, 1024],
  [390, 844],
];

const out = tempDir('ui-responsive');
const server = await startServer();
const browser = await launch();
let checks = 0;
const ok = (cond, msg) => {
  assert.ok(cond, msg);
  checks += 1;
};

async function noHScroll(page, label) {
  const m = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
  ok(m.sw <= m.cw, `${label}: no horizontal scroll (scrollWidth ${m.sw} > ${m.cw})`);
}

async function shot(page, name, fullPage = true) {
  // let lazy images decode before the picture is taken
  await page.evaluate(() => Promise.all([...document.images].map((i) => (i.complete ? null : new Promise((r) => { i.onload = r; i.onerror = r; })))));
  await page.screenshot({ path: path.join(out, `${name}.png`), fullPage });
}

function noErrors(errors, label) {
  ok(errors.length === 0, `${label}: console errors: ${errors.join(' | ')}`);
}

async function withSink(page) {
  await page.evaluate(async () => {
    const cfg = await import('/src/ui/config.js');
    const a = await import('/src/ui/analytics.js');
    cfg.CONFIG.GA4_MEASUREMENT_ID = 'G-TEST1234';
    window.__events = [];
    a.setSink((e, p) => window.__events.push([e, p]));
  });
}

let failed = false;
try {
  for (const [w, h] of WIDTHS) {
    const vp = { width: w, height: h };

    // ---- landing --------------------------------------------------------------------------------
    {
      const { page, errors } = await openPage(browser, server, '', vp);
      await page.evaluate(() => { try { localStorage.removeItem('superfans-setup-v1'); } catch { /* none */ } });
      await page.reload();
      await page.waitForSelector('.sf-setup [data-start]');
      await withSink(page);
      await noHScroll(page, `landing ${w}`);
      ok((await page.locator('.sf-variants select[data-variant]').count()) === 12, 'one control per engine variant');
      ok((await page.locator('.sf-seat').first().locator('[data-type]').count()) === 4, 'Human, Easy, Medium, Hard per seat');
      ok(/Run the con\./.test(await page.locator('.sf-hero__hook').innerText()), 'hook line');
      await shot(page, `landing-${w}`);

      // How to play from the footer link
      await pointerClick(page, '.sf-footer [data-rules]');
      await page.waitForSelector('.sf-htp-view');
      ok((await page.locator('.sf-htp-view #htp-end').count()) === 1, 'How to play covers the end of the game');
      await page.waitForTimeout(450);
      await noHScroll(page, `how to play (landing) ${w}`);
      await shot(page, `how-to-play-landing-${w}`, false);
      ok((await page.evaluate(() => window.__events.filter(([e]) => e === 'rules_opened').length)) === 1, 'rules_opened fires from the landing page');
      await page.keyboard.press('Escape');
      await page.waitForSelector('.sf-htp-view', { state: 'detached' });
      ok(!(await page.evaluate(() => document.getElementById('app').hasAttribute('inert'))), 'the page is live again after closing');

      if (w === 1366) {
        // colour de-duplication: seat 2's colour is disabled on seat 1, and swaps follow
        const s0 = page.locator('.sf-seat').nth(0);
        ok(await s0.locator('[data-colour="yellow"]').isDisabled(), 'a colour taken by another seat is disabled');
        await pointerClick(page, '.sf-seat >> nth=0 >> [data-colour="red"]');
        ok(await page.locator('.sf-seat').nth(1).locator('[data-colour="red"]').isDisabled(), 'the new colour is now taken for seat 2');
        ok(!(await page.locator('.sf-seat').nth(1).locator('[data-colour="blue"]').isDisabled()), 'the old colour is free again');
        // seat limits
        ok(await page.locator('[data-remove="0"]').isDisabled(), 'cannot go below 2 seats');
        for (let i = 0; i < 3; i += 1) await pointerClick(page, '[data-add]');
        ok((await page.locator('.sf-seat').count()) === 5, 'five seats');
        ok(await page.locator('[data-add]').isDisabled(), 'cannot go above 5 seats');
        const colours = await page.evaluate(() => [...document.querySelectorAll('.sf-seat')].map((r) => r.querySelector('.sf-colour.is-selected').dataset.colour));
        ok(new Set(colours).size === 5, `five different colours: ${colours}`);
        await shot(page, `landing-five-seats-${w}`);
        await pointerClick(page, '[data-remove="4"]');
        await pointerClick(page, '[data-remove="3"]');
        await pointerClick(page, '[data-remove="2"]');
        // demo: every seat a bot
        await pointerClick(page, '[data-demo]');
        ok((await page.locator('.sf-seg [data-type="human"].is-selected').count()) === 0, 'Watch a demo turns every seat into a bot');
        ok(/demo/i.test(await page.locator('[data-start]').innerText()), 'the main button says it starts a demo');
        // a rule variant reaches the engine
        await page.locator('.sf-variants summary').click();
        await page.selectOption('select[data-variant="clubs"]', 'off');
        ok(/1 changed/.test(await page.locator('.sf-variants__count').innerText()), 'the summary counts changed variants');
        await pointerClick(page, '.sf-seat >> nth=0 >> [data-type="human"]');
        await pointerClick(page, '[data-start]');
        await page.waitForFunction(() => window.__sf.screen === 'game' && window.__sf.state);
        ok((await page.evaluate(() => window.__sf.state.variants.clubs)) === 'off', 'the chosen variant is in the game');
        ok((await page.evaluate(() => window.__sf.seats.map((s) => s.colour).join(','))) === 'red,yellow', 'the chosen colours are in the game');
      }
      noErrors(errors, `landing ${w}`);
      await page.close();
    }

    // ---- play, Rules modal, and the T16 Move 2 regression -------------------------------------
    {
      const { page, errors } = await openPage(browser, server, 'seats=h,m,e&seed=5', vp);
      await settle(page);
      await page.waitForSelector('.sf-action[data-action="move2"]');
      await noHScroll(page, `play ${w}`);
      await shot(page, `play-${w}`);

      await pointerClick(page, '[data-act="rules"]');
      await page.waitForSelector('#sf-modal-root [data-modal="rules"]');
      await page.waitForTimeout(450); // the pop-in animation
      await noHScroll(page, `rules modal ${w}`);
      await shot(page, `rules-game-${w}`, false);
      // close it two ways: the close button, then (second time) Escape
      await pointerClick(page, '[data-act="close-modal"]');
      await page.waitForSelector('#sf-modal-root [data-modal="rules"]', { state: 'detached' });
      await pointerClick(page, '[data-act="rules"]');
      await page.waitForSelector('#sf-modal-root [data-modal="rules"]');
      await page.keyboard.press('Escape');
      await page.waitForSelector('#sf-modal-root [data-modal="rules"]', { state: 'detached' });
      // hover a hall (tooltip) on the way, then a real pointer click on Move 2
      await page.locator('.sf-hall').first().hover().catch(() => {});
      await pointerClick(page, '.sf-action[data-action="move2"]');
      await page.waitForSelector('.sf-action.is-armed', { timeout: 3000 });
      ok(true, `Move 2 arms with a pointer click after Rules was closed (${w})`);
      await page.keyboard.press('Escape');
      noErrors(errors, `play ${w}`);
      await page.close();
    }

    // ---- the Celebrity Walk ---------------------------------------------------------------------------
    {
      const { page, errors } = await openPage(browser, server, 'seats=m,m&seed=5&speed=fast', vp);
      await page.waitForSelector('.sf-banner--walk', { timeout: 120000 });
      await page.waitForTimeout(250);
      await noHScroll(page, `walk ${w}`);
      await shot(page, `walk-${w}`, false);
      noErrors(errors, `walk ${w}`);
      await page.close();
    }

    // ---- the end screen ---------------------------------------------------------------------------------
    {
      const { page, errors } = await openPage(browser, server, 'seats=m,m,e&seed=5&speed=instant', vp);
      await page.waitForFunction(() => window.__sf.screen === 'end', null, { timeout: 180000 });
      await page.waitForTimeout(300);
      await noHScroll(page, `end ${w}`);
      await shot(page, `end-${w}`);
      noErrors(errors, `end ${w}`);
      await page.close();
    }

    // ---- hotseat handover ---------------------------------------------------------------------------------
    {
      const { page, errors } = await openPage(browser, server, 'seats=h,h&seed=5', vp);
      await page.waitForSelector('.sf-handover');
      await page.waitForTimeout(300);
      await noHScroll(page, `handover ${w}`);
      await shot(page, `handover-${w}`, false);
      noErrors(errors, `handover ${w}`);
      await page.close();
    }
    console.log(`  ${w}x${h}: ok`);
  }
} catch (err) {
  failed = true;
  console.error(err);
} finally {
  await browser.close();
  await server.close();
}
console.log(`ui-responsive: ${checks} checks, screenshots in ${out}`);
if (failed) process.exit(1);
console.log('ui-responsive: PASS');
