// Superfans design mock-ups - static markup builder (T7, 31/10/2026).
// NOT game code: a fixed fixture rendered into the design-system markup so the
// play, walk and scoring mock-ups share one board. T14 may copy the MARKUP
// shapes (class names, nesting, data-* hooks) but must render from engine state.
// Hall names, celebrity names and routes all come from data here, as they must
// in the real UI.

const A = '../assets/';

// ---- fixture ---------------------------------------------------------------
const HALLS = [
  { id: 'h11', r: 1, c: 1, name: "Artist's Alley", art: 'halls/hall-artists-alley.webp' },
  { id: 'h12', r: 1, c: 2, name: 'Main Stage',     art: 'halls/hall-main-stage.webp' },
  { id: 'h13', r: 1, c: 3, name: 'Cosplay Corner', art: 'halls/hall-cosplay-corner.webp' },
  { id: 'h21', r: 2, c: 1, name: 'Autographs',     art: 'halls/hall-autograph-hall.webp' },
  { id: 'h22', r: 2, c: 2, name: 'Main Hall',      art: 'halls/hall-main-hall.webp' },
  { id: 'h23', r: 2, c: 3, name: 'Vendor Hall',    art: 'halls/hall-vendor-hall.webp' },
  { id: 'h31', r: 3, c: 1, name: 'Photo Ops',      art: 'halls/hall-photo-op.webp' },
  { id: 'h32', r: 3, c: 2, name: 'Entrance',       art: 'halls/hall-registration.webp', entrance: true },
  { id: 'h33', r: 3, c: 3, name: 'Food Trucks',    art: 'halls/hall-food-trucks.webp' },
];
const HALL = Object.fromEntries(HALLS.map(h => [h.id, h]));

const PLAYERS = [
  { id: 'blue',   name: 'Dean',       seat: 'Human',      bot: false, club: 'Selfie Stick Squad',    clubCard: 'club-09', coffee: 7,  selfies: { green: 2, red: 1, orange: 3 }, vp: 23, crew: 1, hats: 1, box: 0, vols: 4, hand: ['achievement-01', 'achievement-17'] },
  { id: 'yellow', name: 'Sam',        seat: 'Human',      bot: false, club: 'Silver Screen Society', clubCard: 'club-01', coffee: 9,  selfies: { green: 1, red: 2, orange: 0 }, vp: 19, crew: 2, hats: 1, box: 1, vols: 4, hand: [] },
  { id: 'pink',   name: 'Medium Bot', seat: 'Medium bot', bot: true,  club: 'Retro Gaming Guild',    clubCard: 'club-08', coffee: 4,  selfies: { green: 0, red: 3, orange: 1 }, vp: 27, crew: 1, hats: 2, box: 1, vols: 4, hand: [] },
  { id: 'green',  name: 'Easy Bot',   seat: 'Easy bot',   bot: true,  club: 'Otaku Alliance',        clubCard: 'club-04', coffee: 11, selfies: { green: 1, red: 0, orange: 1 }, vp: 14, crew: 0, hats: 2, box: 1, vols: 5, hand: [] },
];
const PLAYER = Object.fromEntries(PLAYERS.map(p => [p.id, p]));

// queue order = position (computed by the engine; here fixed). b: n / v / a
const Q = (s) => s.split(' ').filter(Boolean).map(t => { const [p, b] = t.split(':'); return { p, b }; });
const QUEUES = {
  h11: Q('yellow:v pink:n'),
  h12: Q('green:n blue:n'),
  h13: Q('blue:a pink:n yellow:n'),
  h21: Q(''),
  h22: Q('pink:v green:n green:n blue:n'),
  h23: Q('green:v yellow:n'),
  h31: Q('blue:n'),
  h32: Q('pink:n green:n yellow:n blue:n pink:n green:n'),
  h33: Q('blue:v yellow:v blue:n pink:n green:n yellow:n pink:n green:n'),
};
const CAPACITY = 8; // 4 players (rulebook: 2p 5 / 3p 7 / 4-5p 8)

const HALL_VOLS = { // hall -> { security, photographer } owner ids
  h22: { security: 'green' }, h23: { photographer: 'yellow' },
  h31: { photographer: 'pink' }, h33: { security: 'blue' },
};
const ROPES = [ // [a, b, usherOwner]
  ['h11', 'h12'], ['h12', 'h13'], ['h21', 'h22'], ['h22', 'h23', 'blue'], ['h31', 'h32'], ['h32', 'h33', 'yellow'],
  ['h11', 'h21'], ['h12', 'h22', 'pink'], ['h13', 'h23'], ['h21', 'h31'], ['h22', 'h32'], ['h23', 'h33'],
];

