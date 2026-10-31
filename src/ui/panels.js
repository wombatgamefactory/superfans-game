// panels.js - everything on screen that is not the board: top bar, lanyards,
// This Hour, the action buttons, the pass ladder, the Selfie Exchange, the
// Swag market, the prompt bar and the generic fallback list.
//
// Pure functions from a context to markup. The context (built by main.js)
// holds the state to draw, the legal actions, who may act, and the pending
// action. Nothing here changes a state.

import {
  getConstants,
  CELEBRITY_CARDS,
  celebrityCard,
  achievementCard,
  swagCard,
  clubCard,
  slotsOfHour,
  figuresOnBoard,
  crewOnBoard,
  crewInSupply,
  emptySpaces,
  hallName,
  ADJACENT,
  getBlockReason,
  describeAction,
  frameLabel,
  clubCost,
  CLUB_OPTIONS,
  coffeeText,
} from '../engine/index.js';
import { art, artUrl, escapeHtml, crewArt, ICON, SELFIE_COLOURS, SYMBOL_WORD } from './art.js';
import { SLOT_DEFS, ARMABLE } from './action-targets.js';

const PHASES = [
  ['coffeeBreak', 'Coffee Break'],
  ['floor', 'On the Floor'],
  ['walk', 'Celebrity Walk'],
];

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

// ---- small parts ------------------------------------------------------------------

export function selfiesHtml(s, { cls = '' } = {}) {
  return `<div class="sf-selfies ${cls}">${SELFIE_COLOURS.map(
    (c) =>
      `<span class="sf-selfie sf-selfie--${c}${s[c] ? '' : ' sf-selfie--zero'}" title="${plural(s[c], `${c} Selfie`, `${c} Selfies`)} (${SYMBOL_WORD[c]})"><span class="sf-selfie__n">${s[c]}</span></span>`,
  ).join('')}</div>`;
}

export function dialHtml(v, { pour = false } = {}) {
  return `<div class="sf-dial${v >= 12 ? ' is-full' : ''}${pour ? ' is-pour' : ''}" style="--v:${v}" role="img" aria-label="${v} coffee of 12">
    <div class="sf-dial__face">${art(ICON.coffee, { cls: 'sf-dial__cup', alt: '' })}<span class="sf-dial__num">${v}</span></div></div>`;
}

function costChip(c, short = false) {
  if (c === 'free') return `<span class="sf-cost sf-cost--free">Free</span>`;
  if (c === 'selfie') return `<span class="sf-cost sf-cost--selfie">${art(ICON.selfie.red, { alt: '' })}1-3</span>`;
  if (c === 'var') return `<span class="sf-cost">${art(ICON.coffee, { alt: '' })}5+</span>`;
  if (typeof c === 'string') return `<span class="sf-cost">${art(ICON.coffee, { alt: '' })}${escapeHtml(c)}</span>`;
  return `<span class="sf-cost${short ? ' sf-cost--short' : ''}">${art(ICON.coffee, { alt: '' })}${c}</span>`;
}

function cardImg(id, label, { cls = '', w = '', target = '', extra = '' } = {}) {
  const style = w ? ` style="--w:${w}px"` : '';
  const attr = target ? ` data-target="${escapeHtml(target)}"` : '';
  return `<div class="sf-card sf-card--zoom sf-card--zoom-up ${cls}"${style}${attr} title="${escapeHtml(label)}"${extra}>${art(id, { alt: label })}</div>`;
}

// ---- top bar ---------------------------------------------------------------------

export function renderTopbar(ctx) {
  const { state, view } = ctx;
  const hours = [1, 2, 3, 4, 5].map((h) => {
    const entries = state.schedule.filter((s) => s.hour === h);
    const faces = entries
      .map((s) => {
        const c = celebrityCard(s.card);
        return art(c.portrait, { cls: `sf-hour__face sf-cc--${s.colour}`, alt: c.name });
      })
      .join('');
    const names = entries.map((s) => celebrityCard(s.card).name).join(' and ');
    // Hours still to come: click to show or hide their routes on the board (main.js).
    const toggle = h >= state.hour && entries.length && ctx.routeShown && !view.walk && state.phase !== 'final' && state.phase !== 'ended';
    if (!toggle) {
      return `<div class="sf-hour${h < state.hour ? ' is-done' : ''}${h === state.hour ? ' is-current' : ''}" title="Hour ${h}: ${escapeHtml(names)}">
      <span class="sf-hour__num">${h}</span>${faces}</div>`;
    }
    const on = entries.every((s) => ctx.routeShown(s.card));
    return `<div class="sf-hour${h === state.hour ? ' is-current' : ''}${on ? ' is-route-shown' : ''}" data-route-toggle="${entries.map((s) => escapeHtml(s.card)).join(',')}" role="button" tabindex="0" aria-pressed="${on}" aria-label="Hour ${h}: ${escapeHtml(names)}. ${on ? 'Hide' : 'Show'} the route on the board" title="Hour ${h}: ${escapeHtml(names)} - click to ${on ? 'hide' : 'show'} the route">
      <span class="sf-hour__num">${h}</span>${faces}</div>`;
  });
  const phase = view.walk ? 'walk' : state.phase === 'final' || state.phase === 'ended' ? 'walk' : state.phase === 'setup' ? 'coffeeBreak' : state.phase;
  const endedLabel = state.phase === 'final' || state.phase === 'ended';
  const phases = PHASES.map(
    ([id, label]) => `<span class="sf-phase${id === phase && !endedLabel ? ' is-current' : ''}">${label}</span>`,
  ).join('');
  const finalPill = endedLabel ? '<span class="sf-phase is-current">Final scoring</span>' : '';
  const undoOk = ctx.undoCount > 0;
  return `${art('logo-wordmark', { cls: 'sf-topbar__logo', alt: 'Superfans' })}
    <span class="sf-hour-marker" title="Hour ${state.hour} of 5"><span><small>HOUR</small>${state.hour}</span></span>
    <nav class="sf-hours" aria-label="Schedule">${hours.join('')}</nav>
    <div class="sf-phases">${phases}${finalPill}</div>
    <span class="sf-topbar__spacer"></span>
    <div class="sf-topbar__menu">
      <button class="sf-btn" data-act="undo" aria-label="Undo" ${undoOk ? '' : 'disabled'} title="${undoOk ? 'Undo your last action (until the turn is committed)' : 'Nothing to undo: undo works until another player acts.'}"><span aria-hidden="true">&#8630;</span> <span class="sf-btn__label">Undo</span></button>
      <button class="sf-btn" data-act="log" aria-label="Game log" title="Game log"><span aria-hidden="true">&#9776;</span> <span class="sf-btn__label">Log</span></button>
      <button class="sf-btn" data-act="rules" aria-label="How to play" title="How to play: the rules"><span aria-hidden="true">?</span> <span class="sf-btn__label">Rules</span></button>
      <button class="sf-btn sf-btn--icon" data-act="settings" title="Settings" aria-label="Settings">&#9881;</button>
    </div>`;
}

