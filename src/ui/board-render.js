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
import { art, artSize, escapeHtml, crewPiece, celebFigureArt, ICON } from './art.js';

const OWNER_WORD = { security: 'Security', photographer: 'Photographer', usher: 'Usher' };

/**
 * Where a route passes through a hall, in the route overlay's 328 x 328 viewBox
 * (each hall is 100 x 100, with 14 between halls). Horizontally the middle of the
 * hall; vertically a little over a quarter of the way down, through the hall art,
 * so three routes side by side (lanes at 21 / 28 / 35) all stay above the
 * Security / Photographer spaces (y 41-55) and the queue (58+).
 */
const ROUTE_Y = 28;
function centre(hall) {
  const h = HALLS.find((x) => x.id === hall);
  return [50 + (h.col - 1) * 114, ROUTE_Y + (h.row - 1) * 114];
}

/*
 * Where the pieces stand in a hall, in the same units (a hall is 100 x 100; the
 * board is 100cqw = 328 units, so 1cqw = 3.28). These mirror style.css
 * (.sf-celeb: 7.5cqw x 11cqw, bottom 9% of the art; .sf-dest: a 4.2cqw circle,
 * top 12% of the art); change them together.
 */
const CELEB_LEFT = 5;      // % of the hall width, first figure
const CELEB_STEP = 34;     // % between figures sharing a hall
const DEST_RIGHT = 3;      // % from the right, first destination marker
const DEST_STEP = 15;      // % between destination markers sharing a hall
const CELEB_BOX = { w: 24.6, top: 16.7, bottom: 55.5 };
const DEST_BOX = { w: 13.8, top: 7, bottom: 20.8 };

/**
 * Gaps cut out of the route lines so a line passes behind a celebrity figure or
 * a destination chair instead of across it. Rectangles in overlay units.
 */
function routeHoles(figures, hideMarkers) {
  const holes = [];
  for (const h of HALLS) {
    const x0 = (h.col - 1) * 114;
    const y0 = (h.row - 1) * 114;
    // the hall's name sign, just inside the top of the hall: 58% wide, y 1-11; the
    // Entrance plate is 70% wide and taller, y 1-16
    if (h.id === 'entrance') holes.push([x0 + 14, y0 - 0.5, 72, 18]);
    else holes.push([x0 + 20, y0 - 0.5, 60, 13]);
    // the Security and Photographer spaces (bottom right of the art: x 67-97, y 42-56)
    holes.push([x0 + 65.5, y0 + 40.5, 33, 17]);
    figures.filter((f) => f.figure === h.id).forEach((f, i) => {
      const left = x0 + CELEB_LEFT + i * CELEB_STEP;
      const size = artSize(celebFigureArt(celebrityCard(f.card)));
      const height = CELEB_BOX.bottom - CELEB_BOX.top;
      const imgH = 36.1; // the figure image, without the disc under it
      const w = size ? Math.min(CELEB_BOX.w * 1.5, (imgH * size[0]) / size[1]) : CELEB_BOX.w;
      const cx = left + CELEB_BOX.w / 2;
      holes.push([cx - w / 2 - 1.5, y0 + CELEB_BOX.top - 1.5, w + 3, height + 1.5]);
      // the name plate under the figure (centred, about 35 wide, y 52-59)
      holes.push([cx - 19, y0 + 51, 38, 9.5]);
    });
    if (hideMarkers) continue;
    figures.filter((f) => f.marker === h.id).forEach((f, i) => {
      const right = x0 + 100 - (DEST_RIGHT + i * DEST_STEP);
      holes.push([right - DEST_BOX.w - 1.2, y0 + DEST_BOX.top - 1.2, DEST_BOX.w + 2.4, DEST_BOX.w + 2.4, DEST_BOX.w / 2 + 1.2]);
    });
  }
  // the Usher space on each rope, halfway between the two hall centres (11.8 units across)
  for (const r of ROPES) {
    const [a, b] = r.halls.map((id) => HALLS.find((x) => x.id === id));
    const cx = 50 + ((a.col + b.col) / 2 - 1) * 114;
    const cy = 50 + ((a.row + b.row) / 2 - 1) * 114;
    holes.push([cx - 8, cy - 8, 16, 16, 8]);
  }
  return holes;
}