const CELEBS = {
  'who-03':      { name: 'Tom Cake',       rank: 'A', coffee: 3, route: ['h13', 'h23', 'h33'], method: 'Score in Order', values: [20, 9, 6, 4, 3, 2, 1] },
  'marvel-02':   { name: 'Tom Fiddleston', rank: 'B', coffee: 5, route: ['h22', 'h23', 'h33', 'h32', 'h31'], method: 'Everyone, by badge', values: ['N00b 6', 'VIP 8', 'AAA 10'] },
  'star-wars-02':{ name: 'Adam Ripper',    rank: 'B', coffee: 8, route: ['h31', 'h32', 'h33', 'h23', 'h13'], method: 'Everyone, count total', values: ['1-2: 12', '3-4: 5', '5+: 3'] },
  'mando-03':    { name: 'Pedro Daddy',    rank: 'A', coffee: 5 },
  'tng-01':      { name: 'Gates McDoor',   rank: 'C', coffee: 6 },
  'marvel-01':   { name: 'Scarlet Killer', rank: 'C', coffee: 6 },
};
// on the floor in Hour 2: figure colour, where it stands, destination
const ON_FLOOR = [
  { id: 'who-03',       colour: 'green',  at: 'h13', dest: 'h33', hour: 2 },
  { id: 'marvel-02',    colour: 'red',    at: 'h22', dest: 'h31', hour: 3 },
  { id: 'star-wars-02', colour: 'orange', at: 'h31', dest: 'h13', hour: 4 },
];
const SCHEDULE = [
  { hour: 1, faces: [['mando-03', 'green']] },
  { hour: 2, faces: [['who-03', 'green']] },
  { hour: 3, faces: [['marvel-02', 'red']] },
  { hour: 4, faces: [['star-wars-02', 'orange']] },
  { hour: 5, faces: [['tng-01', null], ['marvel-01', null]] },
];
const MARKET = [
  { card: 'swag-red-01', price: ['red'] },
  { card: 'swag-green-04', price: ['green', 'green'] },
  { card: 'swag-orange-02', price: ['orange'] },
  { card: 'swag-green-09', price: ['green', 'green', 'green'] },
  { card: 'swag-orange-07', price: ['orange', 'orange'] },
];

// ---- helpers ---------------------------------------------------------------
const portrait = (id) => `${A}portraits/celebrity-${id}.webp`;
const card = (id) => `${A}cards/${id}.webp`;
const crewImg = (p) => `${A}tokens/crew-${p}.webp`;
const centre = (id) => { const h = HALL[id]; return [50 + (h.c - 1) * 114, 50 + (h.r - 1) * 114]; };

function crew(p, b, extra = '') {
  const hat = b !== 'n' ? `<img class="sf-crew__hat" src="${A}overlays/vip-hat.webp" alt="">` : '';
  const box = b === 'a' ? `<img class="sf-crew__box" src="${A}overlays/aaa-box.webp" alt="">` : '';
  const badge = { n: 'N00b', v: 'VIP', a: 'AAA' }[b];
  return `<span class="sf-crew sf-crew--${{ n: 'noob', v: 'vip', a: 'aaa' }[b]} ${extra}" title="${PLAYER[p].name}'s ${badge} Crew">${box}<img class="sf-crew__body" src="${crewImg(p)}" alt="${PLAYER[p].name} ${badge}">${hat}</span>`;
}

function selfies(s) {
  return `<div class="sf-selfies">${['green', 'red', 'orange'].map(c =>
    `<span class="sf-selfie sf-selfie--${c}${s[c] ? '' : ' sf-selfie--zero'}" title="${s[c]} ${c} Selfie${s[c] === 1 ? '' : 's'}"><span class="sf-selfie__n">${s[c]}</span></span>`).join('')}</div>`;
}

function dial(v) {
  return `<div class="sf-dial${v >= 12 ? ' is-full' : ''}" style="--v:${v}" role="img" aria-label="${v} coffee of 12">
    <div class="sf-dial__face"><img class="sf-dial__cup" src="${A}icons/coffee.webp" alt=""><span class="sf-dial__num">${v}</span></div></div>`;
}