// ---- lanyards ----------------------------------------------------------------------

function seatChip(seat) {
  return seat.kind === 'bot'
    ? `<span class="sf-chip sf-chip--bot">${escapeHtml(seat.level)} bot</span>`
    : '<span class="sf-chip sf-chip--human">Human</span>';
}

function lanyardHtml(ctx, p, expanded) {
  const { state, seats } = ctx;
  const seat = seats[p.seat];
  const colour = p.colour;
  const active = state.toAct === p.seat && state.phase !== 'ended';
  const passed = p.passSlot > 0;
  const showHand = ctx.handVisible(p.seat);
  const crewLeft = crewInSupply(state, p.seat).length;
  const clubDef = p.club ? clubCard(p.club) : null;
  const first = state.firstPlayer === p.seat;
  const pour = ctx.view.flash.pour.includes(p.seat);
  const gain = ctx.view.flash.gain.includes(p.seat);
  const head = `
    <div class="sf-lanyard__head">
      <span class="sf-lanyard__avatar" style="background-image:url(${crewUrl(colour)})"></span>
      <div style="min-width:0">
        <div class="sf-lanyard__name">${escapeHtml(p.name)}</div>
        <div class="sf-lanyard__club">${clubDef ? escapeHtml(clubDef.name) : 'No Club'}</div>
        <div class="sf-lanyard__meta">${seatChip(seat)}${passed ? '<span class="sf-chip">Passed</span>' : ''}${first ? '<span class="sf-first-player" title="First Player" style="width:20px;height:26px"></span>' : ''}</div>
      </div>
      <div class="sf-vp" title="${p.vp} VP"><span>${p.vp}</span><span class="sf-vp__label">VP</span></div>
    </div>`;
  const supply = `
    <div class="sf-lanyard__row">
      <span class="sf-lanyard__label">Supply</span>
      <span class="sf-supply${crewLeft ? '' : ' sf-supply--out'}" title="${crewLeft} Crew in supply">${art(crewArt(colour), { alt: '' })}&times;${crewLeft}</span>
      <span class="sf-supply${p.hats ? '' : ' sf-supply--out'}" title="${p.hats} VIP hats left">${art('overlay-vip-hat', { alt: '' })}&times;${p.hats}</span>
      <span class="sf-supply${p.boxes ? '' : ' sf-supply--out'}" title="${p.boxes ? 'AAA box available' : 'AAA box used'}">${art('overlay-aaa-box', { alt: '' })}&times;${p.boxes}</span>
      <span class="sf-supply${p.volunteers ? '' : ' sf-supply--out'}" title="${p.volunteers} Volunteers left">${art(ICON.volunteer, { alt: '' })}&times;${p.volunteers}</span>
    </div>`;
  let body;
  if (!expanded) {
    body = `
    <div class="sf-lanyard__body">
      <div class="sf-lanyard__mini">
        <span title="${p.coffee} coffee">${art(ICON.coffee, { alt: '' })}${p.coffee}</span>
        ${SELFIE_COLOURS.map((c) => `<span title="${plural(p.selfies[c], `${c} Selfie`, `${c} Selfies`)}">${art(ICON.selfie[c], { alt: '' })}${p.selfies[c]}</span>`).join('')}
        <span title="Crew in supply">${art(crewArt(colour), { alt: '' })}${crewLeft}</span>
        <span title="Achievements in hand">${art(ICON.trophy, { alt: '' })}${p.hand.length}</span>
      </div>
    </div>`;
  } else {
    const hand = showHand
      ? p.hand.map((id) => cardImg(achievementCard(id).art, `Achievement: ${achievementCard(id).name}. ${achievementCard(id).text}`, { w: 84 })).join('')
      : p.hand.map(() => `<div class="sf-card sf-card--back" style="--w:84px">${art('back-achievement', { alt: 'Hidden Achievement' })}</div>`).join('');
    const club = clubDef ? cardImg(clubDef.art, `Your Club: ${clubDef.name}. ${clubDef.text}`, { w: 84, cls: 'sf-card--club' }) : '';
    body = `
    <div class="sf-lanyard__body">
      <div class="sf-lanyard__stats">
        ${dialHtml(p.coffee, { pour })}
        <div style="display:grid;gap:10px">
          <div class="sf-lanyard__row"><span class="sf-lanyard__label">Selfies</span>${selfiesHtml(p.selfies, { cls: gain ? 'is-gain-row' : '' })}</div>
          ${supply}
        </div>
      </div>
      <div>
        <div class="sf-lanyard__label" style="margin-bottom:6px">${showHand ? 'Your hand' : 'Hand'} &middot; ${plural(p.hand.length, 'Achievement', 'Achievements')} and Club</div>
        <div class="sf-lanyard__hand">${hand}${club}</div>
      </div>
    </div>`;
  }
  return `<article class="sf-lanyard sf-pc--${colour}${expanded ? '' : ' sf-lanyard--compact'}${active ? ' is-active' : ''}${seat.kind === 'bot' ? ' is-bot' : ''}${passed ? ' is-passed' : ''}${ctx.thinking === p.seat ? ' is-thinking' : ''}" data-seat="${p.seat}">
    <div class="sf-lanyard__strap">SUPERFANS</div>
    <div class="sf-lanyard__clip"></div>
    <div class="sf-lanyard__badge">${head}${body}</div>
  </article>`;
}