/** The point `dist` along a polyline. */
function pointAt(pts, dist) {
  let left = dist;
  for (let i = 1; i < pts.length; i += 1) {
    const [ax, ay] = pts[i - 1];
    const [bx, by] = pts[i];
    const seg = Math.hypot(bx - ax, by - ay);
    if (left <= seg || i === pts.length - 1) {
      const t = seg ? Math.min(1, left / seg) : 0;
      return [ax + (bx - ax) * t, ay + (by - ay) * t];
    }
    left -= seg;
  }
  return pts[0];
}

function polyLength(pts) {
  let len = 0;
  for (let i = 1; i < pts.length; i += 1) len += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  return len;
}

const TOKEN_GAP = 28;     // viewBox units between number discs ("marching ants")
const TOKEN_SPEED = 22;   // viewBox units per second
const LANE = 7;           // viewBox units between side-by-side routes

/**
 * The number discs that travel along a route (the celebrity's Hour, or a plain
 * disc when there is none). Evenly spaced and staggered so the stream is steady;
 * still, evenly spaced discs when `animate` is off (Settings > Route numbers,
 * which follows the system's reduced-motion setting until the player picks).
 */
function routeTokens(pts, label, animate) {
  const len = polyLength(pts);
  if (len < 1) return '';
  const n = Math.max(1, Math.round(len / TOKEN_GAP));
  const text = label ? `<text class="sf-route__tokentext" text-anchor="middle" dominant-baseline="central">${escapeHtml(label)}</text>` : '';
  const disc = `<circle class="sf-route__tokendisc" r="${label ? 4.4 : 2.6}"/>${text}`;
  if (!animate) {
    const out = [];
    for (let i = 1; i < n; i += 1) {
      const [x, y] = pointAt(pts, (len * i) / n);
      out.push(`<g class="sf-route__token" transform="translate(${x.toFixed(1)} ${y.toFixed(1)})">${disc}</g>`);
    }
    return out.join('');
  }
  const dur = (len / TOKEN_SPEED).toFixed(2);
  const path = `M${pts.map((p) => p.join(' ')).join(' L')}`;
  const out = [];
  for (let i = 0; i < n; i += 1) {
    const begin = `-${((len / TOKEN_SPEED) * i / n).toFixed(2)}s`;
    out.push(`<g class="sf-route__token" opacity="0">${disc}
        <animateMotion dur="${dur}s" begin="${begin}" repeatCount="indefinite" calcMode="paced" path="${path}"/>
        <animate attributeName="opacity" dur="${dur}s" begin="${begin}" repeatCount="indefinite" values="0;1;1;0" keyTimes="0;0.06;0.9;1"/></g>`);
  }
  return out.join('');
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
    // keep in step with routeHoles(), which leaves a gap in the route line here
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
      `<div class="${classes.join(' ')}" style="left:${CELEB_LEFT + i * CELEB_STEP}%" data-route-toggle="${escapeHtml(f.card)}"${toggle} title="${escapeHtml(tip)}">
        ${art(celebFigureArt(card), { cls: 'sf-celeb__figure', alt: card.name })}
        <span class="sf-celeb__name"><span class="sf-celeb__hour">${f.hour}</span><span class="sf-celeb__symbol"></span>${escapeHtml(card.name)}</span></div>`,
    );
  });
  figures.filter((f) => f.marker === h.id && !ctx.hideMarkers).forEach((f, i) => {
    const card = celebrityCard(f.card);
    pieces.push(
      `<div class="sf-dest sf-cc--${f.colour}" style="right:${DEST_RIGHT + i * DEST_STEP}%" title="${escapeHtml(`Destination of ${card.name} (Hour ${f.hour})`)}"><span class="sf-dest__hour">${f.hour}</span></div>`,
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
 * The route overlay for celebrities: a solid line in the celebrity colour with a
 * white and dark edge, the celebrity's Hour number travelling along it, the walked
 * part faded and a small dot where it ends. There are no start or finish badges:
 * the celebrity figure (its name plate carries the Hour) marks the start and the
 * numbered destination marker in the hall marks the finish. All of it is drawn
 * behind the pieces (see routeHoles), so a route never covers a figure or a space.
 * Each route's group carries data-route-hour, for the tests.
 * @param {{ card: string, colour: string, hour?: number, tag?: number, doneTo?: number, preview?: boolean }[]} routes
 */
export function routeSvg(routes, holes = [], animate = true) {
  if (!routes.length) return '';
  // Three layers: every route's line, then every end dot, then every moving number.
  const lines = [];
  const ends = [];
  const tokens = [];
  // Lanes: each route shown gets its own lane, in Hour order, LANE apart and centred.
  // The whole route shifts diagonally by its lane offset, which moves horizontal
  // stretches up/down and vertical stretches left/right by the same amount, so two
  // routes sharing a stretch run side by side and never on top of each other.
  const byHour = routes.map((r, i) => ({ i, key: [r.hour ?? r.tag ?? 9, r.card] }))
    .sort((a, b) => a.key[0] - b.key[0] || String(a.key[1]).localeCompare(String(b.key[1])));
  const lane = new Map(byHour.map((x, k) => [x.i, (k - (routes.length - 1) / 2) * LANE]));
  routes.forEach((r, n) => {
    const card = celebrityCard(r.card);
    const pts = card.route.map(centre);
    const d = (arr) => `M${arr.map((p) => p.join(' ')).join(' L')}`;
    const done = r.doneTo > 0 ? `<path class="sf-route__casing" d="${d(pts.slice(0, r.doneTo + 1))}"/><path class="sf-route__done" d="${d(pts.slice(0, r.doneTo + 1))}"/>` : '';
    const rest = pts.slice(r.doneTo || 0);
    const [ex, ey] = pts[pts.length - 1];
    const off = lane.get(n);
    const cls = `sf-cc--${r.colour}${r.preview ? ' sf-route--preview' : ''}`;
    const hourAttr = r.hour ? ` data-route-hour="${r.hour}"` : '';
    lines.push(`<g class="${cls}" transform="translate(${off} ${off})"${hourAttr}>
        ${done}
        <path class="sf-route__edge" d="${d(rest)}"/>
        <path class="sf-route__casing" d="${d(rest)}"/>
        <path class="sf-route__line" d="${d(rest)}"/>
      </g>`);
    ends.push(`<g class="${cls}" transform="translate(${off} ${off})"><circle class="sf-route__end" cx="${ex}" cy="${ey}" r="3.4"/></g>`);
    tokens.push(`<g class="${cls}" transform="translate(${off} ${off})">${routeTokens(rest, r.hour ?? r.tag ?? '', animate)}</g>`);
  });
  let mask = '';
  let masked = '';
  if (holes.length) {
    // a fixed id: the page holds one board, and an unchanged board must render to the
    // same markup (main.js skips the redraw when nothing changed)
    const id = 'sf-route-mask';
    const cuts = holes.map(([x, y, w, h, rx = 4]) => `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}" rx="${rx}" fill="#000"/>`).join('');
    mask = `<defs><mask id="${id}" maskUnits="userSpaceOnUse" x="-20" y="-20" width="368" height="368"><rect x="-20" y="-20" width="368" height="368" fill="#fff"/>${cuts}</mask></defs>`;
    masked = ` mask="url(#${id})"`;
  }
  return `<svg class="sf-board__overlay" viewBox="0 0 328 328" aria-hidden="true">${mask}<g${masked}>${lines.join('')}${ends.join('')}${tokens.join('')}</g></svg>`;
}

/**
 * The whole board.
 * @param {object} state the state to draw (real or display)
 * @param {{ classer: (key: string) => string, tags: Map<string, string>, view: object, routes: object[], walkingCard?: string|null, sourceHall?: string|null, hideMarkers?: boolean, dim?: boolean }} ctx
 */
export function renderBoard(state, ctx) {
  const full = { ...ctx, figures: figuresOnBoard(state), shownRoutes: new Set((ctx.routes || []).map((r) => r.card)) };
  const holes = ctx.routes && ctx.routes.length ? routeHoles(full.figures, ctx.hideMarkers) : [];
  return `<div class="sf-board${ctx.dim ? ' is-dimmed' : ''}"><div class="sf-board__grid">
    ${HALLS.map((h) => hallHtml(state, h, full)).join('')}
    ${ROPES.map((r) => ropeHtml(state, r, ctx.classer)).join('')}
    ${routeSvg(ctx.routes || [], holes, ctx.animateRoutes !== false)}
  </div></div>`;
}

/** The text a full-hall tag shows. */
export function fullTag(state, hall) {
  return `FULL ${queue(state, hall).length}/${capacity(state)}`;
}

export { hallName, getConstants, ordinal, ICON };