// ---- lanyards ---------------------------------------------------------------
function lanyard(p, { active = false, passed = false, firstPlayer = false } = {}) {
  const compact = !active;
  const seatChip = p.bot ? `<span class="sf-chip sf-chip--bot">${p.seat}</span>` : `<span class="sf-chip sf-chip--human">Human</span>`;
  const head = `
    <div class="sf-lanyard__head">
      <span class="sf-lanyard__avatar" style="background-image:url(${crewImg(p.id)})"></span>
      <div style="min-width:0">
        <div class="sf-lanyard__name">${p.name}</div>
        <div class="sf-lanyard__club">${p.club}</div>
        <div class="sf-lanyard__meta">${seatChip}${passed ? '<span class="sf-chip">Passed</span>' : ''}${firstPlayer ? '<span class="sf-first-player" title="First Player" style="width:20px;height:26px"></span>' : ''}</div>
      </div>
      <div class="sf-vp" title="${p.vp} VP"><span>${p.vp}</span><span class="sf-vp__label">VP</span></div>
    </div>`;
  const supply = `
    <div class="sf-lanyard__row">
      <span class="sf-lanyard__label">Supply</span>
      <span class="sf-supply${p.crew ? '' : ' sf-supply--out'}" title="${p.crew} Crew in supply"><img src="${crewImg(p.id)}" alt="">&times;${p.crew}</span>
      <span class="sf-supply${p.hats ? '' : ' sf-supply--out'}" title="${p.hats} VIP hats left"><img src="${A}overlays/vip-hat.webp" alt="">&times;${p.hats}</span>
      <span class="sf-supply${p.box ? '' : ' sf-supply--out'}" title="${p.box ? 'AAA box available' : 'AAA box used'}"><img src="${A}overlays/aaa-box.webp" alt="">&times;${p.box}</span>
      <span class="sf-supply" title="${p.vols} Volunteers left"><img src="${A}icons/volunteer.webp" alt="">&times;${p.vols}</span>
    </div>`;
  const body = compact ? `
    <div class="sf-lanyard__body">
      <div class="sf-lanyard__mini">
        <span title="${p.coffee} coffee"><img src="${A}icons/coffee.webp" alt="">${p.coffee}</span>
        <span title="Selfies"><img src="${A}icons/selfie-green.webp" alt="">${p.selfies.green}</span>
        <span><img src="${A}icons/selfie-red.webp" alt="">${p.selfies.red}</span>
        <span><img src="${A}icons/selfie-orange.webp" alt="">${p.selfies.orange}</span>
        <span title="Crew in supply"><img src="${crewImg(p.id)}" alt="">${p.crew}</span>
        <span title="Achievements in hand"><img src="${A}icons/trophy.webp" alt="">2</span>
      </div>
    </div>` : `
    <div class="sf-lanyard__body">
      <div class="sf-lanyard__stats">
        ${dial(p.coffee)}
        <div style="display:grid;gap:10px">
          <div class="sf-lanyard__row"><span class="sf-lanyard__label">Selfies</span>${selfies(p.selfies)}</div>
          ${supply}
        </div>
      </div>
      <div>
        <div class="sf-lanyard__label" style="margin-bottom:6px">Your hand &middot; Achievements and Club</div>
        <div class="sf-lanyard__hand">
          ${p.hand.map(c => `<div class="sf-card sf-card--zoom sf-card--zoom-up" style="--w:84px" title="Achievement"><img src="${card(c)}" alt="Achievement card"></div>`).join('')}
          <div class="sf-card sf-card--zoom sf-card--zoom-up" style="--w:84px" title="Your Club: ${p.club}"><img src="${card(p.clubCard)}" alt="${p.club}"></div>
          
        </div>
      </div>
    </div>`;
  return `<article class="sf-lanyard sf-pc--${p.id}${active ? ' is-active' : ' sf-lanyard--compact'}${passed ? ' is-passed' : ''}">
    <div class="sf-lanyard__strap">SUPERFANS &middot; ${p.name.toUpperCase()} &middot; SUPERFANS &middot; ${p.name.toUpperCase()}</div>
    <div class="sf-lanyard__clip"></div>
    <div class="sf-lanyard__badge">${head}${body}</div>
  </article>`;
}