function crewUrl(colour) {
  return artUrl(crewArt(colour)) ?? '';
}

export function renderPlayers(ctx) {
  return ctx.state.players.map((p) => lanyardHtml(ctx, p, p.seat === ctx.viewer)).join('');
}

/** The viewing player's stats as a panel (tablet and phone show it in the side column). */
function myStatsHtml(ctx) {
  const p = ctx.state.players[ctx.viewer];
  if (!p) return '';
  const showHand = ctx.handVisible(p.seat);
  const clubDef = p.club ? clubCard(p.club) : null;
  const crewLeft = crewInSupply(ctx.state, p.seat).length;
  const hand = p.hand
    .map((id) => (showHand ? cardImg(achievementCard(id).art, `Achievement: ${achievementCard(id).name}`, { w: 64 }) : `<div class="sf-card sf-card--back" style="--w:64px">${art('back-achievement', { alt: '' })}</div>`))
    .join('');
  return `<section class="sf-panel sf-mystats sf-pc--${p.colour}" style="border-top:5px solid var(--pc)">
    <h2 class="sf-panel__title">${escapeHtml(p.name)} <small>${clubDef ? escapeHtml(clubDef.name) : ''}</small></h2>
    <div style="display:flex;gap:14px;align-items:center;flex-wrap:wrap">
      ${dialHtml(p.coffee, { pour: ctx.view.flash.pour.includes(p.seat) })}
      <div style="display:grid;gap:8px">${selfiesHtml(p.selfies)}
        <div class="sf-lanyard__row">
          <span class="sf-supply" title="Crew in supply">${art(crewArt(p.colour), { alt: '' })}&times;${crewLeft}</span>
          <span class="sf-supply${p.hats ? '' : ' sf-supply--out'}">${art('overlay-vip-hat', { alt: '' })}&times;${p.hats}</span>
          <span class="sf-supply${p.boxes ? '' : ' sf-supply--out'}">${art('overlay-aaa-box', { alt: '' })}&times;${p.boxes}</span>
          <span class="sf-supply${p.volunteers ? '' : ' sf-supply--out'}">${art(ICON.volunteer, { alt: '' })}&times;${p.volunteers}</span>
        </div>
      </div>
      <div class="sf-lanyard__hand">${hand}${clubDef ? cardImg(clubDef.art, `Club: ${clubDef.name}`, { w: 64 }) : ''}</div>
    </div>
  </section>`;
}

// ---- This Hour ---------------------------------------------------------------------

/** Route toggles work while no Walk is playing and the game is not in final scoring. */
function canToggle(ctx) {
  return !!ctx.routeShown && !ctx.view.walk && ctx.state.phase !== 'final' && ctx.state.phase !== 'ended';
}

/** A small "Show route / Hide route" switch after a route's hall list. */
function routeButton(ctx, entry) {
  if (!canToggle(ctx)) return '';
  const on = ctx.routeShown(entry.card);
  return ` <button type="button" class="sf-route-btn${on ? ' is-route-shown' : ''}" data-route-toggle="${escapeHtml(entry.card)}" aria-pressed="${on}">${on ? 'Hide route' : 'Show route'}</button>`;
}

