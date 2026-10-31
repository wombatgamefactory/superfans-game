// build-card-data.mjs - generates src/engine/data/cards.js from the catalogue's
// card data (../_catalogue/card-data.json, outside the repo).
//
//   node tools/build-card-data.mjs           write src/engine/data/cards.js
//   node tools/build-card-data.mjs --check   exit 1 if the file is out of date
//
// The output is deterministic: no timestamps, cards in catalogue order, keys
// in a fixed order, LF line endings. Card ids are the catalogue's ids (which
// the rules spec uses: `character_tng_02`, `scoring_17`, `swag_green_03`,
// `club_06`, `card_pass_actions`) and never change.
//
// Translation to rulebook terms (rules spec v2, R24 and Note 5):
//   - halls are the engine's code ids (R3.2.2): the catalogue's grid ids are
//     mapped, and its old centre name "Panel Rooms" is Main Hall (Q7);
//   - `printed` keeps the card text verbatim; `text` is the same text in
//     rulebook terms (coffee for MOJO, N00b for Noob, Selfie for Selfy,
//     Achievement for Challenge card, Photographer for Photo Volunteer,
//     colour for color), with the rulings' rewrites for Home Base (Q9),
//     Achiever (Q10) and the stale Club hand limits (Q11, R17.7);
//   - celebrity scoring methods use the spec's method ids (R21.2).
//
// Each card also carries the id of its art in assets/manifest.json, or null
// where the manifest has none.
//
// When the catalogue file is missing (a clean clone outside the Dropbox
// folder), --check reports that and exits 0: the committed cards.js stands.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..');
const SOURCE = resolve(repo, '..', '_catalogue', 'card-data.json');
const MANIFEST = join(repo, 'assets', 'manifest.json');
const OUT = join(repo, 'src', 'engine', 'data', 'cards.js');

// R3.2.2 - grid id -> code id. The spec is the authority over the catalogue's names.
const GRID_TO_CODE = {
  h11: 'artist-alley',
  h12: 'main-stage',
  h13: 'cosplay-arena',
  h21: 'autograph-hall',
  h22: 'main-hall',
  h23: 'vendor-hall',
  h31: 'photo-ops',
  h32: 'entrance',
  h33: 'food-trucks',
};

// Hall art in the manifest (named after the PSD layers, not the code ids).
const HALL_ART = {
  'artist-alley': 'hall-artists-alley',
  'main-stage': 'hall-main-stage',
  'cosplay-arena': 'hall-cosplay-corner',
  'autograph-hall': 'hall-autograph-hall',
  'main-hall': 'hall-main-hall',
  'vendor-hall': 'hall-vendor-hall',
  'photo-ops': 'hall-photo-op',
  entrance: 'hall-registration',
  'food-trucks': 'hall-food-trucks',
};

// R21.2 - catalogue method -> spec method id.
function scoringOf(card) {
  const s = card.scoring;
  switch (s.method) {
    case 'everyone':
      return { method: 'everyone', values: [s.vp_each] };
    case 'everyone_by_badge':
      return { method: 'by-badge', values: [s.vp_each.N00b, s.vp_each.VIP, s.vp_each.AAA] };
    case 'everyone_no_n00bs':
      return { method: 'everyone-no-n00bs', values: [s.vp_each] };
    case 'everyone_count_total':
      // bands 1-2 / 3-4 / 5+ (R21.2)
      return { method: 'count-total', values: s.bands.map((b) => b.vp_each) };
    case 'score_in_order':
      return { method: s.skip_n00bs ? 'in-order-no-n00bs' : 'in-order', values: s.values_by_position.slice() };
    default:
      throw new Error(`Unknown scoring method "${s.method}" on ${card.id}`);
  }
}

function scoringText(sc) {
  const v = sc.values;
  switch (sc.method) {
    case 'everyone':
      return `Everyone: ${v[0]} VP for each Crew`;
    case 'by-badge':
      return `Everyone, by badge: N00b ${v[0]} / VIP ${v[1]} / AAA ${v[2]} VP`;
    case 'everyone-no-n00bs':
      return `Everyone, no N00bs: ${v[0]} VP for each VIP or AAA Crew`;
    case 'count-total':
      return `Count total: 1-2 Crew ${v[0]} / 3-4 Crew ${v[1]} / 5+ Crew ${v[2]} VP each`;
    case 'in-order':
      return `Score in Order: ${v.join(', ')} VP`;
    case 'in-order-no-n00bs':
      return `Score in Order, no N00bs: ${v.join(', ')} VP`;
    default:
      return '';
  }
}

