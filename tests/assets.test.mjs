import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import assert from 'node:assert/strict';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { validateAssets } = await import(pathToFileURL(join(root, 'tools/validate-assets.mjs')).href);

const { errors, stats, manifest } = validateAssets(root);
assert.deepEqual(errors, [], `asset validation errors:\n${errors.join('\n')}`);

const ids = new Set(manifest.assets.map((a) => a.id));
const need = (id) => assert.ok(ids.has(id), `manifest lacks ${id}`);
const count = (prefix) => manifest.assets.filter((a) => a.id.startsWith(prefix)).length;

// Component coverage (Rule book v1 counts; After Party is cut and must not appear).
assert.equal(count('card-celebrity-'), 18);
assert.equal(count('card-achievement-'), 40);
assert.equal(count('card-swag-'), 36);
assert.equal(count('card-club-'), 9);
assert.equal(count('card-aid-'), 3);
need('card-pass');
for (const id of ['back-celebrity-a', 'back-celebrity-b', 'back-celebrity-c', 'back-achievement', 'back-swag-green',
  'back-swag-red', 'back-swag-orange', 'back-club', 'back-pass', 'back-aid']) need(id);
assert.equal(count('hall-'), 9);
for (const id of ['board-full', 'icon-coffee', 'icon-selfie-green', 'icon-selfie-red', 'icon-selfie-orange',
  'icon-badge-noob', 'icon-badge-vip', 'icon-badge-aaa', 'icon-volunteer', 'icon-star', 'icon-trophy',
  'icon-swag-green', 'logo-title', 'cover-box']) need(id);
assert.ok(!manifest.assets.some((a) => /after[-_ ]?party/i.test(a.id + a.file)), 'After Party art must not ship');

// Every placeholder/missing entry points at a real labelled file. (STILL-NEEDED.md, the art to-do list
// that build-assets.py writes, is kept locally and git-ignored; it is not checked here.)
const gaps = manifest.assets.filter((a) => a.status !== 'real' && a.id !== 'placeholder-generic');
assert.ok(gaps.length > 0);
for (const g of gaps) assert.ok(g.file.startsWith('placeholders/'), `${g.id} should use a placeholder file`);
assert.ok(stats.firstPaintBytes > 0 && stats.firstPaintBytes < 2_000_000);
console.log(`assets ok: ${stats.count} assets, ${stats.totalBytes} bytes, first paint ${stats.firstPaintBytes}`);