function nowPanel(ctx) {
  const { state } = ctx;
  const hour = Math.min(state.hour, 5);
  const entries = slotsOfHour(state, hour);
  const main = entries[0];
  if (!main) return '';
  const c = celebrityCard(main.card);
  const walking = !!ctx.view.walk;
  const others = figuresOnBoard(state).filter((f) => !entries.includes(f));
  const second = entries[1];
  return `<section class="sf-panel sf-panel--star sf-cc--${main.colour}">
    <h2 class="sf-panel__title">${walking ? 'Walking now' : 'This Hour'} <small>Hour ${hour} of 5 &middot; rank ${c.rank}</small></h2>
    <div class="sf-now">
      <div class="sf-card sf-card--md sf-card--zoom" style="transform-origin:0 0" title="${escapeHtml(c.name)}">${art(c.art, { alt: `${c.name} card` })}</div>
      <div>
        <div class="sf-now__name">${escapeHtml(c.name)}</div>
        <div class="sf-now__facts">
          <div class="sf-now__fact"><span class="sf-chip" style="background:var(--cc);color:#fff">${main.colour} &middot; ${SYMBOL_WORD[main.colour]}</span><span class="sf-chip">+${c.coffee} coffee at Coffee Break</span></div>
          <div class="sf-route-text">${c.route.map((id) => escapeHtml(hallName(id))).join(' <i>&rarr;</i> ')}${routeButton(ctx, main)}</div>
          <div class="sf-now__fact">${art(ICON.trophy, { alt: '' })}<span class="sf-now__method">${escapeHtml(c.scoringText)}</span></div>
          ${second ? `<div class="sf-now__fact"><span class="sf-chip sf-cc--${second.colour}" style="background:var(--cc);color:#fff">then ${escapeHtml(celebrityCard(second.card).name)}</span><span class="sf-route-text">${celebrityCard(second.card).route.map((id) => escapeHtml(hallName(id))).join(' <i>&rarr;</i> ')}${routeButton(ctx, second)}</span></div>` : ''}
          <div class="sf-also">${others
            .map((f) => {
              const name = celebrityCard(f.card).name;
              const portrait = art(celebrityCard(f.card).portrait, { cls: 'sf-medallion', style: 'width:28px;height:28px;border-width:2px', alt: '' });
              if (!canToggle(ctx)) return `<span class="sf-also__item sf-cc--${f.colour}">${portrait}Hour ${f.hour}: ${escapeHtml(name)}</span>`;
              const on = ctx.routeShown(f.card);
              return `<button type="button" class="sf-also__item sf-also__item--toggle sf-cc--${f.colour}${on ? ' is-route-shown' : ''}" data-route-toggle="${escapeHtml(f.card)}" aria-pressed="${on}" title="Click to ${on ? 'hide' : 'show'} ${escapeHtml(name)}'s route on the board">${portrait}Hour ${f.hour}: ${escapeHtml(name)}</button>`;
            })
            .join('')}</div>
          ${canToggle(ctx) ? '<div class="sf-route-hint">Click any celebrity (here, on the board or in the Hours at the top) to show or hide their route.</div>' : ''}
        </div>
      </div>
    </div>
  </section>`;
}

// ---- actions -------------------------------------------------------------------------

function costOf(K, type, ctx) {
  switch (type) {
    case 'move2': return K.COSTS.COST_MOVE_2;
    case 'move3': return K.COSTS.COST_MOVE_3_CREW;
    case 'newNoob': return K.COSTS.COST_NEW_NOOB;
    case 'upgrade': return K.COSTS.COST_UPGRADE;
    case 'volunteer': return K.COSTS.COST_VOLUNTEER;
    case 'takeSelfie': return K.COSTS.COST_TAKE_SELFIE;
    case 'buySwag': return 'selfie';
    case 'clubPower': {
      const p = ctx.state.players[ctx.actorSeat ?? 0];
      if (!p || !p.club || !CLUB_OPTIONS[p.club]) return 'var';
      const costs = CLUB_OPTIONS[p.club].map((o) => clubCost(ctx.state, p.club, o));
      const lo = Math.min(...costs);
      const hi = Math.max(...costs);
      return lo === hi ? lo : `${lo}-${hi}`;
    }
    default: return 'free';
  }
}

/** The reason a main-action button is off: the engine's own words. */
export function typeReason(ctx, type) {
  const { state } = ctx;
  if (!ctx.canAct) return ctx.waitReason;
  const seat = state.toAct;
  const frame = ctx.frame;
  if (frame && frame.kind !== 'turn') return `You cannot do that now: you must ${frameLabel(state, frame)} first.`;
  const mine = crewOnBoard(state, seat);
  const c0 = mine[0] ?? crewInSupply(state, seat)[0];
  const crew = c0 ? c0.id : `c${seat}-1`;
  const to = c0 && c0.hall && ADJACENT[c0.hall] ? ADJACENT[c0.hall][0] : 'main-hall';
  const p = state.players[seat];
  const empty = emptySpaces(state)[0];
  const figs = figuresOnBoard(state);
  const probes = {
    move2: [{ type: 'move2', crew, to }],
    move3: [{ type: 'move3', crew, to }],
    newNoob: [{ type: 'newNoob', hall: 'entrance' }],
    upgrade: [{ type: 'upgrade', crew }],
    volunteer: [{ type: 'volunteer', space: empty ? empty.id : 'rope_01' }],
    takeSelfie: figs.map((f) => ({ type: 'takeSelfie', celebrity: f.card })),
    buySwag: state.swag.market.filter(Boolean).map((card) => ({ type: 'buySwag', card })),
    clubPower: p.club && CLUB_OPTIONS[p.club] ? CLUB_OPTIONS[p.club].map((option) => ({ type: 'clubPower', option })) : [{ type: 'clubPower', option: 'use' }],
    pass: [{ type: 'pass' }],
  }[type] ?? [];
  const reasons = [];
  for (const a of probes) {
    const r = getBlockReason(state, { ...a, player: seat });
    if (r) reasons.push(r);
  }
  if (type === 'takeSelfie' && reasons.length && !reasons.some((r) => /costs|passed/.test(r))) {
    return figs.length ? 'None of your Crew is in a hall with a celebrity.' : 'No celebrity is on the board.';
  }
  if (type === 'buySwag' && reasons.length && !reasons.some((r) => /passed/.test(r))) {
    return reasons.length ? 'You do not have enough Selfies of one colour for any Swag card.' : 'The Swag market is empty.';
  }
  const pick = reasons.find((r) => /passed|safety/.test(r)) ?? reasons.find((r) => /costs/.test(r)) ?? reasons[0];
  return pick ?? 'Not available right now.';
}

