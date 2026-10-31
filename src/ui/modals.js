// modals.js - every popup: the hotseat handover curtain, the Pass Achievement
// choice, card pickers, Selfie pickers, exchange choices, the log, settings,
// rules and the pass confirmation.
//
// modalFor(ctx) works out which popup the CURRENT decision needs (so it can
// never be stale: it is derived from the state each render); popups the player
// opens themselves (log, settings, exchange picker ...) live in view.modal.
// Buttons in a popup carry data-do="<index into the legal list>" (apply that
// action) or data-act="..." for page-level buttons.

import {
  achievementCard,
  swagCard,
  getConstants,
  hallName,
  celebrityCard,
  clubCard,
  CELEBRITY_CARDS,
  EVENTS,
  coffeeText,
} from '../engine/index.js';
import { art, escapeHtml, ICON, SELFIE_COLOURS, SYMBOL_WORD } from './art.js';
import { previewAchievementVp } from './preview.js';
import { selfiesHtml } from './panels.js';
import { howToPlayHtml } from './how-to-play.js'; // T17

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/** Selfie icons for a { green, red, orange } object. */
export function selfieIcons(s) {
  return SELFIE_COLOURS.map((c) => Array.from({ length: s[c] || 0 }, () => art(ICON.selfie[c], { cls: 'sf-icon', alt: c })).join('')).join('');
}

// ---- which popup does this decision need? ------------------------------------------------

/** @returns {{ kind: string, [k: string]: any } | null} */
export function modalFor(ctx) {
  const { view } = ctx;
  if (ctx.needsHandover) return { kind: 'handover', seat: ctx.state.toAct };
  if (view.modal) return view.modal;
  if (!ctx.canAct || ctx.generic) return null;
  const frame = ctx.frame;
  if (!frame) return null;
  const types = new Set(ctx.legal.map((a) => a.type));
  if (frame.kind === 'passAchievement') return { kind: 'pass-achievement' };
  if (frame.kind === 'achieverKeep') return { kind: 'pick-card', title: 'Keep one Achievement', note: 'The other is discarded unscored.', type: 'keepAchievement' };
  if (frame.kind === 'discardToLimit') return { kind: 'discard-selfie' };
  if (frame.kind === 'effect') {
    if (types.has('effectGainSelfies')) return { kind: 'gain', type: 'effectGainSelfies', total: frame.data.total, title: 'Choose your Selfies', key: `eff:${ctx.state.seq}` };
    if (types.has('effectConvertSelfie')) return { kind: 'convert' };
    if (types.has('effectChooseAchievement')) return { kind: 'pick-card', title: 'Choose an Achievement', note: '', type: 'effectChooseAchievement' };
  }
  return null;
}

function cardPicture(id, w = 150) {
  const a = achievementCard(id);
  return `<div class="sf-card sf-card--zoom-none" style="--w:${w}px" title="${escapeHtml(a ? a.name : id)}">${art(a ? a.art : id, { alt: a ? a.name : id })}</div>`;
}

function doBtn(ctx, action, label, cls = 'sf-btn') {
  const i = ctx.legal.findIndex((a) => JSON.stringify(a) === JSON.stringify(action));
  return `<button class="${cls}" data-do="${i}">${label}</button>`;
}

// ---- rendering ------------------------------------------------------------------------------

export function renderModal(ctx, m) {
  if (!m) return '';
  switch (m.kind) {
    case 'handover': return handover(ctx, m);
    case 'pass-achievement': return passAchievement(ctx);
    case 'pick-card': return pickCard(ctx, m);
    case 'gain': return gain(ctx, m);
    case 'convert': return convert(ctx);
    case 'discard-selfie': return discardSelfie(ctx);
    case 'choice': return choice(ctx, m);
    case 'confirm-pass': return confirmPass(ctx);
    case 'log': return logModal(ctx);
    case 'settings': return settings(ctx);
    case 'rules': return rules(ctx);
    case 'score': return scorePopup(ctx, m);
    case 'final': return finalReveal(ctx, m);
    default: return '';
  }
}

