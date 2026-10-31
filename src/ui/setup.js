// setup.js - the landing page (T17): a sell sheet with the setup panel in it.
//
// Contract (unchanged since T14): showSetup(root, options) calls
// options.onStart(setup) with
//   { seats: [{ kind: 'human' | 'bot', level, name, colour }], seed, variants }
// where `variants` holds only the NON-default rule variants (engine VARIANTS).
//
// Markup follows design/landing.html and the T7 design system. The "How to
// play" view (how-to-play.js) opens over the page from the footer, the About
// section and the stat strip, and fires the `rules_opened` analytics event.

import { art, escapeHtml, crewArt, ICON } from './art.js';
import { historyHtml } from './history.js'; // T16
import { VARIANTS, defaultVariants, nonDefaultVariants, RULES } from '../engine/index.js';
import { howToPlayHtml } from './how-to-play.js';
import { track } from './analytics.js';
import { openDialog as openBugReport } from './bug-report-ui.js';

export const COLOUR_IDS = ['blue', 'yellow', 'pink', 'green', 'red'];
const COLOUR_LABEL = { blue: 'Blue', yellow: 'Yellow', pink: 'Pink', green: 'Green', red: 'Red' };
const LEVEL_LABEL = { easy: 'Easy', medium: 'Medium', hard: 'Hard' };
const STORE_KEY = 'superfans-setup-v1';

/** Short labels for each variant value (the table's own values are slugs). */
const VALUE_LABEL = {
  queueCapacity: { 'printed-board': '4 / 6 / 7 / 7 (board)', rulebook: '5 / 7 / 8 / 8 (Rule book v1)' },
  celebrityColours: { 'random-slots': 'Dealt at random', 'fixed-slots': 'Green, red, orange' },
  coffeeCap: { 'every-gain': 'Always 12', 'coffee-break-only': 'Coffee Break only' },
  fivePlayerOpening: { overfill: 'All into the Entrance', fallback: 'Overflow placed as New N00b' },
  usherInHall: { 'both-halls': 'Both halls', neither: 'Neither hall' },
  homeBase: { 'three-crew': '3+ Crew and a Volunteer', 'as-printed': 'As printed' },
  achiever: { 'hand-size': 'Hand size +1', 'draw-two-keep-one': 'Draw 2, keep 1' },
  clubHandLimits: { off: 'Off', on: 'On' },
  finalBoard: { 'figures-stay': 'Stay', 'figures-removed': 'Removed' },
  militiaRoll: { coin: 'Coin flip', fixed: 'Always 3 kept' },
  clubs: { random: 'One each', off: 'No Clubs' },
  firstPlayer: { random: 'Random', 'seat-0': 'Seat 1' },
};

function valueLabel(name, value) {
  const l = VALUE_LABEL[name] && VALUE_LABEL[name][value];
  return l ?? String(value).replace(/-/g, ' ').replace(/^./, (c) => c.toUpperCase());
}

/** Default seats for a first visit: one human against a Medium bot. */
export function defaultSeats() {
  return [
    { kind: 'human', level: null, name: 'Player 1', colour: 'blue' },
    { kind: 'bot', level: 'medium', name: 'Medium Bot', colour: 'yellow' },
  ];
}

function botName(level, seats, index) {
  const base = `${LEVEL_LABEL[level] ?? level} Bot`;
  const same = seats.filter((s, i) => i !== index && s.kind === 'bot' && s.name.startsWith(base)).length;
  return same ? `${base} ${same + 1}` : base;
}

function readStored() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw);
    if (!v || !Array.isArray(v.seats) || v.seats.length < 2 || v.seats.length > 5) return null;
    const ok = v.seats.every((s) => s && (s.kind === 'human' || s.kind === 'bot') && COLOUR_IDS.includes(s.colour) && typeof s.name === 'string');
    if (!ok || new Set(v.seats.map((s) => s.colour)).size !== v.seats.length) return null;
    return v;
  } catch {
    return null;
  }
}

function writeStored(seats, variants) {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify({ seats, variants }));
  } catch {
    // private window or blocked storage: the page works without it
  }
}