function actionsPanel(ctx) {
  const { state, legal } = ctx;
  const K = getConstants(state);
  const seat = ctx.actorSeat;
  const p = seat !== null && seat !== undefined ? state.players[seat] : null;
  const clubDef = p && p.club ? clubCard(p.club) : null;
  const types = new Set(legal.map((a) => a.type));
  const defs = [
    { id: 'move2', label: 'Move 2', sub: 'One Crew, up to 2 halls', icon: ICON.footprints },
    { id: 'move3', label: 'Move 1 Crew x3', sub: '3 Crew, 1 hall each', icon: ICON.moveArrows },
    { id: 'newNoob', label: 'New N00b', sub: 'Join the Entrance queue', icon: ICON.noob },
    { id: 'upgrade', label: 'Upgrade', sub: 'N00b to VIP, VIP to AAA', icon: 'overlay-vip-hat' },
    { id: 'volunteer', label: 'Volunteer', sub: 'Usher, Security, Photographer', icon: ICON.volunteer },
    { id: 'takeSelfie', label: 'Take a Selfie', sub: 'Crew with a celebrity', icon: ICON.photographer },
    { id: 'buySwag', label: 'Swag', sub: 'Pay Selfies for a card', icon: ICON.gift },
    {
      id: 'clubPower',
      label: clubDef && CLUB_OPTIONS[p.club] ? clubDef.power : 'Club Power',
      sub: clubDef ? clubDef.name : 'No Club this game',
      icon: ICON.star,
    },
    { id: 'pass', label: 'Pass', sub: 'Score or bin an Achievement', icon: ICON.rest },
  ];
  const coffee = p ? p.coffee : 0;
  const buttons = defs
    .map((d) => {
      const on = ctx.canAct && types.has(d.id);
      const cost = costOf(K, d.id, ctx);
      const short = typeof cost === 'number' && cost > coffee;
      const why = on ? '' : typeReason(ctx, d.id);
      const armed = ctx.pending.armed === d.id;
      const act = d.id === 'pass' ? 'pass' : d.id === 'clubPower' ? 'club' : `arm:${d.id}`;
      return `<button class="sf-action${armed ? ' is-armed' : ''}${on ? ' is-ready' : ''}" data-act="${act}" data-action="${d.id}" ${on ? `title="${escapeHtml(`${d.label}: ${d.sub}`)}"` : `aria-disabled="true" title="${escapeHtml(why)}"`}>
        ${art(d.icon, { cls: 'sf-action__icon', alt: '' })}
        <span class="sf-action__label">${escapeHtml(d.label)}</span>
        <span class="sf-action__sub">${escapeHtml(d.sub)}</span>
        ${costChip(cost, short && !on)}
        ${on ? '' : `<span class="sf-action__why">${escapeHtml(why)}</span>`}
      </button>`;
    })
    .join('');
  const note = ctx.canAct && p ? `${coffee} coffee to spend` : ctx.view.walk ? 'closed during the Walk' : 'waiting';
  return `<section class="sf-panel sf-actions-panel sf-panel--act">
    <h2 class="sf-panel__title">${art(ICON.coffee, { alt: '' })}Actions <small>${escapeHtml(note)}</small></h2>
    <div class="sf-actions">${buttons}</div>
  </section>`;
}

// ---- pass ladder ------------------------------------------------------------------------