function shell(title, body, { closable = false, wide = false, id = '' } = {}) {
  return `<div class="sf-scrim" data-modal="${id}" role="dialog" aria-modal="true" aria-label="${escapeHtml(title)}">
    <div class="sf-modal${wide ? ' sf-modal--wide' : ''}">
      ${closable ? '<button class="sf-btn sf-btn--icon sf-modal__close" data-act="close-modal" aria-label="Close">&times;</button>' : ''}
      <h2 class="sf-modal__title">${escapeHtml(title)}</h2>
      ${body}
    </div></div>`;
}

function handover(ctx, m) {
  const p = ctx.state.players[m.seat];
  return `<div class="sf-handover sf-pc--${p.colour}" role="dialog" aria-modal="true" aria-label="Hand over the device">
    <div class="sf-handover__card">
      <div class="sf-handover__title">Pass the device to ${escapeHtml(p.name)}</div>
      <p style="font-size:var(--fs-lg);font-weight:800;margin:0">Only ${escapeHtml(p.name)} should look: their Achievements are shown next.</p>
      <button class="sf-btn sf-btn--go sf-btn--big" data-act="handover-ok">I'm ${escapeHtml(p.name)} - show my hand</button>
    </div></div>`;
}

function passAchievement(ctx) {
  const { state } = ctx;
  const seat = state.toAct;
  const p = state.players[seat];
  const K = getConstants(state);
  const cards = p.hand
    .map((id) => {
      const a = achievementCard(id);
      const vp = previewAchievementVp(state, id);
      return `<div class="sf-pick">
        ${cardPicture(id, 150)}
        <div class="sf-pick__name">${escapeHtml(a.name)}</div>
        <div class="sf-pick__text">${escapeHtml(a.text)}</div>
        ${doBtn(ctx, { type: 'scoreAchievement', card: id }, `Score now: ${vp ?? '?'} VP`, 'sf-btn sf-btn--primary')}
        ${doBtn(ctx, { type: 'discardAchievement', card: id }, `Bin it for ${K.PASS.PASS_DISCARD_COFFEE} coffee`, 'sf-btn')}
      </div>`;
    })
    .join('');
  const first = state.hourState.firstPasser === null;
  const note = `You have passed${first ? ` (first to pass: +${K.PASS.PASS_FIRST_PASSER_COFFEE} coffee)` : ''}. Score one Achievement now, or bin it for coffee. Scored Achievements are shown to everyone.`;
  return shell('Pass: score or bin an Achievement', `<p>${escapeHtml(note)}</p><div class="sf-picks">${cards}</div>`, { id: 'pass-achievement' });
}

function pickCard(ctx, m) {
  const opts = ctx.legal.filter((a) => a.type === m.type);
  const cards = opts
    .map((a) => {
      const a2 = achievementCard(a.card);
      return `<div class="sf-pick">${cardPicture(a.card, 130)}<div class="sf-pick__name">${escapeHtml(a2 ? a2.name : a.card)}</div>${doBtn(ctx, a, 'Choose this one', 'sf-btn sf-btn--primary')}</div>`;
    })
    .join('');
  const prompt = ctx.decision ? ctx.decision.prompt : '';
  return shell(m.title, `<p>${escapeHtml(m.note || prompt)}</p><div class="sf-picks">${cards}</div>`, { id: 'pick-card' });
}

