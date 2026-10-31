// build-share-image.mjs - the 1200x630 link-preview image (og:image / twitter:image).
//
// Renders the clay title art (assets/ui/logo-title.webp) full-bleed with a small
// "Play free in your browser" label in the site's own fonts, in Edge via
// Playwright, and saves a JPEG. Needs the network once for Google Fonts.
//
//   node tools/build-share-image.mjs [out.jpg]      (default: share-image.jpg in the repo root)
//
// It never overwrites: if the file exists, pass a new name (share-image-v2.jpg).

import { existsSync, statSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { REPO, launch } from '../tests/helpers/ui-harness.mjs';

const out = resolve(process.argv[2] || join(REPO, 'share-image.jpg'));
if (existsSync(out)) {
  console.error(`${out} already exists; pass a new file name (e.g. share-image-v2.jpg).`);
  process.exit(1);
}
// Inlined: a page made with setContent may not load file:// images.
const art = `data:image/webp;base64,${readFileSync(join(REPO, 'assets/ui/logo-title.webp')).toString('base64')}`;

const html = `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Lilita+One&family=Nunito:wght@800&display=block">
<style>
  html, body { margin: 0; width: 1200px; height: 630px; overflow: hidden; background: #2a1f17; }
  .card { position: relative; width: 1200px; height: 630px; background: url('${art}') center top / cover no-repeat; }
  .shade { position: absolute; inset: auto 0 0 0; height: 150px; background: linear-gradient(to top, rgba(42,31,23,.55), rgba(42,31,23,0)); }
  .pill { position: absolute; right: 28px; bottom: 26px; display: flex; flex-direction: column; align-items: flex-end; gap: 6px; }
  .play { font: 400 40px/1 'Lilita One', sans-serif; letter-spacing: .02em; color: #2a1f17; background: #c8f03a;
          padding: 14px 26px 12px; border-radius: 999px; box-shadow: 0 4px 0 #6f8a12, 0 10px 24px rgba(0,0,0,.35); }
  .sub { font: 800 20px/1 'Nunito', sans-serif; color: #fff; text-shadow: 0 2px 6px rgba(0,0,0,.7); padding-right: 10px; }
</style></head><body>
<div class="card"><div class="shade"></div>
  <div class="pill"><div class="play">Play free in your browser</div><div class="sub">2-5 players &middot; wombatgamefactory.com</div></div>
</div></body></html>`;

const browser = await launch();
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
  await page.setContent(html, { waitUntil: 'networkidle' });
  await page.evaluate(() => document.fonts.ready);
  const fonts = await page.evaluate(() => [...document.fonts].filter((f) => f.status === 'loaded').map((f) => f.family));
  if (!fonts.some((f) => /Lilita/.test(f))) throw new Error('Lilita One did not load (offline?); not saving a fallback-font image.');
  const artOk = await page.evaluate((src) => new Promise((done) => {
    const img = new Image();
    img.onload = () => done(img.naturalWidth > 0);
    img.onerror = () => done(false);
    img.src = src;
  }), art);
  if (!artOk) throw new Error('The title art did not load; not saving an image without it.');
  await page.screenshot({ path: out, type: 'jpeg', quality: 88 });
  console.log(`wrote ${out} (${Math.round(statSync(out).size / 1024)} KB)`);
} finally {
  await browser.close();
}