function passPanel(ctx) {
  const { state, legal } = ctx;
  const K = getConstants(state);
  const markers = { 1: [], 2: [], 3: [], 4: [] };
  for (const p of state.players) if (p.passSlot > 0) markers[Math.min(p.passSlot, 4)].push(p);
  const rewards = legal.filter((a) => a.type === 'passReward');
  const slotNow = rewards.length && ctx.canAct ? Math.min(state.players[state.toAct].passSlot + 1, K.PASS.PASS_SLOTS) : 0;
  const rung = (n, title, text) => {
    const reward = K.PASS.PASS_SLOT_REWARD[n];
    const lit = slotNow === n;
    const btns = lit
      ? `<div class="sf-rung__btns">${rewards.map((a) => `<button class="sf-btn sf-btn--go" data-act="reward:${a.reward}">+${reward} ${a.reward === 'coffee' ? 'coffee' : 'VP'}</button>`).join('')}</div>`
      : '';
    const ms = markers[n].map((p) => `<span class="sf-pass-marker sf-pc--${p.colour}" title="${escapeHtml(p.name)} passed here"></span>`).join('');
    return `<div class="sf-rung${lit ? ' is-legal' : ''}"><b>${title}</b>${text}${btns}<div class="sf-rung__markers">${ms}</div></div>`;
  };
  return `<section class="sf-panel sf-panel--pass">
    <h2 class="sf-panel__title">${art(ICON.rest, { alt: '' })}Pass ladder</h2>
    <div class="sf-ladder">
      ${rung(1, '1st pass', `Score or bin an Achievement. First to pass: +${K.PASS.PASS_FIRST_PASSER_COFFEE} coffee`)}
      ${rung(2, `+${K.PASS.PASS_SLOT_REWARD[2]}`, 'coffee or VP')}
      ${rung(3, `+${K.PASS.PASS_SLOT_REWARD[3]}`, 'coffee or VP')}
      ${rung(4, `+${K.PASS.PASS_SLOT_REWARD[4]}`, 'each turn')}
    </div>
  </section>`;
}

// ---- Selfie Exchange ----------------------------------------------------------------------------

const ANY = '<span class="sf-trade__any"></span>';

function exchangePanel(ctx) {
  const { state, legal } = ctx;
  const K = getConstants(state);
  const seat = ctx.actorSeat;
  const p = seat !== null && seat !== undefined ? state.players[seat] : null;
  const byRate = (rate) => legal.filter((a) => a.type === 'exchange' && a.rate === rate);
  const owned = p ? SELFIE_COLOURS.reduce((n, c) => n + p.selfies[c], 0) : 0;
  const windowOpen = ctx.frame && ['turn', 'passTurn', 'finalWindow'].includes(ctx.frame.kind);
  const reason = (rate, need) => {
    if (!ctx.canAct) return ctx.waitReason;
    if (!windowOpen) return 'The Selfie Exchange is open at the start of your own turn, and in final scoring.';
    if (owned < need) return `You hold ${plural(owned, 'Selfie', 'Selfies')} and this trade needs ${need}.`;
    if (rate === 'E1' && p.coffee >= K.LIMITS.COFFEE_CAP) return `You are on ${K.LIMITS.COFFEE_CAP} coffee, so this trade would gain nothing.`;
    return 'You cannot make this trade now.';
  };
  const row = (rate, need, inner, label) => {
    const list = byRate(rate);
    const on = ctx.canAct && list.length > 0;
    return `<button class="sf-trade" data-act="exchange:${rate}" ${on ? `title="${escapeHtml(label)}"` : `aria-disabled="true" title="${escapeHtml(reason(rate, need))}"`}>${inner}<span class="sf-trade__free">${on ? 'free' : ''}</span></button>`;
  };
  const e1 = K.EXCHANGE.EXCHANGE_E1;
  const e2 = K.EXCHANGE.EXCHANGE_E2;
  const e3 = K.EXCHANGE.EXCHANGE_E3;
  const rep = (n) => ANY.repeat(n);
  const rows = [
    row('E1', e1.PAY, `${rep(e1.PAY)}<span class="sf-trade__arrow">&rarr;</span>${art(ICON.coffee, { alt: '1 coffee' })}${e1.GAIN_COFFEE}`, `Swap ${e1.PAY} Selfies of any colours for ${e1.GAIN_COFFEE} coffee`),
    row('E2', e2.PAY, `${rep(e2.PAY)}<span class="sf-trade__arrow">&rarr;</span>${ANY}<span title="a different colour">&ne;</span>`, `Swap ${e2.PAY} Selfies for 1 Selfie of a colour you did not pay`),
    row('E3', e3.PAY, `${rep(e3.PAY)}<span class="sf-trade__arrow">&rarr;</span>${art(ICON.vp, { alt: '' })}${e3.GAIN_VP} VP`, `Swap ${e3.PAY} Selfies for ${e3.GAIN_VP} VP`),
  ];
  // Club conversions: Strike a Pose (Selfie Stick Squad) and Rare Finds (TCG Traders) are free actions too
  const strike = legal.filter((a) => a.type === 'strikeAPose');
  const rare = legal.filter((a) => a.type === 'rareFinds');
  const club = p && p.club ? clubCard(p.club) : null;
  if (club && (p.club === 'club_09' || p.club === 'club_07')) {
    const list = p.club === 'club_09' ? strike : rare;
    const on = ctx.canAct && list.length > 0;
    const act = p.club === 'club_09' ? 'convert:strikeAPose' : 'convert:rareFinds';
    const why = !ctx.canAct ? ctx.waitReason : windowOpen || (ctx.frame && ctx.frame.kind === 'squadWindow') ? (p.club === 'club_09' ? 'Strike a Pose costs 1 coffee and you have none.' : 'Rare Finds needs 2 Selfies of one colour, and works once a turn.') : 'Open at the start of your own turn.';
    rows.push(`<button class="sf-trade" data-act="${act}" ${on ? `title="${escapeHtml(club.text)}"` : `aria-disabled="true" title="${escapeHtml(why)}"`}>${art(ICON.star, { alt: '' })}<b>${escapeHtml(club.power)}</b><span class="sf-trade__free">${on ? 'free' : ''}</span></button>`);
  }
  return `<section class="sf-panel">
    <h2 class="sf-panel__title">${art(ICON.selfie.orange, { alt: '' })}Selfie Exchange</h2>
    <div class="sf-exchange">${rows.join('')}</div>
  </section>`;
}