function gain(ctx, m) {
  const draft = ctx.view.draft && ctx.view.draft.key === m.key ? ctx.view.draft : null;
  const counts = draft ? draft.counts : { green: 0, red: 0, orange: 0 };
  const sum = counts.green + counts.red + counts.orange;
  const total = m.total;
  const rows = SELFIE_COLOURS.map(
    (c) => `<div class="sf-stepper"><span class="sf-stepper__lbl">${art(ICON.selfie[c], { cls: 'sf-icon', alt: '' })} ${c} <small>${SYMBOL_WORD[c]}</small></span>
      <button class="sf-btn sf-btn--icon" data-act="gain-:${c}" ${counts[c] <= 0 ? 'disabled' : ''} aria-label="Fewer ${c}">&minus;</button>
      <b class="sf-stepper__n" data-count="${c}">${counts[c]}</b>
      <button class="sf-btn sf-btn--icon" data-act="gain+:${c}" ${sum >= total ? 'disabled' : ''} aria-label="More ${c}">+</button></div>`,
  ).join('');
  const ready = sum === total;
  const extra = m.cancelable ? '<button class="sf-btn sf-btn--ghost" data-act="close-modal">Cancel</button>' : '';
  return shell(
    m.title,
    `<p>Choose ${plural(total, 'Selfie', 'Selfies')} in any mix of colours. <b>${sum} of ${total}</b> chosen.</p><div class="sf-steppers">${rows}</div>
    <div class="sf-modal__actions">${extra}<button class="sf-btn sf-btn--go" data-act="gain-ok" ${ready ? '' : 'disabled'}>Take them</button></div>`,
    { id: 'gain' },
  );
}

function convert(ctx) {
  const opts = ctx.legal.filter((a) => a.type === 'effectConvertSelfie');
  const done = ctx.legal.find((a) => a.type === 'effectDone');
  const buttons = opts
    .map((a) => doBtn(ctx, a, `${art(ICON.selfie[a.from], { cls: 'sf-icon', alt: a.from })} ${a.from} &rarr; ${art(ICON.selfie[a.to], { cls: 'sf-icon', alt: a.to })} ${a.to}`, 'sf-btn'))
    .join('');
  return shell(
    'Colour Swap',
    `<p>Change the colour of a Selfie, one at a time. Each Selfie can change once.</p><div class="sf-choices">${buttons}</div>
    <div class="sf-modal__actions">${done ? doBtn(ctx, done, 'No more', 'sf-btn sf-btn--go') : ''}</div>`,
    { id: 'convert' },
  );
}

function discardSelfie(ctx) {
  const opts = ctx.legal.filter((a) => a.type === 'discardSelfie');
  const buttons = opts.map((a) => doBtn(ctx, a, `${art(ICON.selfie[a.colour], { cls: 'sf-icon', alt: a.colour })} Discard 1 ${a.colour}`, 'sf-btn')).join('');
  return shell('Too many Selfies', `<p>${escapeHtml(ctx.decision ? ctx.decision.prompt : 'Discard down to your Club limit.')}</p><div class="sf-choices">${buttons}</div>`, { id: 'discard' });
}

function choice(ctx, m) {
  const buttons = m.options
    .map((o, i) => `<button class="sf-btn sf-choice" data-act="opt:${i}" title="${escapeHtml(o.title || '')}">${o.html}</button>`)
    .join('');
  return shell(m.title, `${m.note ? `<p>${escapeHtml(m.note)}</p>` : ''}<div class="sf-choices">${buttons}</div>`, { closable: true, id: 'choice' });
}

function confirmPass(ctx) {
  const p = ctx.state.players[ctx.state.toAct];
  return shell(
    'Pass now?',
    `<p>You still have <b>${coffeeText(p.coffee)}</b>. Once you pass you take no more main actions this Hour, but you do get the pass ladder reward on later turns.</p>
    <div class="sf-modal__actions"><button class="sf-btn sf-btn--ghost" data-act="close-modal">Keep playing</button><button class="sf-btn sf-btn--primary" data-act="pass-ok">Pass</button></div>`,
    { closable: true, id: 'confirm-pass' },
  );
}

function logModal(ctx) {
  const rows = [];
  let hour = 0;
  for (const l of ctx.log.slice(-250)) {
    if (l.hour !== hour) {
      hour = l.hour;
      rows.push(`<div class="sf-log__hour">Hour ${hour}</div>`);
    }
    const colour = l.seat !== null && l.seat !== undefined ? ctx.state.players[l.seat].colour : '';
    rows.push(`<div class="sf-log__item${colour ? ` sf-pc--${colour}` : ''}${l.kind === 'auto' ? ' is-auto' : ''}"><span>${escapeHtml(l.text)}</span></div>`);
  }
  return shell('Game log', `<div class="sf-log sf-log--tall">${rows.join('') || '<p>Nothing has happened yet.</p>'}</div>`, { closable: true, wide: true, id: 'log' });
}

