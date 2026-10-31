// board-render.js - the board as markup: nine hall tiles on a 5 x 5 grid with
// the ropes between them, queues, Crew, Volunteers, celebrity figures,
// destination chairs and the route overlay.
//
// Everything is drawn from the state it is given (the real state, or the
// display state while an animation plays). Hall names, capacities and colours
// all come from engine data. Clicks are not handled here: every clickable
// thing carries data-target="<kind>:<id>" and main.js hands the click to
// action-targets.js.

import {
  HALLS,
  ROPES,
  capacity,
  queue,
  isFull,
  hallName,
  celebrityCard,
  figuresOnBoard,
  getConstants,
  ordinal,
} from '../engine/index.js';
import { stepOf, kindOfKey } from './action-targets.js';
import { art, escapeHtml, crewPiece, ICON } from './art.js';

const OWNER_WORD = { security: 'Security', photographer: 'Photographer', usher: 'Usher' };

/** The grid cell centre in the route overlay's 328 x 328 viewBox. */
function centre(hall) {
  const h = HALLS.find((x) => x.id === hall);
  return [50 + (h.col - 1) * 114, 50 + (h.row - 1) * 114];
}

/**
 * Builds the function that says which highlight class a target wears.
 * @param {object} state
 * @param {{ entries: object[], picked: string[], active: boolean }} targets
 * @returns {(key: string) => string}
 */
export function makeClasser(state, targets) {
  if (!targets.active) return () => '';
  const here = stepOf(targets.entries, targets.picked);
  // the hall a picked Crew stands in is the source of the move, not a candidate target
  const sources = new Set(targets.picked.filter((k) => kindOfKey(k) === 'crew').map((k) => state.crew.find((c) => c.id === k.slice(5))).filter(Boolean).map((c) => `hall:${c.hall}`));
  return (key) => {
    if (sources.has(key) && !here.next.has(key)) return '';
    if (targets.picked.includes(key)) return 'is-selected';
    if (here.next.has(key)) return 'is-legal';
    const kind = kindOfKey(key);
    if (!here.kinds.has(kind)) return '';
    const value = key.slice(kind.length + 1);
    if (kind === 'hall') return isFull(state, value) ? 'is-illegal' : 'is-dimmed';
    if (kind === 'space') return state.volunteers[value] !== null && state.volunteers[value] !== undefined ? 'is-illegal' : 'is-dimmed';
    if (kind === 'crew') return 'is-dimmed';
    return 'is-illegal';
  };
}

function ownerName(state, seat) {
  return seat === null || seat === undefined ? '' : state.players[seat].name;
}

/** Whether a target key is in the kinds of the current step (clickable and focusable). */
function interactive(cls) {
  return cls === 'is-legal' || cls === 'is-illegal' || cls === 'is-dimmed' || cls === 'is-selected';
}

function targetAttrs(key, cls, label) {
  const on = interactive(cls);
  return ` data-target="${escapeHtml(key)}"${on ? ` tabindex="0" role="button"` : ''}${label ? ` aria-label="${escapeHtml(label)}"` : ''}`;
}

function volSpace(state, id, role, classer, extraCls = '') {
  const owner = state.volunteers[id];
  const key = `space:${id}`;
  const cls = classer(key);
  const taken = owner !== null && owner !== undefined;
  const pc = taken ? ` sf-pc--${state.players[owner].colour}` : '';
  const title = taken ? `${OWNER_WORD[role]}: ${ownerName(state, owner)}` : `${OWNER_WORD[role]} space (empty)`;
  return `<span class="sf-vol sf-vol--${role}${taken ? ' is-taken' : ''}${pc} ${cls} ${extraCls}"${targetAttrs(key, cls, `${title}`)} title="${escapeHtml(title)}"></span>`;
}

function hallTag(text) {
  return text ? `<span class="sf-hall__tag">${escapeHtml(text)}</span>` : '';
}

function crewInSlot(state, c, classer, view) {
  const key = `crew:${c.id}`;
  const cls = classer(key);
  const owner = state.players[c.owner];
  const label = `${owner.name}'s ${c.badge} Crew`;
  const sel = cls === 'is-selected' ? ' is-selected' : cls ? ` ${cls}` : '';
  const flash = view.flash.crew.includes(c.id) ? ' is-new' : '';
  return crewPiece(owner.colour, c.badge, {
    label,
    cls: `${sel}${flash}`.trim(),
    target: key,
    attrs: `data-crew="${escapeHtml(c.id)}" aria-label="${escapeHtml(label)}"${interactive(cls) ? ' tabindex="0" role="button"' : ''}`,
  });
}