// ---- Swag market --------------------------------------------------------------------------------------

function marketPanel(ctx) {
  const { state } = ctx;
  const K = getConstants(state);
  const p = ctx.actorSeat !== null && ctx.actorSeat !== undefined ? state.players[ctx.actorSeat] : null;
  const slots = state.swag.market
    .map((id) => {
      if (id === null) return `<div class="sf-market__slot"><div class="sf-card-slot" title="Empty"></div></div>`;
      const card = swagCard(id);
      const cost = K.SWAG.SWAG_COST[id];
      const key = `swag:${id}`;
      const cls = ctx.classer(key);
      const have = p ? p.selfies[card.colour] : 0;
      const short = have < cost;
      const price = Array.from({ length: cost }, () => art(ICON.selfie[card.colour], { alt: card.colour })).join('');
      const on = cls === 'is-legal' || cls === 'is-illegal';
      return `<div class="sf-market__slot">
        <div class="sf-card sf-card--zoom sf-card--zoom-up ${cls}" data-target="${key}"${on ? ' tabindex="0" role="button"' : ''} aria-label="${escapeHtml(`${card.name}, costs ${cost} ${card.colour} Selfies`)}" title="${escapeHtml(`${card.name}: ${card.text}`)}">${art(card.art, { alt: card.name })}</div>
        <span class="sf-price${short && p ? ' sf-price--short' : ''}" title="${cost} ${card.colour} Selfie${cost === 1 ? '' : 's'}">${price}</span>
      </div>`;
    })
    .join('');
  return `<section class="sf-panel sf-panel--swag">
    <h2 class="sf-panel__title">${art(ICON.gift, { alt: '' })}Swag market <small>pay Selfies of one colour</small></h2>
    <div class="sf-market">
      ${slots}
      <div class="sf-market__deck" data-count="${state.swag.deck.length}"><div class="sf-card sf-card--back">${art('back-swag-red', { alt: 'Swag deck' })}</div></div>
    </div>
  </section>`;
}

// ---- generic layer ---------------------------------------------------------------------------------------

/** The action types the bespoke interface has a widget for. */
export const HANDLED_TYPES = new Set([
  ...Object.keys(SLOT_DEFS),
  'pass', 'clubPower', 'scoreAchievement', 'discardAchievement', 'passReward', 'exchange', 'strikeAPose', 'rareFinds',
  'endConversions', 'stopMoving', 'effectDone', 'effectGainSelfies', 'effectConvertSelfie', 'effectChooseAchievement',
  'keepAchievement', 'discardSelfie',
]);

/** Every legal action as a labelled button. */
export function genericPanel(ctx, { only = null, title = 'Every legal action' } = {}) {
  const list = ctx.legal.map((a, i) => ({ a, i })).filter(({ a }) => (only ? only(a) : true));
  if (!list.length) return '';
  const dec = ctx.decision;
  return `<section class="sf-panel sf-generic" data-generic="1">
    <h2 class="sf-panel__title">${escapeHtml(title)} <small>${list.length}</small></h2>
    ${dec ? `<p class="sf-generic__prompt">${escapeHtml(dec.prompt)}</p>` : ''}
    <div class="sf-generic__list">${list
      .map(({ a, i }) => `<button class="sf-btn sf-generic__btn" data-gen="${i}" title="${escapeHtml(describeAction(ctx.state, a))}">${escapeHtml(describeAction(ctx.state, a))}</button>`)
      .join('')}</div>
  </section>`;
}

// ---- the side column ---------------------------------------------------------------------------------------

export function renderSide(ctx) {
  const parts = [];
  parts.push(nowPanel(ctx));
  if (ctx.generic) {
    parts.push(genericPanel(ctx));
    parts.push(marketPanel({ ...ctx, classer: () => '' }));
    return parts.join('');
  }
  parts.push(myStatsHtml(ctx));
  if (ctx.view.walk) parts.push(walkFeed(ctx));
  parts.push(actionsPanel(ctx));
  const unmapped = genericPanel(ctx, { only: (a) => !HANDLED_TYPES.has(a.type), title: 'More options' });
  if (unmapped) parts.push(unmapped);
  parts.push(`<div class="sf-side-row">${passPanel(ctx)}${exchangePanel(ctx)}</div>`);
  parts.push(marketPanel(ctx));
  return parts.join('');
}

function walkFeed(ctx) {
  const lines = ctx.view.walk.feed || [];
  if (!lines.length) return '';
  return `<section class="sf-panel sf-panel--star">
    <h2 class="sf-panel__title">Walk feed <small>Hour ${ctx.state.hour}</small></h2>
    <div class="sf-log">${lines.map((l) => `<div class="sf-log__item${l.colour ? ` sf-pc--${l.colour}` : ''}"><span>${escapeHtml(l.text)}</span></div>`).join('')}</div>
  </section>`;
}

// ---- the prompt bar ---------------------------------------------------------------------------------------------