// ---- board -----------------------------------------------------------------
function hall(h, opts) {
  const st = opts.hallState?.[h.id] || {};
  const q = QUEUES[h.id];
  const slots = [];
  for (let i = 0; i < CAPACITY; i++) {
    const c = q[i];
    const sel = opts.selectedCrew && opts.selectedCrew[0] === h.id && opts.selectedCrew[1] === i;
    slots.push(`<li class="sf-slot${i === 0 ? ' sf-slot--prime' : ''}" data-pos="${i + 1}">${c ? crew(c.p, c.b, sel ? 'is-selected' : '') : `<span class="sf-slot__n">${i + 1}</span>`}</li>`);
  }
  const vols = HALL_VOLS[h.id] || {};
  const vol = (job) => vols[job]
    ? `<span class="sf-vol sf-vol--${job} is-taken sf-pc--${vols[job]}" title="${job === 'security' ? 'Security' : 'Photographer'}: ${PLAYER[vols[job]].name}"></span>`
    : `<span class="sf-vol sf-vol--${job}" title="${job === 'security' ? 'Security' : 'Photographer'} space (empty)"></span>`;
  const pieces = [];
  for (const f of ON_FLOOR) {
    const at = opts.celebAt?.[f.id] ?? f.at;
    if (at === h.id && !(opts.hideCeleb || []).includes(f.id)) {
      pieces.push(`<div class="sf-celeb sf-cc--${f.colour}${opts.walking === f.id ? ' is-walking is-now' : ''}" title="${CELEBS[f.id].name} (Hour ${f.hour})">
        <img class="sf-celeb__figure" src="${A}figures/celebrity-neutral.webp" alt="">
        <img class="sf-celeb__medallion" src="${portrait(f.id)}" alt="${CELEBS[f.id].name}">
        <span class="sf-celeb__symbol"></span></div>`);
    }
    if (f.dest === h.id && !(opts.hideDest || []).includes(f.id)) {
      pieces.push(`<div class="sf-dest sf-dest--${f.colour}" title="Destination of ${CELEBS[f.id].name}"><span class="sf-dest__hour">Hour ${f.hour}</span></div>`);
    }
  }
  const cls = ['sf-hall', h.entrance ? 'sf-hall--entrance' : '', st.state ? `is-${st.state}` : ''].join(' ');
  return `<div class="${cls}" data-hall="${h.id}" style="grid-area:${2 * h.r - 1} / ${2 * h.c - 1}" title="${h.name} - ${q.length} of ${CAPACITY} in the queue">
    <div class="sf-hall__art"><img src="${A}${h.art}" alt="" decoding="async"></div>
    <div class="sf-hall__sign">${h.name}</div>
    <div class="sf-hall__pieces">${pieces.join('')}</div>
    <div class="sf-hall__vols">${vol('security')}${vol('photographer')}</div>
    <ol class="sf-queue" aria-label="${h.name} queue">${slots.join('')}</ol>
    ${st.tag ? `<span class="sf-hall__tag">${st.tag}</span>` : ''}
    ${st.flash ? '<div class="sf-flash sf-flash--still"></div><div class="sf-flash__rays"></div>' : ''}
  </div>`;
}

function rope([a, b, owner]) {
  const ha = HALL[a], hb = HALL[b];
  const horiz = ha.r === hb.r;
  const area = horiz ? `${2 * ha.r - 1} / ${2 * ha.c}` : `${2 * ha.r} / ${2 * ha.c - 1}`;
  const v = owner
    ? `<span class="sf-vol sf-vol--usher is-taken sf-pc--${owner}" title="Usher: ${PLAYER[owner].name}"></span>`
    : `<span class="sf-vol sf-vol--usher" title="Usher space (empty)"></span>`;
  return `<div class="sf-rope sf-rope--${horiz ? 'h' : 'v'}" style="grid-area:${area}" data-rope="${a}-${b}">${v}</div>`;
}

function routeSvg(celebId, colour, { doneTo = 0 } = {}) {
  const pts = CELEBS[celebId].route.map(centre);
  const d = (arr) => 'M' + arr.map(p => p.join(' ')).join(' L');
  const done = doneTo > 0 ? `<path class="sf-route__casing" d="${d(pts.slice(0, doneTo + 1))}"/><path class="sf-route__done" d="${d(pts.slice(0, doneTo + 1))}"/>` : '';
  const rest = pts.slice(doneTo);
  const [ex, ey] = pts[pts.length - 1];
  const [sx, sy] = pts[0];
  return `<svg class="sf-board__overlay sf-cc--${colour}" viewBox="0 0 328 328" aria-hidden="true">
    <defs><marker id="arr-${celebId}" viewBox="0 0 10 10" refX="5" refY="5" markerWidth="4" markerHeight="4" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 z" fill="var(--cc)"/></marker></defs>
    ${done}
    <path class="sf-route__casing" d="${d(rest)}"/>
    <path class="sf-route__line sf-route__march" d="${d(rest)}" marker-mid="url(#arr-${celebId})"/>
    <circle class="sf-route__start" cx="${sx}" cy="${sy}" r="7"/>
    <circle class="sf-route__end" cx="${ex}" cy="${ey}" r="9"/>
    <path d="M${ex - 4} ${ey} l3 3 l6 -6" stroke="#fff" stroke-width="2.6" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>`;
}

function board(opts) {
  return `<div class="sf-board${opts.dim ? ' is-dimmed' : ''}"><div class="sf-board__grid">
    ${HALLS.map(h => hall(h, opts)).join('')}
    ${ROPES.map(rope).join('')}
    ${opts.route ? routeSvg(...opts.route) : ''}
  </div></div>`;
}

