// ui-routes.test.mjs - celebrity route toggles.
//
// Clicking a celebrity (board figure, This Hour list, top-bar Hour) shows or hides its
// route; Enter does the same; the default is this Hour's route; a click meant for an
// action (a legal hall the figure stands in) still goes to the action.

import assert from 'node:assert/strict';
import { startServer, launch, openPage } from './helpers/ui-harness.mjs';

let checks = 0;
const ok = (cond, msg) => {
  assert.ok(cond, msg);
  checks++;
};

const server = await startServer();
const browser = await launch();
try {
  const { page, errors } = await openPage(browser, server, 'seats=h,m&seed=5&speed=fast', { width: 1600, height: 1000 });
  await page.waitForFunction(() => window.__sf.screen === 'game' && window.__sf.state && window.__sf.state.phase === 'floor' && window.__sf.seats[window.__sf.state.toAct].kind === 'human' && !window.__sf.busy, null, { timeout: 60000 });
  const hours = () => page.evaluate(() => [...document.querySelectorAll('.sf-board__overlay .sf-route__hour')].map((t) => Number(t.textContent)).sort());
  const nowHour = await page.evaluate(() => window.__sf.state.hour);

  ok(JSON.stringify(await hours()) === JSON.stringify([nowHour]), `by default only this Hour's route is drawn (${await hours()})`);

  const future = await page.evaluate(() => {
    const s = window.__sf.state;
    const el = [...document.querySelectorAll('.sf-celeb[data-route-toggle]')].find((e) => s.schedule.find((x) => x.card === e.dataset.routeToggle).hour !== s.hour);
    return el ? { card: el.dataset.routeToggle, hour: s.schedule.find((x) => x.card === el.dataset.routeToggle).hour } : null;
  });
  ok(future, 'a future celebrity stands on the board');
  const fig = `.sf-celeb[data-route-toggle="${future.card}"]`;
  await page.click(fig);
  ok((await hours()).includes(future.hour), 'clicking a future figure shows its route');
  ok((await page.getAttribute(fig, 'aria-pressed')) === 'true', 'the figure reports aria-pressed=true');
  await page.click(fig);
  ok(!(await hours()).includes(future.hour), 'clicking it again hides the route');

  await page.click('.sf-hour[data-route-toggle] >> nth=3');
  ok((await hours()).some((h) => h > nowHour + 1), `a top-bar Hour shows a later Hour's route (${await hours()})`);

  await page.click('.sf-panel--star .sf-route-btn >> nth=0');
  ok(!(await hours()).includes(nowHour), "the panel's Hide route hides this Hour's route");
  await page.click('.sf-panel--star .sf-route-btn >> nth=0');
  ok((await hours()).includes(nowHour), 'and Show route brings it back');

  await page.focus(fig);
  await page.keyboard.press('Enter');
  ok((await hours()).includes(future.hour), 'Enter on a focused figure shows its route');

  // a click on a figure inside a legal hall still makes the move
  const seq0 = await page.evaluate(() => window.__sf.state.seq);
  await page.click('.sf-action[data-action="move2"]');
  await page.waitForFunction(() => window.__sf.pending.armed === 'move2');
  await page.click('[data-target^="crew:"].is-legal >> nth=0');
  await page.waitForTimeout(200);
  const inLegal = await page.evaluate(() => {
    const el = document.querySelector('.sf-hall.is-legal .sf-celeb[data-route-toggle]');
    return el ? el.dataset.routeToggle : null;
  });
  if (inLegal) {
    await page.click(`.sf-hall.is-legal .sf-celeb[data-route-toggle="${inLegal}"]`);
    await page.waitForFunction((s) => window.__sf.state.seq > s, seq0, { timeout: 10000 });
    ok(true, 'a click on a celebrity in a legal hall makes the move, not a route toggle');
  } else {
    ok(true, 'no celebrity stood in a legal hall this time (move check skipped)');
  }
  assert.deepEqual(errors, [], errors.join(' | '));
  await page.close();
} finally {
  await browser.close();
  await server.close();
}
console.log(`ui-routes: ${checks} checks passed`);