const STEP_TEXT = {
  move2: ['Pick one of your Crew to move', 'Pick a hall, up to 2 halls away'],
  move3: ['Pick your first Crew', 'Pick a hall next to it'],
  moveStep: ['Pick another Crew that has not moved', 'Pick a hall next to it'],
  newNoob: ['Pick the hall for your new N00b'],
  upgrade: ['Pick one of your Crew to upgrade (N00b to VIP, VIP to AAA)'],
  volunteer: ['Pick an empty space: Security or Photographer in a hall, or an Usher on a rope'],
  takeSelfie: ['Pick the celebrity to take a Selfie with'],
  buySwag: ['Pick a Swag card to buy'],
  placeOpeningCrew: ['Pick a hall for your opening Crew'],
};

/** What the prompt bar says: { step, text, cost, cancel, done: [{label, act}] , tone }. */
export function promptFor(ctx) {
  const { state } = ctx;
  if (ctx.view.walk) return { tone: 'walk' };
  if (state.phase === 'ended') return { tone: 'idle', text: 'The convention is over.' };
  if (!ctx.canAct) return { tone: 'wait', text: ctx.waitText };
  const frame = ctx.frame;
  const done = [];
  const kinds = new Set(ctx.legal.map((a) => a.type));
  if (kinds.has('stopMoving')) done.push({ label: 'Done moving', act: 'do:stopMoving' });
  if (kinds.has('endConversions')) done.push({ label: 'Done', act: 'do:endConversions' });
  if (kinds.has('effectDone')) done.push({ label: 'Done', act: 'do:effectDone' });
  const pend = ctx.pending;
  const K = getConstants(state);
  if (pend.armed) {
    const texts = STEP_TEXT[pend.armed] ?? ['Pick a target'];
    const i = Math.min(pend.picked.length, texts.length - 1);
    const cost = costOf(K, pend.armed, ctx);
    const total = SLOT_DEFS[pend.armed] ? SLOT_DEFS[pend.armed].length : 1;
    return {
      tone: 'act',
      step: total > 1 ? `Step ${pend.picked.length + 1} of ${total}` : 'Pick',
      text: `${texts[i]}${typeof cost === 'number' ? ` &middot; <b>${cost} coffee</b>` : ''}`,
      cancel: true,
      done,
    };
  }
  if (frame && frame.kind === 'turn') {
    const p = state.players[state.toAct];
    return { tone: 'act', step: 'Your turn', text: `${escapeHtml(p.name)}: choose an action &middot; <b>${coffeeText(p.coffee)}</b>`, done };
  }
  if (frame && frame.kind === 'passTurn') {
    return { tone: 'act', step: 'Passed', text: `${escapeHtml(state.players[state.toAct].name)}: take your pass reward on the ladder`, done };
  }
  const label = frame ? frameLabel(state, frame) : '';
  let text = label ? label.charAt(0).toUpperCase() + label.slice(1) : 'Your decision';
  if (ctx.pending.picked.length) text += ' (pick the next target)';
  return { tone: 'act', step: frame && frame.kind === 'effect' ? 'Card' : 'Your move', text: escapeHtml(text), cancel: pend.picked.length > 0, done };
}

export function renderPrompt(ctx) {
  const pr = promptFor(ctx);
  if (pr.tone === 'walk') {
    const w = ctx.view.walk;
    return `<div class="sf-banner sf-banner--walk" role="status" aria-live="polite"><span class="sf-banner__step">${escapeHtml(w.stepText || 'Celebrity Walk')}</span>
      <span class="sf-banner__text">${escapeHtml(w.text || '')}</span>
      <button class="sf-btn sf-btn--ghost" data-act="walk-fast">2&times; speed</button><button class="sf-btn sf-btn--ghost" data-act="walk-skip">Skip</button></div>`;
  }
  const doneBtns = (pr.done || []).map((d) => `<button class="sf-btn sf-btn--go" data-act="${d.act}">${escapeHtml(d.label)}</button>`).join('');
  const cancel = pr.cancel ? '<button class="sf-btn sf-btn--ghost" data-act="cancel">Cancel</button>' : '';
  return `<div class="sf-banner${pr.tone === 'wait' ? ' sf-banner--wait' : ''}" role="status" aria-live="polite">
    ${pr.step ? `<span class="sf-banner__step">${escapeHtml(pr.step)}</span>` : ''}
    <span class="sf-banner__text">${pr.tone === 'wait' || pr.tone === 'idle' ? escapeHtml(pr.text) : pr.text}</span>
    ${doneBtns}${cancel}</div>`;
}

/** The refusal or info toast over the stage. */
export function renderToast(ctx) {
  const n = ctx.view.notice;
  if (!n) return '';
  const icon = n.kind === 'refuse' ? ICON.cross : n.kind === 'good' ? ICON.tick : ICON.star;
  return `<div class="sf-toast sf-toast--${n.kind}" role="${n.kind === 'refuse' ? 'alert' : 'status'}" data-toast="${n.id}">${art(icon, { alt: '' })}<span>${escapeHtml(n.text)}${n.sub ? `<small>${escapeHtml(n.sub)}</small>` : ''}</span></div>`;
}

export function renderFloats(ctx) {
  return ctx.view.floats
    .map((f) => `<span class="sf-float sf-pc--${f.colour}" style="left:${f.x}%;top:${f.y}%" data-float="${f.id}">${f.html}</span>`)
    .join('');
}

export { CELEBRITY_CARDS };