// ---- top bar ----------------------------------------------------------------
function topbar(phase, hour) {
  const phases = ['Coffee Break', 'On the Floor', 'Celebrity Walk'];
  return `<header class="sf-topbar">
    <img class="sf-topbar__logo" src="${A}ui/logo-wordmark.webp" alt="Superfans">
    <span class="sf-hour-marker" title="Hour ${hour} of 5"><span><small>HOUR</small>${hour}</span></span>
    <nav class="sf-hours" aria-label="Schedule">
      ${SCHEDULE.map(s => `<div class="sf-hour${s.hour < hour ? ' is-done' : ''}${s.hour === hour ? ' is-current' : ''}" title="Hour ${s.hour}: ${s.faces.map(f => CELEBS[f[0]].name).join(' and ')}">
        <span class="sf-hour__num">${s.hour}</span>
        ${s.faces.map(([id, c]) => `<img class="sf-hour__face${c ? ' sf-cc--' + c : ''}" src="${portrait(id)}" alt="${CELEBS[id].name}">`).join('')}
      </div>`).join('')}
    </nav>
    <div class="sf-phases">${phases.map(p => `<span class="sf-phase${p === phase ? ' is-current' : ''}">${p}</span>`).join('')}</div>
    <span class="sf-topbar__spacer"></span>
    <div class="sf-topbar__menu">
      <button class="sf-btn" title="Undo your last action (until the turn is committed)"><span aria-hidden="true">&#8630;</span> <span class="sf-btn__label">Undo</span></button>
      <button class="sf-btn" title="Game log"><span aria-hidden="true">&#9776;</span> <span class="sf-btn__label">Log</span></button>
      <button class="sf-btn" title="Rules summary"><span aria-hidden="true">?</span> <span class="sf-btn__label">Rules</span></button>
      <button class="sf-btn sf-btn--icon" title="Settings and bug report">&#9881;</button>
    </div>
  </header>`;
}

// ---- side panel ---------------------------------------------------------------
const ACTIONS = [
  { id: 'move2',    label: 'Move 2',          sub: 'One Crew, up to 2 halls',     icon: 'icons/footprints.webp',  cost: 1 },
  { id: 'move3',    label: 'Move 1 Crew x3',  sub: '3 Crew, 1 hall each',         icon: 'icons/move-arrows.webp', cost: 3 },
  { id: 'noob',     label: 'New N00b',        sub: 'Join the Entrance queue',     icon: 'icons/badge-noob.webp',  cost: 4 },
  { id: 'upgrade',  label: 'Upgrade',         sub: 'N00b to VIP, VIP to AAA',     icon: 'overlays/vip-hat.webp',  cost: 5 },
  { id: 'vol',      label: 'Volunteer',       sub: 'Usher, Security, Photographer', icon: 'icons/volunteer.webp', cost: 2 },
  { id: 'selfie',   label: 'Take a Selfie',   sub: 'Crew with a celebrity',       icon: 'icons/photographer.webp', cost: 1 },
  { id: 'swag',     label: 'Swag',            sub: 'Pay Selfies for a card',      icon: 'icons/gift.webp',        cost: 'selfie' },
  { id: 'club',     label: 'Club Power',      sub: 'Strike a Pose',               icon: 'icons/star.webp',        cost: 'var' },
  { id: 'pass',     label: 'Pass',            sub: 'Score or bin an Achievement', icon: 'icons/rest.webp',        cost: 'free' },
];

function costChip(c, short = false) {
  if (c === 'free') return `<span class="sf-cost sf-cost--free">Free</span>`;
  if (c === 'selfie') return `<span class="sf-cost sf-cost--selfie"><img src="${A}icons/selfie-red.webp" alt="">1-3</span>`;
  if (c === 'var') return `<span class="sf-cost"><img src="${A}icons/coffee.webp" alt="">2</span>`;
  return `<span class="sf-cost${short ? ' sf-cost--short' : ''}"><img src="${A}icons/coffee.webp" alt="">${c}</span>`;
}

function actionsPanel({ armed = null, disabledAll = false, coffee = 7, note = '' } = {}) {
  return `<section class="sf-panel sf-actions-panel sf-panel--act">
    <h2 class="sf-panel__title"><img src="${A}icons/coffee.webp" alt="">Actions <small>${note || `${coffee} coffee to spend`}</small></h2>
    <div class="sf-actions">
      ${ACTIONS.map(a => {
        const short = typeof a.cost === 'number' && a.cost > coffee;
        const blocked = disabledAll || short || (a.id === 'upgrade' && !disabledAll && false);
        const why = disabledAll ? 'Actions are closed during the Celebrity Walk.' : short ? `Needs ${a.cost} coffee - you have ${coffee}.` : '';
        return `<button class="sf-action${armed === a.id ? ' is-armed' : ''}" data-action="${a.id}" ${blocked ? `aria-disabled="true" title="${why}"` : `title="${a.label}: ${a.sub}"`}>
          <img class="sf-action__icon" src="${A}${a.icon}" alt="">
          <span class="sf-action__label">${a.label}</span>
          <span class="sf-action__sub">${a.sub}</span>
          ${costChip(a.cost, short)}
        </button>`;
      }).join('')}
    </div>
  </section>`;
}