// R24 - stale printed words, in the order they are replaced.
const TERMS = [
  [/\bMOJO\b/g, 'coffee'],
  [/\bMojo\b/g, 'coffee'],
  [/\ba Challenge card\b/g, 'an Achievement'],
  [/\bChallenge card\b/g, 'Achievement'],
  [/\bchallenge card\b/g, 'Achievement'],
  [/\bachievement cards\b/g, 'Achievements'],
  [/\bare the first person in the queue\b/g, 'hold Prime Position'],
  [/\bare first in queue\b/g, 'hold Prime Position'],
  [/\banywhere in the Convention\b/g, 'anywhere on the board'],
  [/\bPhoto Volunteers\b/g, 'Photographers'],
  [/\bPhoto Volunteer\b/g, 'Photographer'],
  [/\bphoto volunteers\b/g, 'Photographers'],
  [/\bphoto volunteer\b/g, 'Photographer'],
  [/\bUshers Volunteers\b/g, 'Ushers'],
  [/\bUsher volunteers\b/g, 'Ushers'],
  [/\bUsher Volunteers\b/g, 'Ushers'],
  [/\bUsher volunteer\b/g, 'Usher'],
  [/\bUsher Volunteer\b/g, 'Usher'],
  [/\bSelfy\b/g, 'Selfie'],
  [/\bNoob\b/g, 'N00b'],
  [/\bnoob\b/g, 'N00b'],
  [/\bn00bs\b/g, 'N00bs'],
  [/\bcolor\b/g, 'colour'],
  [/\bworkers\b/g, 'Crew'],
  [/\bclasses\b/g, 'badges'],
  [/\bclass\b/g, 'badge'],
  [/\bpeople\b/g, 'Crew'],
  [/\benemy Crew\b/g, "other players' Crew"],
  [/\bfirst person in the queue\b/g, 'in Prime Position'],
  [/\bfirst in queue\b/g, 'in Prime Position'],
  [/\bprime position\b/g, 'Prime Position'],
  [/\bthe Convention\b/g, 'the board'],
  [/\s+,/g, ','],
  [/\s+\./g, '.'],
  [/\s{2,}/g, ' '],
];

function rulebookTerms(text) {
  let out = text ?? '';
  for (const [re, to] of TERMS) out = out.replace(re, to);
  return out.trim();
}

// Rewrites settled by the 31/10/2026 rulings (spec R28.3), used as `text` in place of the printed wording.
const TEXT_OVERRIDES = {
  // Q9: the printed text duplicates Obsessed (scoring_30).
  scoring_31: 'For each hall where you have 3 or more Crew AND at least 1 Volunteer.',
  // Q10: "hand limit" is the Achievement hand size.
  swag_orange_07: 'Draw 1 Achievement. Your Achievement hand size is permanently 1 bigger. At the end of the game your best Achievement scores x3 and your others x1.',
};

// Q11, R17.7 - the stale selfie hand-limit sentences are dropped from `text` (they have no effect).
const STALE_SENTENCES = [/\s*Your hand limit is \d+ selfies\.?/gi];

function clubText(printed) {
  let t = printed;
  for (const re of STALE_SENTENCES) t = t.replace(re, '');
  return rulebookTerms(t);
}

function hallCode(gridId, where) {
  const code = GRID_TO_CODE[gridId];
  if (!code) throw new Error(`Unknown hall "${gridId}" in ${where}`);
  return code;
}