function hallHtml(state, h, ctx) {
  const { classer, tags, view, figures } = ctx;
  const cap = capacity(state);
  const q = queue(state, h.id);
  const key = `hall:${h.id}`;
  const cls = classer(key);
  const source = ctx.sourceHall === h.id ? ' is-source' : '';
  const slots = [];
  for (let i = 0; i < cap; i += 1) {
    const c = q[i];
    slots.push(
      `<li class="sf-slot${i === 0 ? ' sf-slot--prime' : ''}" data-pos="${i + 1}">${c ? crewInSlot(state, c, classer, view) : `<span class="sf-slot__n">${i + 1}</span>`}</li>`,
    );
  }
  // any extra Crew beyond the printed slots (an overfilled opening) still show, never hidden
  for (let i = cap; i < q.length; i += 1) slots.push(`<li class="sf-slot" data-pos="${i + 1}">${crewInSlot(state, q[i], classer, view)}</li>`);

  const pieces = [];
  const here = figures.filter((f) => f.figure === h.id);
  here.forEach((f, i) => {
    const card = celebrityCard(f.card);
    const classes = ['sf-celeb', `sf-cc--${f.colour}`];
    if (ctx.walkingCard === f.card) classes.push('is-walking', 'is-now');
    const ckey = `celeb:${f.card}`;
    const ccls = classer(ckey);
    if (ccls) classes.push(ccls);
    // Not an action target: clicking the figure shows or hides its route (main.js).
    const shown = ctx.shownRoutes.has(f.card);
    if (shown) classes.push('is-route-shown');
    const toggle = interactive(ccls)
      ? targetAttrs(ckey, ccls, `${card.name}, Hour ${f.hour}`)
      : `${targetAttrs(ckey, ccls, '')} tabindex="0" role="button" aria-pressed="${shown}" aria-label="${escapeHtml(`${card.name}, Hour ${f.hour}: ${shown ? 'hide' : 'show'} route`)}"`;
    const tip = interactive(ccls) ? `${card.name} (Hour ${f.hour})` : `${card.name} (Hour ${f.hour}) - click to ${shown ? 'hide' : 'show'} the route`;
    pieces.push(
      `<div class="${classes.join(' ')}" style="left:${5 + i * 34}%" data-route-toggle="${escapeHtml(f.card)}"${toggle} title="${escapeHtml(tip)}">
        ${art('figure-celebrity-neutral', { cls: 'sf-celeb__figure', alt: '' })}
        ${art(card.portrait, { cls: 'sf-celeb__medallion', alt: card.name })}
        <span class="sf-celeb__symbol"></span></div>`,
    );
  });
  figures.filter((f) => f.marker === h.id && !ctx.hideMarkers).forEach((f, i) => {
    const card = celebrityCard(f.card);
    pieces.push(
      `<div class="sf-dest sf-dest--${f.colour}" style="right:${3 + i * 26}%" title="${escapeHtml(`Destination of ${card.name} (Hour ${f.hour})`)}"><span class="sf-dest__hour">Hour ${f.hour}</span></div>`,
    );
  });

  const owner = (role) => state.volunteers[`${role}-${h.id}`];
  const sec = owner('security');
  const photo = owner('photographer');
  const count = q.length;
  const entranceCls = h.id === 'entrance' ? ' sf-hall--entrance' : '';
  const label = `${h.name}, ${count} of ${cap} in the queue`;
  const lines = [label];
  if (sec !== null && sec !== undefined) lines.push(`Security: ${ownerName(state, sec)}`);
  if (photo !== null && photo !== undefined) lines.push(`Photographer: ${ownerName(state, photo)}`);
  for (const f of here) lines.push(`${celebrityCard(f.card).name} is here`);
  const tagText = tags.get(key) ?? '';
  const flash = view.flash.halls.includes(h.id) ? '<div class="sf-flash"></div><div class="sf-flash__rays"></div>' : '';
  return `<div class="sf-hall${entranceCls} ${cls}${source}" data-hall="${h.id}" style="grid-area:${2 * h.row - 1} / ${2 * h.col - 1}; --cap:${cap}"${targetAttrs(key, cls, label)} title="${escapeHtml(lines.join('\n'))}">
    <div class="sf-hall__art">${art(h.art, { alt: '' })}</div>
    <div class="sf-hall__sign">${escapeHtml(h.name)}</div>
    <div class="sf-hall__pieces">${pieces.join('')}</div>
    <div class="sf-hall__vols">${volSpace(state, `security-${h.id}`, 'security', classer)}${volSpace(state, `photographer-${h.id}`, 'photographer', classer)}</div>
    <ol class="sf-queue" aria-label="${escapeHtml(h.name)} queue">${slots.join('')}</ol>
    ${hallTag(tagText)}${flash}
  </div>`;
}

