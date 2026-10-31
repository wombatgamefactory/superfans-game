// setup.js - a minimal seat picker (T14). T17 replaces this with the landing
// page; the contract stays: showSetup(root, options) calls options.onStart(setup)
// with { seats: [{ kind: 'human' | 'bot', level, name, colour }], seed }.
//
// Markup follows design/landing.html (seat rows, colour dots, segmented control).

import { art, escapeHtml, crewArt, ICON } from './art.js';

export const COLOUR_IDS = ['blue', 'yellow', 'pink', 'green', 'red'];
const COLOUR_LABEL = { blue: 'Blue', yellow: 'Yellow', pink: 'Pink', green: 'Green', red: 'Red' };

const LEVEL_LABEL = { easy: 'Easy', medium: 'Medium', hard: 'Hard' };

/** Default seats for a first visit: one human against two Medium bots. */
export function defaultSeats() {
  return [
    { kind: 'human', level: null, name: 'Player 1', colour: 'blue' },
    { kind: 'bot', level: 'medium', name: 'Medium Bot', colour: 'yellow' },
  ];
}

function botName(level, seats, index) {
  const base = `${LEVEL_LABEL[level]} Bot`;
  const same = seats.filter((s, i) => i !== index && s.kind === 'bot' && s.name.startsWith(base)).length;
  return same ? `${base} ${same + 1}` : base;
}

/**
 * @param {HTMLElement} root
 * @param {{ seats?: object[], levels: string[], onStart: (setup: object) => void }} options
 */
export function showSetup(root, options) {
  const levels = options.levels;
  const seats = (options.seats ?? defaultSeats()).map((s) => ({ ...s }));

  function used(except) {
    return new Set(seats.filter((_, i) => i !== except).map((s) => s.colour));
  }

  function seatHtml(s, i) {
    const taken = used(i);
    const colours = COLOUR_IDS.map((c) => {
      const by = seats.findIndex((x, j) => j !== i && x.colour === c);
      const dis = by >= 0;
      return `<button class="sf-colour sf-pc--${c}${s.colour === c ? ' is-selected' : ''}" data-colour="${c}" data-seat="${i}" ${dis ? 'disabled' : ''} title="${COLOUR_LABEL[c]}${dis ? ` - taken by ${escapeHtml(seats[by].name)}` : ''}" aria-label="${COLOUR_LABEL[c]}"></button>`;
    }).join('');
    const types = [['human', 'Human'], ...levels.map((l) => [l, LEVEL_LABEL[l] ?? l])];
    const seg = types
      .map(([id, label]) => {
        const sel = id === 'human' ? s.kind === 'human' : s.kind === 'bot' && s.level === id;
        return `<button class="${sel ? 'is-selected' : ''}" data-type="${id}" data-seat="${i}">${label}</button>`;
      })
      .join('');
    void taken;
    return `<div class="sf-seat sf-pc--${s.colour}" data-seat-row="${i}">
      <span class="sf-seat__swatch">${art(crewArt(s.colour), { alt: '' })}</span>
      <input class="sf-input" value="${escapeHtml(s.name)}" data-name="${i}" aria-label="Player ${i + 1} name" maxlength="20">
      <div class="sf-colours" role="radiogroup" aria-label="Colour">${colours}</div>
      <div class="sf-seg" role="radiogroup" aria-label="Seat type">${seg}</div>
      <button class="sf-btn sf-btn--icon sf-btn--ghost" data-remove="${i}" title="Remove seat" ${seats.length <= 2 ? 'disabled' : ''}>&times;</button>
    </div>`;
  }

  function draw() {
    const allBots = seats.every((s) => s.kind === 'bot');
    root.innerHTML = `<div class="sf-landing sf-landing--min">
      <header class="sf-hero">
        ${art('logo-title', { cls: 'sf-hero__art', alt: 'Superfans - three excited clay fans at a comic convention' })}
        <h1 class="sf-hero__hook">Run the con. Queue for celebrities, snap the selfies, grab the swag.</h1>
        <p class="sf-hero__sub">Move your Crew between nine halls, jostle for Prime Position and be there when the stars walk in. Five Hours. One winning fan club.</p>
        <div class="sf-statstrip">
          <span class="sf-statstrip__item">${art(crewArt('blue'), { alt: '' })}<span><small>Players</small>2-5</span></span>
          <span class="sf-statstrip__item">${art(ICON.stopwatch, { alt: '' })}<span><small>Play time</small>45-75 min</span></span>
          <span class="sf-statstrip__item">${art(ICON.coffee, { alt: '' })}<span><small>Bots</small>Easy, Medium, Hard</span></span>
        </div>
      </header>
      <section class="sf-panel sf-setup sf-panel--act" aria-labelledby="setup-title">
        <h2 class="sf-panel__title" id="setup-title" style="font-size:var(--fs-xl)">Who's coming to the con? <small>2 to 5 players</small></h2>
        <div class="sf-setup__grid">${seats.map(seatHtml).join('')}</div>
        <div class="sf-setup__foot">
          <button class="sf-btn" data-add ${seats.length >= 5 ? 'disabled' : ''}>+ Add a player</button>
          <span class="sf-setup__hint">${allBots ? 'Every seat is a bot: you will watch a demo game.' : 'Set every seat to a bot to watch a demo game. Humans share this screen, passing the device between turns.'}</span>
          <button class="sf-btn sf-btn--go sf-btn--big" data-start>Open the doors!</button>
        </div>
      </section>
    </div>`;
  }

  root.onclick = (e) => {
    const t = e.target;
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
      seats.push({ kind: 'bot', level: 'medium', name: botName('medium', seats, seats.length), colour: free });
      draw();
    } else if (t.closest('[data-start]')) {
      const clean = seats.map((s, i) => ({ ...s, name: (s.name || '').trim() || (s.kind === 'bot' ? botName(s.level, seats, i) : `Player ${i + 1}`) }));
      options.onStart({ seats: clean, seed: options.seed ?? null });
    }
  };
  root.oninput = (e) => {
    const n = e.target.closest('[data-name]');
    if (n) seats[Number(n.dataset.name)].name = n.value;
  };
  draw();
}