function nowPanel(celebId, colour, hour, { walking = false } = {}) {
  const c = CELEBS[celebId];
  return `<section class="sf-panel sf-panel--star sf-cc--${colour}">
    <h2 class="sf-panel__title">${walking ? 'Walking now' : 'This Hour'} <small>Hour ${hour} of 5 &middot; rank ${c.rank}</small></h2>
    <div class="sf-now">
      <div class="sf-card sf-card--md sf-card--zoom" style="transform-origin:0 0" title="${c.name}"><img src="${card('celebrity-' + celebId)}" alt="${c.name} card"></div>
      <div>
        <div class="sf-now__name">${c.name}</div>
        <div class="sf-now__facts">
          <div class="sf-now__fact"><span class="sf-chip" style="background:var(--cc);color:#fff">${colour} figure</span><span class="sf-chip">+${c.coffee} coffee at Coffee Break</span></div>
          <div class="sf-route-text">${c.route.map(id => HALL[id].name).join(' <i>&rarr;</i> ')}</div>
          <div class="sf-now__fact"><img src="${A}icons/trophy.webp" alt=""><span class="sf-now__method">${c.method}</span></div>
          <div class="sf-now__values">${c.values.map(v => `<span>${v}</span>`).join('')}</div>
          <div class="sf-also">${ON_FLOOR.filter(f => f.id !== celebId).map(f => `<span class="sf-also__item sf-cc--${f.colour}"><img class="sf-medallion" style="--medallion:28px;border-width:2px" src="${portrait(f.id)}" alt="">Hour ${f.hour}: ${CELEBS[f.id].name}</span>`).join('')}</div>
        </div>
      </div>
    </div>
  </section>`;
}

function passPanel(markers) {
  const rung = (n, title, text) => `<div class="sf-rung"><b>${title}</b>${text}<div class="sf-rung__markers">${(markers[n] || []).map(p => `<span class="sf-pass-marker sf-pc--${p}" title="${PLAYER[p].name}"></span>`).join('')}</div></div>`;
  return `<section class="sf-panel sf-panel--pass">
    <h2 class="sf-panel__title"><img src="${A}icons/rest.webp" alt="">Pass ladder</h2>
    <div class="sf-ladder">
      ${rung(1, '1st pass', 'Score or bin an Achievement. First to pass: +2 coffee')}
      ${rung(2, '+1', 'coffee or VP')}
      ${rung(3, '+2', 'coffee or VP')}
      ${rung(4, '+3', 'each turn')}
    </div>
  </section>`;
}

function exchangePanel() {
  const any = '<span class="sf-trade__any"></span>';
  return `<section class="sf-panel">
    <h2 class="sf-panel__title"><img src="${A}icons/selfie-orange.webp" alt="">Selfie Exchange</h2>
    <div class="sf-exchange">
      <button class="sf-trade" title="Swap 2 Selfies of any colours for 1 coffee">${any}${any}<span class="sf-trade__arrow">&rarr;</span><img src="${A}icons/coffee.webp" alt="1 coffee"><span class="sf-trade__free">any time</span></button>
      <button class="sf-trade" title="Swap 2 Selfies for 1 Selfie of another colour">${any}${any}<span class="sf-trade__arrow">&rarr;</span>${any}<span class="sf-trade__free">any time</span></button>
      <button class="sf-trade" title="Swap 4 Selfies for 2 VP">${any}${any}${any}${any}<span class="sf-trade__arrow">&rarr;</span><img src="${A}icons/vp.webp" alt="">2 VP</button>
    </div>
  </section>`;
}

function marketPanel({ legal = false } = {}) {
  return `<section class="sf-panel sf-panel--swag">
    <h2 class="sf-panel__title"><img src="${A}icons/gift.webp" alt="">Swag market <small>pay Selfies of one colour</small></h2>
    <div class="sf-market">
      ${MARKET.map(m => `<div class="sf-market__slot">
        <div class="sf-card sf-card--zoom sf-card--zoom-up${legal ? ' is-legal' : ''}" title="Swag card"><img src="${card(m.card)}" alt="Swag card"></div>
        <span class="sf-price">${m.price.map(c => `<img src="${A}icons/selfie-${c}.webp" alt="${c}">`).join('')}</span>
      </div>`).join('')}
      <div class="sf-market__deck" data-count="26"><div class="sf-card sf-card--back"><img src="${card('back-swag-red')}" alt="Swag deck"></div></div>
    </div>
  </section>`;
}