function ropeHtml(state, r, classer) {
  const [a, b] = r.halls.map((id) => HALLS.find((h) => h.id === id));
  const horiz = a.row === b.row;
  const area = horiz ? `${2 * a.row - 1} / ${2 * Math.min(a.col, b.col)}` : `${2 * Math.min(a.row, b.row)} / ${2 * a.col - 1}`;
  return `<div class="sf-rope sf-rope--${horiz ? 'h' : 'v'}" style="grid-area:${area}" data-rope="${r.id}">${volSpace(state, r.id, 'usher', classer)}</div>`;
}

/**
 * The route overlay for celebrities: a dotted line in the celebrity colour,
 * the walked part faded, a start ring, a destination dot with a tick.
 * @param {{ card: string, colour: string, doneTo?: number, preview?: boolean }[]} routes
 */
export function routeSvg(routes) {
  if (!routes.length) return '';
  // Two layers: every route's line first, then every start and end circle on top, so
  // one route's line never hides another route's Hour number.
  const lines = [];
  const marks = [];
  routes.forEach((r, n) => {
    const card = celebrityCard(r.card);
    const pts = card.route.map(centre);
    const d = (arr) => `M${arr.map((p) => p.join(' ')).join(' L')}`;
    const done = r.doneTo > 0 ? `<path class="sf-route__casing" d="${d(pts.slice(0, r.doneTo + 1))}"/><path class="sf-route__done" d="${d(pts.slice(0, r.doneTo + 1))}"/>` : '';
    const rest = pts.slice(r.doneTo || 0);
    const [ex, ey] = pts[pts.length - 1];
    const [sx, sy] = pts[0];
    const off = ((n % 4) - 1.5) * 4; // up to four routes side by side do not lie exactly on each other
    const cls = `sf-cc--${r.colour}${r.preview ? ' sf-route--preview' : ''}${r.hour ? ' sf-route--numbered' : ''}`;
    const hourLabel = r.hour ? `<text class="sf-route__hour" x="${sx}" y="${sy}" text-anchor="middle" dominant-baseline="central">${r.hour}</text>` : '';
    lines.push(`<g class="${cls}" transform="translate(${off} ${off})">
        <defs><marker id="arr-${n}" viewBox="0 0 10 10" refX="5" refY="5" markerWidth="4" markerHeight="4" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 z" fill="var(--cc)"/></marker></defs>
        ${done}
        <path class="sf-route__casing" d="${d(rest)}"/>
        <path class="sf-route__line ${r.preview ? '' : 'sf-route__march'}" d="${d(rest)}" marker-mid="url(#arr-${n})"/>
      </g>`);
    marks.push(`<g class="${cls}" transform="translate(${off} ${off})">
        <circle class="sf-route__start" cx="${sx}" cy="${sy}" r="7"/>
        <circle class="sf-route__end" cx="${ex}" cy="${ey}" r="9"/>
        <path d="M${ex - 4} ${ey} l3 3 l6 -6" stroke="#fff" stroke-width="2.6" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
        ${hourLabel}
      </g>`);
  });
  return `<svg class="sf-board__overlay" viewBox="0 0 328 328" aria-hidden="true">${lines.join('')}${marks.join('')}</svg>`;
}

/**
 * The whole board.
 * @param {object} state the state to draw (real or display)
 * @param {{ classer: (key: string) => string, tags: Map<string, string>, view: object, routes: object[], walkingCard?: string|null, sourceHall?: string|null, hideMarkers?: boolean, dim?: boolean }} ctx
 */
export function renderBoard(state, ctx) {
  const full = { ...ctx, figures: figuresOnBoard(state), shownRoutes: new Set((ctx.routes || []).map((r) => r.card)) };
  return `<div class="sf-board${ctx.dim ? ' is-dimmed' : ''}"><div class="sf-board__grid">
    ${HALLS.map((h) => hallHtml(state, h, full)).join('')}
    ${ROPES.map((r) => ropeHtml(state, r, ctx.classer)).join('')}
    ${routeSvg(ctx.routes)}
  </div></div>`;
}

/** The text a full-hall tag shows. */
export function fullTag(state, hall) {
  return `FULL ${queue(state, hall).length}/${capacity(state)}`;
}

export { hallName, getConstants, ordinal, ICON };
