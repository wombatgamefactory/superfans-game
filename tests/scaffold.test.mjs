import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import assert from 'node:assert/strict';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
for (const f of ['index.html', 'style.css', 'package.json', 'README.md', '.gitignore', 'src/ui/main.js', 'src/ui/config.js']) {
  assert.ok(existsSync(join(root, f)), `missing ${f}`);
}
for (const d of ['src/engine', 'src/ui', 'src/bots', 'sim', 'tests', 'assets']) {
  assert.ok(existsSync(join(root, d)), `missing folder ${d}`);
}
const html = readFileSync(join(root, 'index.html'), 'utf8');
assert.ok(!/gtag|googletagmanager/i.test(html), 'index.html must not contain a gtag snippet');
assert.ok(html.includes('id="app"'));

const { CONFIG } = await import(pathToFileURL(join(root, 'src/ui/config.js')).href);
assert.ok(CONFIG.GA4_MEASUREMENT_ID === '' || /^G-[A-Z0-9]{4,}$/.test(CONFIG.GA4_MEASUREMENT_ID), 'GA4_MEASUREMENT_ID is empty or a G- id');
assert.equal(typeof CONFIG.BUG_REPORT_EMAIL, 'string');
assert.equal(typeof CONFIG.VERSION, 'string');
console.log('scaffold ok');