function settings(ctx) {
  const speeds = [['normal', 'Normal'], ['fast', 'Fast'], ['instant', 'Instant']];
  return shell(
    'Settings',
    `<div class="sf-settings">
      <div><b>Bot speed</b><div class="sf-seg" role="group" aria-label="Bot speed">${speeds
        .map(([id, label]) => `<button class="${ctx.view.speed === id ? 'is-selected' : ''}" data-act="speed:${id}">${label}</button>`)
        .join('')}</div></div>
      <div><b>Game</b><div class="sf-settings__row"><button class="sf-btn" data-act="new-game">New game (setup)</button></div></div>
      <p class="sf-setup__hint">Seed ${escapeHtml(String(ctx.seed))}. ${ctx.botsReal ? '' : 'The practice bot is playing at random for now.'}</p>
      <div id="sf-extra-settings"></div>
    </div>`,
    { closable: true, id: 'settings' },
  );
}

function rules(ctx) {
  // T17: the full plain-English rules (how-to-play.js), numbers from this game's constants
  const st = ctx.state;
  return shell('How to play', howToPlayHtml({ K: getConstants(st), variants: st.variants, players: st.players.length }), { closable: true, wide: true, id: 'rules' });
}

// ---- the celebrity scoring popup -------------------------------------------------------------

function scorePopup(ctx, m) {
  const { state } = ctx;
  const ev = m.event;
  const card = celebrityCard(ev.celebrity);
  const lines = ev.payouts
    .map((p) => {
      const owner = state.players[p.player];
      const crew = `<span class="sf-crew sf-crew--px sf-crew--${p.badge === 'AAA' ? 'aaa' : p.badge === 'VIP' ? 'vip' : 'noob'}">${p.badge === 'AAA' ? art('overlay-aaa-box', { cls: 'sf-crew__box', alt: '' }) : ''}${art(`token-crew-${owner.colour}`, { cls: 'sf-crew__body', alt: '' })}${p.badge !== 'N00b' ? art('overlay-vip-hat', { cls: 'sf-crew__hat', alt: '' }) : ''}</span>`;
      const why = p.vp ? '' : p.badge === 'N00b' && /no-n00bs/.test(ev.method) ? ' (N00bs score nothing)' : ' (beyond the list)';
      return `<li class="sf-line sf-pc--${owner.colour}${p.vp ? '' : ' sf-line--zero'}">
        <span class="sf-line__pos${p.position === 1 ? ' sf-line__pos--prime' : ''}">${p.position === 1 ? '&#9733;' : p.position}</span>${crew}
        <span class="sf-line__what"><b>${escapeHtml(owner.name)}</b> ${p.badge} &middot; position ${p.position}${why}</span>
        <span class="sf-line__vp">${p.vp ? `+${p.vp}` : '0'}</span></li>`;
    })
    .join('');
  const totals = state.players
    .map((p, i) => ({ p, vp: ev.totals[i] || 0, parts: ev.payouts.filter((x) => x.player === i && x.vp > 0).map((x) => x.vp) }))
    .filter((t) => t.vp > 0)
    .map(
      (t) =>
        `<span class="sf-total sf-pc--${t.p.colour}"><span class="sf-score-marker"></span>${escapeHtml(t.p.name)} <span class="sf-total__arith">${t.parts.join(' + ')} =</span> <b>${t.vp}</b></span>`,
    )
    .join('');
  const band = ev.method === 'count-total' ? `<p class="sf-score__band">${plural(ev.payouts.length, 'Crew', 'Crew')} in the hall: every Crew scores ${ev.payouts[0] ? ev.payouts[0].vp : 0} VP.</p>` : '';
  const selfies = (m.selfies || []).map((s) => `<li>${art(ICON.selfie[s.colour], { cls: 'sf-icon', alt: '' })} ${escapeHtml(s.text)}</li>`).join('');
  const colour = ev.colour;
  return `<div class="sf-scrim" role="dialog" aria-modal="true" aria-labelledby="score-title" data-modal="score">
    ${confettiHtml(60)}
    <div class="sf-modal sf-score">
      <div class="sf-score__head sf-cc--${colour}">
        ${art(card.portrait, { cls: 'sf-medallion', alt: '' })}
        <div><div class="sf-score__kicker">Hour ${ev.hour} &middot; Celebrity scoring</div>
          <div class="sf-score__title" id="score-title">${escapeHtml(card.name)} scores ${escapeHtml(hallName(ev.hall))}</div>
          <div class="sf-score__method">${art(ICON.trophy, { alt: '', style: 'width:20px' })}${escapeHtml(card.scoringText)}</div></div>
      </div>
      <div class="sf-score__body">
        ${selfies ? `<ul class="sf-score__selfies">${selfies}</ul>` : ''}
        ${band}
        <ol class="sf-lines">${lines || '<li class="sf-line sf-line--zero"><span></span><span></span><span class="sf-line__what">Nobody was in the queue.</span><span class="sf-line__vp">0</span></li>'}</ol>
        <div class="sf-totals">${totals || '<span class="sf-total__arith">Nobody scores.</span>'}</div>
        <div class="sf-modal__actions"><span class="sf-score__next">${escapeHtml(m.next || '')}</span><button class="sf-btn sf-btn--primary sf-btn--big" data-act="score-continue" autofocus>Continue</button></div>
      </div>
    </div></div>`;
}