function main() {
  const check = process.argv.includes('--check');
  if (!existsSync(SOURCE)) {
    const msg = `build-card-data: source not found (${SOURCE}); the committed cards.js is used as it is.`;
    if (check) {
      process.stdout.write(`${msg}\n`);
      return 0;
    }
    throw new Error(msg);
  }
  const data = JSON.parse(readFileSync(SOURCE, 'utf8'));
  const manifest = existsSync(MANIFEST) ? JSON.parse(readFileSync(MANIFEST, 'utf8')) : { assets: [] };
  const assetIds = new Set(manifest.assets.map((a) => a.id));
  const art = (id) => (assetIds.has(id) ? id : null);
  const decks = data.decks;

  const celebrities = decks.celebrities.map((c) => {
    const route = c.route.map((r) => hallCode(r.hall_id, c.id));
    const scoring = scoringOf(c);
    const slug = c.id.replace(/^character_/, '').replace(/_/g, '-');
    return {
      id: c.id,
      name: c.name,
      franchise: c.franchise,
      rank: c.rank,
      coffee: c.coffee,
      route,
      start: route[0],
      destination: route[route.length - 1],
      entered: route.length - 1,
      scoring,
      scoringText: scoringText(scoring),
      art: art(`card-celebrity-${slug}`),
      portrait: art(`portrait-celebrity-${slug}`),
      back: art(`back-celebrity-${c.rank.toLowerCase()}`),
    };
  });

  const achievements = decks.achievements.map((a) => {
    const n = String(a.number).padStart(2, '0');
    return {
      id: a.id,
      number: a.number,
      name: a.name,
      laurel: a.vp_per_count,
      printed: a.text_as_printed,
      text: TEXT_OVERRIDES[a.id] ?? rulebookTerms(a.text_as_printed),
      art: art(`card-achievement-${n}`),
      back: art('back-achievement'),
    };
  });

  const swag = decks.swag.map((s) => {
    const n = String(s.number_in_colour).padStart(2, '0');
    return {
      id: s.id,
      name: s.name,
      colour: s.colour,
      number: s.number_in_colour,
      cost: s.cost_selfies,
      printed: s.text_as_printed,
      text: TEXT_OVERRIDES[s.id] ?? rulebookTerms(s.text_as_printed),
      effectTag: s.effect_tag,
      art: art(`card-swag-${s.colour}-${n}`),
      back: art(`back-swag-${s.colour}`),
    };
  });

  const clubs = decks.clubs.map((c) => ({
    id: c.id,
    name: c.name,
    power: c.power_name,
    timing: c.timing,
    printed: c.text_as_printed,
    text: clubText(c.text_as_printed),
    art: art(`card-${c.id.replace('_', '-')}`),
    back: art('back-club'),
  }));

  const p = decks.pass_card[0];
  const passCard = {
    id: p.id,
    name: p.name,
    slots: p.slots.map((s) => (s.slot === 1 ? { slot: 1 } : { slot: s.slot, coffee: s.coffee, vp: s.or_vp, repeats: s.repeats === true })),
    art: art('card-pass'),
    back: art('back-pass'),
  };

  const hallArt = {};
  for (const code of Object.values(GRID_TO_CODE)) hallArt[code] = art(HALL_ART[code]);

  const counts = { celebrities: celebrities.length, achievements: achievements.length, swag: swag.length, clubs: clubs.length };
  const expected = { celebrities: 18, achievements: 40, swag: 36, clubs: 9 };
  for (const k of Object.keys(expected)) {
    if (counts[k] !== expected[k]) throw new Error(`Expected ${expected[k]} ${k}, found ${counts[k]}`);
  }

  const j = (v) => JSON.stringify(v, null, 2);
  const out = [
    '// cards.js - GENERATED by tools/build-card-data.mjs from _catalogue/card-data.json.',
    '// Do not edit by hand: change the catalogue (or the build script) and run',
    '// `node tools/build-card-data.mjs`. Printed text is kept verbatim in `printed`;',
    '// `text` is in Rule book v1 terms. Halls are code ids (spec R3.2.2). Art fields',
    '// are asset ids from assets/manifest.json, or null.',
    '',
    `export const CARD_DATA_SOURCE = ${j({ file: '_catalogue/card-data.json', compiled: data.meta.compiled })};`,
    '',
    '/** R4.2 - the 18 Celebrity cards. `scoring.values`: see spec R21.2 and R27.13. */',
    `export const CELEBRITY_CARDS = ${j(celebrities)};`,
    '',
    '/** R19.10 - the 40 Achievement cards. `laurel` = VP per count. */',
    `export const ACHIEVEMENT_CARDS = ${j(achievements)};`,
    '',
    '/** R16.8 - the 36 Swag cards. `cost` is in selfies of the card\'s own colour. */',
    `export const SWAG_CARDS = ${j(swag)};`,
    '',
    '/** R17.6 - the 9 Club cards. */',
    `export const CLUB_CARDS = ${j(clubs)};`,
    '',
    '/** R18 - the Pass card. */',
    `export const PASS_CARD = ${j(passCard)};`,
    '',
    '/** Hall art asset ids by hall code id. */',
    `export const HALL_ART = ${j(hallArt)};`,
    '',
  ].join('\n');

  if (check) {
    const current = existsSync(OUT) ? readFileSync(OUT, 'utf8') : '';
    if (current !== out) {
      process.stdout.write('build-card-data: src/engine/data/cards.js is out of date; run node tools/build-card-data.mjs\n');
      return 1;
    }
    process.stdout.write('build-card-data: cards.js is up to date.\n');
    return 0;
  }
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, out, 'utf8');
  process.stdout.write(
    `build-card-data: wrote ${OUT} (${counts.celebrities} celebrities, ${counts.achievements} achievements, ${counts.swag} swag, ${counts.clubs} clubs)\n`,
  );
  return 0;
}

process.exitCode = main();