// ---- the How to play view (landing) ---------------------------------------------------------

let rulesEl = null;
let rulesOpener = null;

/** Opens the plain-English rules over the landing page. */
export function openHowToPlay() {
  if (rulesEl) return;
  rulesOpener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  rulesEl = document.createElement('div');
  rulesEl.className = 'sf-scrim sf-htp-view';
  rulesEl.dataset.modal = 'rules';
  rulesEl.setAttribute('role', 'dialog');
  rulesEl.setAttribute('aria-modal', 'true');
  rulesEl.setAttribute('aria-labelledby', 'htp-title');
  rulesEl.innerHTML = `<div class="sf-modal sf-modal--wide">
      <button class="sf-btn sf-btn--icon sf-modal__close" data-htp-close aria-label="Close How to play">&times;</button>
      <h2 class="sf-modal__title" id="htp-title" tabindex="-1">How to play</h2>
      ${howToPlayHtml({ K: RULES })}
      <div class="sf-modal__actions"><button class="sf-btn sf-btn--primary" data-htp-close>Back to the con</button></div>
    </div>`;
  rulesEl.addEventListener('click', (e) => {
    const t = e.target instanceof Element ? e.target : null;
    if (!t) return;
    if (t === rulesEl || t.closest('[data-htp-close]')) closeHowToPlay();
    const a = t.closest('a[href^="#htp-"]');
    if (a) {
      e.preventDefault();
      const dest = rulesEl.querySelector(a.getAttribute('href'));
      if (dest) dest.scrollIntoView({ block: 'start' });
    }
  });
  document.body.appendChild(rulesEl);
  const app = document.getElementById('app');
  if (app) app.setAttribute('inert', '');
  document.addEventListener('keydown', onRulesKey, true);
  rulesEl.querySelector('#htp-title').focus({ preventScroll: true });
  track('rules_opened', {});
}

export function closeHowToPlay() {
  if (!rulesEl) return;
  rulesEl.remove();
  rulesEl = null;
  document.removeEventListener('keydown', onRulesKey, true);
  const app = document.getElementById('app');
  if (app) app.removeAttribute('inert');
  if (rulesOpener && document.contains(rulesOpener)) rulesOpener.focus({ preventScroll: true });
  rulesOpener = null;
}

function onRulesKey(e) {
  if (e.key === 'Escape' && rulesEl) {
    e.preventDefault();
    e.stopPropagation();
    closeHowToPlay();
  }
}

// ---- the page ---------------------------------------------------------------------------------

function heroHtml() {
  const motes = [
    ['6%', '18%', '#f4c51a', '12px', '8s', '0s'],
    ['92%', '12%', '#df4fc6', '9px', '10s', '-2s'],
    ['14%', '62%', '#4c7cf3', '8px', '7s', '-4s'],
    ['88%', '55%', '#2fa84f', '13px', '11s', '0s'],
    ['50%', '4%', '#f28a1b', '7px', '9s', '-1s'],
    ['30%', '86%', '#e1382f', '10px', '12s', '-6s'],
    ['72%', '80%', '#f4c51a', '8px', '9s', '-3s'],
  ]
    .map(([x, y, c, s, t, d]) => `<i style="--x:${x};--y:${y};--c:${c};--s:${s};--t:${t};--d:${d}"></i>`)
    .join('');
  return `<header class="sf-hero">
    <div class="sf-motes" aria-hidden="true">${motes}</div>
    <div class="sf-hero__frame">${art('logo-title', { cls: 'sf-hero__art', alt: 'Superfans - three excited clay fans at a comic convention' })}</div>
    <h1 class="sf-hero__hook">Run the con. Queue for celebrities, snap the selfies, grab the swag.</h1>
    <p class="sf-hero__sub">Move your Crew between nine halls, jostle for Prime Position and be there when the stars walk in. Five Hours. One winning fan club.</p>
    <ul class="sf-statstrip" aria-label="At a glance">
      <li class="sf-statstrip__item">${art(crewArt('blue'), { alt: '' })}<span><small>Players</small>2-5</span></li>
      <li class="sf-statstrip__item">${art(ICON.stopwatch, { alt: '' })}<span><small>Play time</small>45-75 min</span></li>
      <li class="sf-statstrip__item">${art(ICON.trophy, { alt: '' })}<span><small>Ages</small>12+</span></li>
      <li class="sf-statstrip__item">${art(ICON.vp, { alt: '' })}<span><small>Weight</small>Medium</span></li>
      <li class="sf-statstrip__item">${art(ICON.coffee, { alt: '' })}<span><small>Bots</small>Easy, Medium, Hard</span></li>
    </ul>
  </header>`;
}