export function confettiHtml(n = 60) {
  const cols = ['#e0435e', '#2fa84f', '#f28a1b', '#4c7cf3', '#f4c51a', '#df4fc6', '#c8ff24'];
  let s = '';
  for (let i = 0; i < n; i += 1) {
    const x = (i * 37) % 100;
    const d = (i * 47) % 900;
    const r = (i * 71) % 360;
    s += `<i style="--x:${x}%;--d:${d}ms;--r:${r}deg;--c:${cols[i % cols.length]}"></i>`;
  }
  return `<div class="sf-confetti" aria-hidden="true">${s}</div>`;
}

// ---- final scoring reveal ----------------------------------------------------------------------

function finalReveal(ctx, m) {
  const { state } = ctx;
  const rows = m.items
    .map((it) => {
      const owner = state.players[it.player];
      const a = achievementCard(it.card);
      return `<li class="sf-line sf-pc--${owner.colour}"><span class="sf-line__pos">${it.tripled ? '&times;3' : '&times;1'}</span><span></span>
        <span class="sf-line__what"><b>${escapeHtml(owner.name)}</b>: ${escapeHtml(a ? a.name : it.card)} &middot; ${it.count} &times; ${it.laurel} &times; ${it.multiplier}</span>
        <span class="sf-line__vp">+${it.vp}</span></li>`;
    })
    .join('');
  return `<div class="sf-scrim" role="dialog" aria-modal="true" data-modal="final">${confettiHtml(40)}
    <div class="sf-modal sf-score"><div class="sf-score__head"><div><div class="sf-score__kicker">Final scoring</div><div class="sf-score__title">The last Achievements</div>
      <div class="sf-score__method">Each player's best remaining Achievement scores three times over.</div></div></div>
      <div class="sf-score__body"><ol class="sf-lines">${rows || '<li class="sf-line sf-line--zero"><span></span><span></span><span class="sf-line__what">Nobody had an Achievement left.</span><span class="sf-line__vp">0</span></li>'}</ol>
      <div class="sf-modal__actions"><button class="sf-btn sf-btn--primary sf-btn--big" data-act="score-continue">See the results</button></div></div>
    </div></div>`;
}

export { selfiesHtml, swagCard, clubCard, CELEBRITY_CARDS, EVENTS };