function myStats(p) { // shown in the side panel on tablet/phone only
  return `<section class="sf-panel sf-mystats sf-pc--${p.id}" style="border-top:5px solid var(--pc)">
    <h2 class="sf-panel__title">${p.name}'s turn <small>${p.club}</small></h2>
    <div style="display:flex;gap:14px;align-items:center;flex-wrap:wrap">
      ${dial(p.coffee)}
      <div style="display:grid;gap:8px">${selfies(p.selfies)}
        <div class="sf-lanyard__row">
          <span class="sf-supply"><img src="${crewImg(p.id)}" alt="">&times;${p.crew}</span>
          <span class="sf-supply"><img src="${A}overlays/vip-hat.webp" alt="">&times;${p.hats}</span>
          <span class="sf-supply sf-supply--out"><img src="${A}overlays/aaa-box.webp" alt="">&times;${p.box}</span>
          <span class="sf-supply"><img src="${A}icons/volunteer.webp" alt="">&times;${p.vols}</span>
        </div>
      </div>
      <div class="sf-lanyard__hand">
        ${p.hand.map(c => `<div class="sf-card sf-card--zoom" style="--w:64px"><img src="${card(c)}" alt="Achievement"></div>`).join('')}
        <div class="sf-card sf-card--zoom" style="--w:64px"><img src="${card(p.clubCard)}" alt="${p.club}"></div>
      </div>
    </div>
  </section>`;
}

function walkFeed() {
  return `<section class="sf-panel sf-panel--star">
    <h2 class="sf-panel__title">Walk feed <small>Hour 2</small></h2>
    <div class="sf-log">
      <div class="sf-log__item sf-pc--green"><span>Tom Cake leaves <b>Cosplay Corner</b>.</span></div>
      <div class="sf-log__item sf-pc--green"><span>Enters <b>Vendor Hall</b>: Prime Position is <b>Easy Bot</b>'s VIP, +1 green Selfie.</span></div>
      <div class="sf-log__item sf-pc--yellow"><span><b>Sam</b>'s Photographer in Vendor Hall: +1 green Selfie.</span></div>
      <div class="sf-log__item"><span style="color:var(--ink-muted)">Next: <b>Food Trucks</b> (destination) - selfies, then scoring.</span></div>
    </div>
  </section>`;
}

// ---- screens ------------------------------------------------------------------
const confetti = (n = 60, still = false) => {
  const cols = ['#e0435e', '#2fa84f', '#f28a1b', '#4c7cf3', '#f4c51a', '#df4fc6', '#c8ff24'];
  let s = '';
  for (let i = 0; i < n; i++) {
    const x = (i * 37) % 100, y = (i * 53) % 92, d = (i * 47) % 900, r = (i * 71) % 360;
    s += `<i style="--x:${x}%;--y:${y}%;--d:${d}ms;--r:${r}deg;--c:${cols[i % cols.length]}"></i>`;
  }
  return `<div class="sf-confetti${still ? ' sf-confetti--still' : ''}">${s}</div>`;
};

function screenPlay() {
  return {
    phase: 'On the Floor', hour: 2,
    players: PLAYERS.map((p, i) => lanyard(p, { active: i === 0, passed: p.id === 'pink', firstPlayer: i === 1 })).join(''),
    board: board({
      selectedCrew: ['h32', 3],
      hallState: {
        h22: { state: 'legal', tag: '1 hall' }, h31: { state: 'legal', tag: '1 hall' },
        h12: { state: 'legal', tag: '2 halls' }, h21: { state: 'legal', tag: '2 halls' }, h23: { state: 'legal', tag: '2 halls' },
        h33: { state: 'illegal', tag: 'FULL 8/8' },
        h11: { state: 'dimmed' }, h13: { state: 'dimmed' }, h32: { state: 'source' },
      },
    }),
    overlays: `
      <div class="sf-banner"><span class="sf-banner__step">Step 2 of 2</span>
        <span class="sf-banner__text">Move 2 &middot; Pick a hall for your N00b, up to 2 halls away &middot; <b>1 coffee</b></span>
        <button class="sf-btn sf-btn--ghost">Cancel</button></div>
      <div class="sf-toast sf-toast--refuse"><img src="${A}icons/cross.webp" alt="">
        <span>Food Trucks is full (8 of 8).<small>A Crew can't enter a full hall or pass through it.</small></span></div>`,
    side: [nowPanel('who-03', 'green', 2), myStats(PLAYERS[0]), actionsPanel({ armed: 'move2', coffee: 7 }),
      `<div class="sf-side-row">${passPanel({ 1: ['pink'] })}${exchangePanel()}</div>`, marketPanel()].join(''),
  };
}

function screenWalk() {
  return {
    phase: 'Celebrity Walk', hour: 2,
    players: PLAYERS.map((p, i) => lanyard(p, { active: false, passed: true, firstPlayer: i === 1 })).join(''),
    board: board({
      celebAt: { 'who-03': 'h23' }, walking: 'who-03',
      route: ['who-03', 'green', { doneTo: 1 }],
      hallState: { h23: { flash: true } },
    }),
    overlays: `
      <div class="sf-banner sf-banner--walk"><span class="sf-banner__step">Hall 2 of 3</span>
        <span class="sf-banner__text">Tom Cake enters <b>Vendor Hall</b></span>
        <button class="sf-btn sf-btn--ghost">2&times; speed</button><button class="sf-btn sf-btn--ghost">Skip</button></div>
      <span class="sf-float sf-float--still sf-pc--green" style="right:4%;top:38%"><img src="${A}icons/selfie-green.webp" alt="">+1 Easy Bot &middot; Prime Position</span>
      <span class="sf-float sf-float--still sf-pc--yellow" style="right:4%;top:44.5%;animation-delay:.25s"><img src="${A}icons/selfie-green.webp" alt="">+1 Sam &middot; Photographer</span>`,
    side: [nowPanel('who-03', 'green', 2, { walking: true }), walkFeed(), actionsPanel({ disabledAll: true, note: 'closed during the Walk' }),
      passPanel({ 1: ['pink'], 2: ['green'], 3: ['blue', 'yellow'] }), marketPanel()].join(''),
  };
}