function belowTheFoldHtml() {
  const C = RULES.COSTS;
  const act = (icon, label, sub, cost) =>
    `<div class="sf-action sf-action--static">${art(icon, { cls: 'sf-action__icon', alt: '' })}<span class="sf-action__label">${label}</span><span class="sf-action__sub">${sub}</span>${cost}</div>`;
  const cup = (n) => `<span class="sf-cost">${art(ICON.coffee, { alt: '' })}${n}<span class="sf-sr-only"> coffee</span></span>`;
  const free = (t) => `<span class="sf-cost sf-cost--free">${t}</span>`;
  return `
  <section class="sf-section" aria-labelledby="hour-title">
    <h2 class="sf-section__title" id="hour-title">How an Hour works</h2>
    <div class="sf-steps">
      <div class="sf-step">${art(ICON.coffee, { alt: '' })}<h3>1. Coffee Break</h3><p>Everyone tops up coffee from this Hour's celebrity. Coffee is the fuel for every action, and the cup holds 12.</p></div>
      <div class="sf-step">${art(ICON.footprints, { alt: '' })}<h3>2. On the Floor</h3><p>Take turns: move Crew, upgrade badges, volunteer, take selfies, buy swag. Pass early for coffee and Achievement points.</p></div>
      <div class="sf-step">${art(ICON.star, { alt: '' })}<h3>3. Celebrity Walk</h3><p>The star of the Hour walks the floor, hands out selfies to whoever is at the front, and scores the whole queue where they stop.</p></div>
    </div>
  </section>

  <section class="sf-section" aria-labelledby="acts-title">
    <h2 class="sf-section__title" id="acts-title">Every action, one coffee price</h2>
    <div class="sf-actiongrid">
      ${act(ICON.footprints, 'Move 2', 'One Crew up to 2 halls', cup(C.COST_MOVE_2))}
      ${act(ICON.moveArrows, 'Move 1 Crew x3', 'Three Crew, 1 hall each', cup(C.COST_MOVE_3_CREW))}
      ${act(ICON.noob, 'New N00b', 'A fresh fan at the Entrance', cup(C.COST_NEW_NOOB))}
      ${act('overlay-vip-hat', 'Upgrade', 'N00b to VIP to AAA', cup(C.COST_UPGRADE))}
      ${act(ICON.volunteer, 'Volunteer', 'Usher, Security or Photographer', cup(C.COST_VOLUNTEER))}
      ${act(ICON.photographer, 'Take a Selfie', 'With a celebrity in your hall', cup(C.COST_TAKE_SELFIE))}
      ${act(ICON.gift, 'Swag', 'Pay in Selfies, bend the rules', free('Selfies'))}
      ${act(ICON.star, 'Club Power', 'Your fan club’s own trick', free('Card'))}
      ${act(ICON.rest, 'Pass', 'Score an Achievement, then rest', free('Free'))}
    </div>
  </section>

  <section class="sf-section" aria-labelledby="floor-title">
    <h2 class="sf-section__title" id="floor-title">On the con floor</h2>
    <div class="sf-gallery">
      <figure>${art('scene-selfie-stick-squad', { alt: 'Three clay fans with a selfie stick' })}<figcaption>Nine fan clubs, each with its own power</figcaption></figure>
      <figure>${art('scene-card-traders', { alt: 'Clay card traders at long tables' })}<figcaption>36 Swag cards that bend the rules</figcaption></figure>
      <figure>${art('scene-follywood', { alt: 'A FOLLYWOOD sign on a clay hill' })}<figcaption>Six of 18 celebrity guests each game</figcaption></figure>
    </div>
  </section>

  <section class="sf-section sf-about" aria-labelledby="about-title">
    <h2 class="sf-section__title" id="about-title">About the game</h2>
    <div class="sf-about__grid">
      <div>
        <p>Superfans is a board game of queues and timing. Every celebrity follows a printed route, so you can see where the crowds will be &ndash; but so can everyone else. Get to the front, pick the right hall, and make your secret Achievements count before the doors close.</p>
        <p><button class="sf-btn sf-btn--primary" type="button" data-rules>How to play</button></p>
      </div>
      <ul class="sf-features">
        <li><b>Pass and play.</b> 2 to 5 players share one screen; hands stay hidden between turns.</li>
        <li><b>Bots at three levels.</b> Fill any seat with an Easy, Medium or Hard bot, or every seat to watch a demo.</li>
        <li><b>Rules built in.</b> Only legal moves light up, and the game tells you why a move is not allowed.</li>
        <li><b>Your games, your stats.</b> See where your points came from and download a record of every move.</li>
      </ul>
    </div>
  </section>

  <footer class="sf-footer">
    <p>Superfans, a board game by Dean Morris &middot; Wombat Game Factory</p>
    <p class="sf-footer__links"><a href="#how-to-play" data-rules>How to play</a> &middot; <a href="#report" data-bug>Report a bug</a></p>
  </footer>`;
}

/**
 * @param {HTMLElement} root
 * @param {{ seats?: object[], variants?: object, levels: string[], seed?: number|null, onStart: (setup: object) => void }} options
 */
export function showSetup(root, options) {
  const levels = options.levels && options.levels.length ? options.levels : ['easy', 'medium', 'hard'];
  const stored = options.seats ? null : readStored();
  const seats = (options.seats ?? (stored ? stored.seats : defaultSeats())).map((s) => ({ ...s }));
  for (const s of seats) if (s.kind === 'bot' && !levels.includes(s.level)) s.level = levels.includes('medium') ? 'medium' : levels[0];
  const variants = defaultVariants();
  const given = options.variants ?? (stored ? stored.variants : null) ?? {};
  for (const v of VARIANTS) if (given[v.name] !== undefined && v.values.includes(given[v.name])) variants[v.name] = given[v.name];
  let detailsOpen = Object.keys(nonDefaultVariants(variants)).length > 0;

  function seatHtml(s, i) {
    const colours = COLOUR_IDS.map((c) => {
      const by = seats.findIndex((x, j) => j !== i && x.colour === c);
      const dis = by >= 0;
      const sel = s.colour === c;
      const label = `${COLOUR_LABEL[c]}${dis ? `, taken by ${seats[by].name || `seat ${by + 1}`}` : ''}`;
      return `<button type="button" class="sf-colour sf-pc--${c}${sel ? ' is-selected' : ''}" role="radio" aria-checked="${sel}" data-colour="${c}" data-seat="${i}" ${dis ? 'disabled' : ''} title="${escapeHtml(label)}" aria-label="${escapeHtml(label)}"><span aria-hidden="true">${COLOUR_LABEL[c][0]}</span></button>`;
    }).join('');
    const types = [['human', 'Human'], ...levels.map((l) => [l, LEVEL_LABEL[l] ?? l])];
    const seg = types
      .map(([id, label]) => {
        const sel = id === 'human' ? s.kind === 'human' : s.kind === 'bot' && s.level === id;
        return `<button type="button" class="${sel ? 'is-selected' : ''}" role="radio" aria-checked="${sel}" data-type="${id}" data-seat="${i}">${label}</button>`;
      })
      .join('');
    return `<div class="sf-seat sf-pc--${s.colour}" data-seat-row="${i}" role="group" aria-label="Seat ${i + 1}">
      <span class="sf-seat__swatch">${art(crewArt(s.colour), { alt: '' })}</span>
      <input class="sf-input" value="${escapeHtml(s.name)}" data-name="${i}" aria-label="Seat ${i + 1} name" maxlength="20" autocomplete="off">
      <div class="sf-colours" role="radiogroup" aria-label="Seat ${i + 1} colour">${colours}</div>
      <div class="sf-seg" role="radiogroup" aria-label="Seat ${i + 1}: human or bot">${seg}</div>
      <button type="button" class="sf-btn sf-btn--icon sf-btn--ghost" data-remove="${i}" title="Remove this seat" aria-label="Remove seat ${i + 1}" ${seats.length <= 2 ? 'disabled' : ''}>&times;</button>
    </div>`;
  }

  function variantsHtml() {
    const changed = Object.keys(nonDefaultVariants(variants)).length;
    const rows = VARIANTS.map((v) => {
      const opts = v.values
        .map((val) => `<option value="${escapeHtml(val)}"${variants[v.name] === val ? ' selected' : ''}>${escapeHtml(valueLabel(v.name, val))}${val === v.default ? ' (standard)' : ''}</option>`)
        .join('');
      const id = `var-${v.name}`;
      return `<div class="sf-variant${variants[v.name] !== v.default ? ' is-changed' : ''}">
        <label for="${id}">${escapeHtml(v.label)}</label>
        <select class="sf-select" id="${id}" data-variant="${escapeHtml(v.name)}" aria-describedby="${id}-d">${opts}</select>
        <p class="sf-variant__desc" id="${id}-d">${escapeHtml(v.description)}</p>
      </div>`;
    }).join('');
    return `<details class="sf-details sf-variants" data-variants ${detailsOpen ? 'open' : ''}>
      <summary>Game options (rule variants) <span class="sf-variants__count">${changed ? `${changed} changed` : 'standard rules'}</span></summary>
      <p class="sf-variants__intro">These are the standard rules. The switches exist for testing and house rules.</p>
      <div class="sf-variants__grid">${rows}</div>
      <button type="button" class="sf-btn sf-btn--ghost" data-variants-reset ${changed ? '' : 'disabled'}>Back to the standard rules</button>
    </details>`;
  }

  function setupHtml() {
    const allBots = seats.every((s) => s.kind === 'bot');
    const humans = seats.filter((s) => s.kind === 'human').length;
    const hint = allBots
      ? 'Every seat is a bot: sit back and watch a demo game.'
      : humans > 1
        ? 'Humans share this screen and pass the device between turns; hands stay hidden. Set every seat to a bot to watch a demo.'
        : 'Set every seat to a bot to watch a demo game.';
    return `<section class="sf-panel sf-setup sf-panel--act" id="setup" aria-labelledby="setup-title">
      <h2 class="sf-panel__title sf-setup__title" id="setup-title">Who's coming to the con? <small>2 to 5 players</small></h2>
      <div class="sf-setup__grid">${seats.map(seatHtml).join('')}</div>
      ${variantsHtml()}
      <div class="sf-setup__foot">
        <button type="button" class="sf-btn" data-add ${seats.length >= 5 ? 'disabled' : ''}>+ Add a player</button>
        <button type="button" class="sf-btn sf-btn--ghost" data-demo ${allBots ? 'disabled' : ''}>Watch a demo</button>
        <span class="sf-setup__hint" aria-live="polite">${hint}</span>
        <button type="button" class="sf-btn sf-btn--go sf-btn--big" data-start>${allBots ? 'Start the demo!' : 'Open the doors!'}</button>
      </div>
    </section>`;
  }

  let built = false;
  function draw() {
    // keep keyboard focus on the same control across a redraw
    const a = document.activeElement;
    const key = a && root.contains(a) ? focusKey(a) : null;
    const det = built ? root.querySelector('[data-variants]') : null;
    if (det) detailsOpen = det.open;
    if (!built) {
      root.innerHTML = `<div class="sf-landing">
        ${heroHtml()}
        <div id="sf-setup-slot"></div>
        <div class="sf-landing__hist">${historyHtml()}</div>
        ${belowTheFoldHtml()}
      </div>`;
      built = true;
    }
    root.querySelector('#sf-setup-slot').innerHTML = setupHtml();
    if (key) {
      const el = root.querySelector(key);
      if (el && !el.disabled) el.focus({ preventScroll: true });
      else {
        const row = key.match(/data-seat="(\d+)"/);
        const fallback = row ? root.querySelector(`[data-seat-row="${row[1]}"] .sf-input`) : root.querySelector('[data-start]');
        if (fallback) fallback.focus({ preventScroll: true });
      }
    }
  }

  function focusKey(el) {
    for (const attr of ['data-type', 'data-colour', 'data-remove', 'data-variant', 'data-name']) {
      if (el.hasAttribute(attr)) {
        const seat = el.dataset.seat !== undefined ? `[data-seat="${el.dataset.seat}"]` : '';
        return `[${attr}="${CSS.escape(el.getAttribute(attr))}"]${seat}`;
      }
    }
    for (const attr of ['data-add', 'data-demo', 'data-start', 'data-variants-reset']) if (el.hasAttribute(attr)) return `[${attr}]`;
    return null;
  }

  function start() {
    const clean = seats.map((s, i) => ({ ...s, name: (s.name || '').trim() || (s.kind === 'bot' ? botName(s.level, seats, i) : `Player ${i + 1}`) }));
    const chosen = nonDefaultVariants(variants);
    writeStored(clean, chosen);
    // the game screen reuses this root: drop the landing page's handlers first
    root.onclick = null;
    root.onchange = null;
    root.oninput = null;
    root.onkeydown = null;
    options.onStart({ seats: clean, seed: options.seed ?? null, variants: chosen });
  }

  root.onclick = (e) => {
    const t = e.target instanceof Element ? e.target : null;
    if (!t) return;
    if (t.closest('[data-rules]')) {
      e.preventDefault();
      openHowToPlay();
      return;
    }
    if (t.closest('[data-bug]')) {
      e.preventDefault();
      openBugReport();
      return;
    }
    const type = t.closest('[data-type]');
    const col = t.closest('[data-colour]');
    const rem = t.closest('[data-remove]');
    if (type) {
      const i = Number(type.dataset.seat);
      const id = type.dataset.type;
      const wasBotName = seats[i].kind === 'bot' && /Bot( \d+)?$/.test(seats[i].name);
      if (id === 'human') {
        seats[i].kind = 'human';
        seats[i].level = null;
        if (wasBotName) seats[i].name = `Player ${i + 1}`;
      } else {
        seats[i].kind = 'bot';
        seats[i].level = id;
        if (seats[i].name.startsWith('Player ') || wasBotName || seats[i].name === '') seats[i].name = botName(id, seats, i);
      }
      draw();
    } else if (col && !col.disabled) {
      seats[Number(col.dataset.seat)].colour = col.dataset.colour;
      draw();
    } else if (rem && !rem.disabled) {
      seats.splice(Number(rem.dataset.remove), 1);
      draw();
    } else if (t.closest('[data-add]') && seats.length < 5) {
      const free = COLOUR_IDS.find((c) => !seats.some((s) => s.colour === c));
      seats.push({ kind: 'bot', level: levels.includes('medium') ? 'medium' : levels[0], name: botName('medium', seats, seats.length), colour: free });
      draw();
    } else if (t.closest('[data-demo]')) {
      seats.forEach((s, i) => {
        if (s.kind === 'human') {
          s.kind = 'bot';
          s.level = levels.includes('medium') ? 'medium' : levels[0];
          s.name = botName(s.level, seats, i);
        }
      });
      draw();
    } else if (t.closest('[data-variants-reset]')) {
      Object.assign(variants, defaultVariants());
      draw();
    } else if (t.closest('[data-start]')) {
      start();
    }
  };
  root.onchange = (e) => {
    const sel = e.target instanceof Element ? e.target.closest('[data-variant]') : null;
    if (sel) {
      variants[sel.dataset.variant] = sel.value;
      draw();
    }
  };
  root.oninput = (e) => {
    const n = e.target instanceof Element ? e.target.closest('[data-name]') : null;
    if (n) seats[Number(n.dataset.name)].name = n.value;
  };
  root.onkeydown = (e) => {
    // Enter in a name box starts the game, as the main button would
    if (e.key === 'Enter' && e.target instanceof Element && e.target.matches('[data-name]')) {
      e.preventDefault();
      start();
    }
  };
  draw();
  if (location.hash === '#how-to-play') openHowToPlay();
}