function screenScoring() {
  const lines = [
    [1, 'blue', 'v', 'VIP', 20], [2, 'yellow', 'v', 'VIP', 9], [3, 'blue', 'n', 'N00b', 6], [4, 'pink', 'n', 'N00b', 4],
    [5, 'green', 'n', 'N00b', 3], [6, 'yellow', 'n', 'N00b', 2], [7, 'pink', 'n', 'N00b', 1], [8, 'green', 'n', 'N00b', 0],
  ];
  const totals = [['blue', '20 + 6', 26], ['yellow', '9 + 2', 11], ['pink', '4 + 1', 5], ['green', '3 + 0', 3]];
  const s = screenWalk();
  return {
    ...s,
    board: board({ celebAt: { 'who-03': 'h33' }, route: ['who-03', 'green', { doneTo: 2 }], hallState: { h33: { state: 'selected' } } }),
    overlays: '',
    modal: `<div class="sf-scrim">${confetti(70)}
      <div class="sf-modal sf-score" role="dialog" aria-labelledby="score-title">
        <div class="sf-score__head sf-cc--green">
          <img class="sf-medallion" src="${portrait('who-03')}" alt="">
          <div><div class="sf-score__kicker">Hour 2 &middot; Celebrity scoring</div>
            <div class="sf-score__title" id="score-title">Tom Cake scores Food Trucks</div>
            <div class="sf-score__method"><img src="${A}icons/trophy.webp" alt="" width="20">Score in Order: 20 &middot; 9 &middot; 6 &middot; 4 &middot; 3 &middot; 2 &middot; 1</div></div>
        </div>
        <div class="sf-score__body">
          <div class="sf-toast sf-toast--good" style="position:static;width:auto;animation:none;box-shadow:none;background:var(--paper-2);max-width:none;margin:0 0 10px">
            <img src="${A}icons/selfie-green.webp" alt=""><span>Selfies first: Dean's VIP in Prime Position takes +1 green Selfie.<small>No Photographer in Food Trucks.</small></span></div>
          <ol class="sf-lines">
            ${lines.map(([pos, p, b, badge, vp]) => `<li class="sf-line sf-pc--${p}${vp ? '' : ' sf-line--zero'}">
              <span class="sf-line__pos${pos === 1 ? ' sf-line__pos--prime' : ''}">${pos === 1 ? '&#9733;' : pos}</span>
              ${crew(p, b, 'sf-crew--px')}
              <span class="sf-line__what"><b>${PLAYER[p].name}</b> ${badge} &middot; position ${pos}${vp ? '' : ' (beyond the list)'}</span>
              <span class="sf-line__vp">${vp ? '+' + vp : '0'}</span></li>`).join('')}
          </ol>
          <div class="sf-totals">${totals.map(([p, ar, t]) => `<span class="sf-total sf-pc--${p}"><span class="sf-score-marker"></span>${PLAYER[p].name} <span class="sf-total__arith">${ar} =</span> <b>${t}</b></span>`).join('')}</div>
          <div class="sf-modal__actions"><span style="margin-right:auto;align-self:center;font-size:13px;color:var(--ink-muted);font-weight:800">Next: Hour 4's celebrity, Adam Ripper, is placed.</span><button class="sf-btn sf-btn--primary sf-btn--big">Continue</button></div>
        </div>
      </div></div>`,
  };
}

const SCREENS = { play: screenPlay, walk: screenWalk, scoring: screenScoring };

export { A, HALL, PLAYERS, crew, dial, selfies, lanyard, hall, rope, actionsPanel, nowPanel, passPanel, exchangePanel, marketPanel, confetti };

function render() {
  const which = document.body.dataset.screen;
  if (!SCREENS[which]) return; // components.html imports the builders only
  const s = SCREENS[which]();
  document.getElementById('app').innerHTML = `
    <div class="sf-game">
      ${topbar(s.phase, s.hour)}
      <aside class="sf-players" aria-label="Players">${s.players}</aside>
      <main class="sf-stage">${s.board}${s.overlays}</main>
      <aside class="sf-side" aria-label="This Hour, actions and market">${s.side}</aside>
    </div>${s.modal || ''}`;
}

render();
