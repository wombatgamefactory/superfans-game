// cardeffects.js - the 36 Swag effects (R16.8) and the 7 main-action Club
// powers (R17.6) as DATA: one entry per card in EFFECTS, built from a few step
// kinds, run by one small runner.
//
// An effect is `{ kind, begin, steps }`:
//   begin(state, seat, options)  resolves what needs no choice (gain coffee, draw,
//                                gain VP ...) and returns the first decision:
//                                  null                  nothing (more) to decide
//                                  { step, data }        an `effect` frame at that step
//                                  { frame }             some other ready-made frame
//   steps[name]                  one decision: { types, label, candidates, check, apply }
//     types       the action types the step accepts
//     candidates  the complete list of legal actions (the frame list)
//     check       the first reason an action is not legal, or null (the block reason)
//     apply       does the action; returns the next step name or null when finished
//
// R16.7: a Swag effect has no lasting effect unless its rule says "permanently" (only swag_orange_07, R19.1).
// R8.7 / R16.3: a Swag card may be bought when its effect does nothing, so a
// step with no legal choice is skipped, never shown as an empty frame. R8.8: an
// effect is completed as far as it legally can; the player stops early only at
// an "up to" / "may" step (effectDone).
//
// Every effect obeys the base rules unless its own rule says otherwise (R16.4):
// steps are R10 steps (full halls are walls, Usher bonus for the mover's own
// Crew across the mover's own Usher), jumps cross no rope (R16.4.3), arrivals
// get new stamps (R16.4.4), placed Crew and Volunteers come from supply
// (R16.4.1), only empty spaces take a Volunteer (R16.4.5), and queue order is
// still R9.1 (R16.4.6).

import { getConstants, pushFrame, popFrame } from './state.js';
import { HALL_IDS, ROPES, COLOURS, hallName, spaceById, isHallId, areAdjacent } from './board.js';
import {
  crewById,
  crewOnBoard,
  figuresOnBoard,
  hasRoom,
  isFull,
  movePaths,
  hasAnyStep,
  queue,
  primeOwner,
  securityOwner,
  hallCount,
  capacity,
  scheduleOfCard,
  selfieTargets,
  selfieTotal,
  volunteersOf,
  emptySpaces,
  swagCard,
  clubCard,
  celebrityCard,
  achievementCard,
  formatSelfies,
} from './queries.js';
import { scoreAchievement, addVp } from './scoring.js';
import { emit, EVENTS } from './events.js';
import { rngNext } from './rng.js';
import {
  gainCoffee,
  gainSelfies,
  spendSelfies,
  oneSelfie,
  moveCrewAlong,
  jumpCrew,
  stampToFront,
  swapStamps,
  upgradeCrew,
  placeNewCrew,
  placeVolunteer,
  moveVolunteer,
  drawAchievement,
  takeAchievementFromDeck,
  discardAchievementUnscored,
} from './primitives.js';
import { nameOf, plural, crewLabel, fullText, noPathReason, isSelfieObject, compositions, spaceLabel } from './text.js';

// ---------------------------------------------------------------------------
// Little readers
// ---------------------------------------------------------------------------

function params(state, card) {
  const K = getConstants(state);
  return K.SWAG.SWAG_PARAMS[card] ?? K.CLUBS.CLUBS[card] ?? {};
}

function cardName(source) {
  const c = source.kind === 'swag' ? swagCard(source.card) : clubCard(source.card);
  return c ? c.name : source.card;
}

/** Halls touched by a rope holding an Usher of `seat` (any player when seat is null). R13.7.1 */
function hallsTouchedByUshers(state, seat) {
  const out = new Set();
  for (const r of ROPES) {
    const owner = state.volunteers[r.id];
    if (owner !== null && (seat === null || owner === seat)) for (const h of r.halls) out.add(h);
  }
  return out;
}

function ownCrewIn(state, seat, hall) {
  return state.crew.filter((c) => c.owner === seat && c.hall === hall).length;
}

function gain(state, seat, amount, card, kind) {
  if (amount > 0) gainCoffee(state, seat, amount, kind, { detail: { card } });
}

/** The sentence for a hall that cannot be chosen. */
function upper(text) {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function notAHall(a) {
  return `"${a}" is not a hall.`;
}

// ---------------------------------------------------------------------------
// Step kinds
// ---------------------------------------------------------------------------

/**
 * A Crew moves: by steps (R10.2-R10.5, R16.4.2) or by a jump (R16.4.3).
 * spec: { label, crew(state, seat, crew), crewReason(state, seat, crew), mode, max(state),
 *         dest(state, seat, crew, to) (extra condition on the destination), destReason(...) }
 */
function moveStep(spec) {
  const bonusFor = (seat, crew) => (crew.owner === seat ? seat : null);
  const destinations = (state, seat, crew) => {
    if (spec.mode === 'steps') {
      const paths = movePaths(state, crew, spec.max(state), bonusFor(seat, crew));
      return HALL_IDS.filter((h) => paths[h] && (!spec.dest || spec.dest(state, seat, crew, h)));
    }
    return HALL_IDS.filter((h) => h !== crew.hall && hasRoom(state, h) && spec.dest(state, seat, crew, h));
  };
  return {
    types: ['effectMove'],
    label: spec.label,
    candidates(state, frame) {
      const out = [];
      for (const crew of state.crew) {
        if (crew.hall === null || !spec.crew(state, frame.player, crew)) continue;
        for (const to of destinations(state, frame.player, crew)) out.push({ type: 'effectMove', crew: crew.id, to });
      }
      return out;
    },
    check(state, frame, a) {
      const seat = frame.player;
      const crew = crewById(state, a.crew);
      if (!crew) return `There is no Crew "${a.crew}".`;
      if (crew.hall === null) return 'That Crew is still in supply; only Crew on the board can be moved.';
      if (!spec.crew(state, seat, crew)) return spec.crewReason(state, seat, crew);
      if (!isHallId(a.to)) return notAHall(a.to);
      if (a.to === crew.hall) return `That Crew is already in ${hallName(a.to)}; it must end somewhere else (R16.4.3).`;
      if (spec.mode === 'steps') {
        const max = spec.max(state);
        if (!movePaths(state, crew, max, bonusFor(seat, crew))[a.to]) return noPathReason(state, crew, a.to, max, cardName(frame.source));
      } else if (isFull(state, a.to)) {
        return `${fullText(state, a.to)}.`;
      }
      if (spec.dest && !spec.dest(state, seat, crew, a.to)) return spec.destReason(state, seat, crew, a.to);
      return null;
    },
    apply(state, frame, a) {
      const crew = crewById(state, a.crew);
      if (spec.mode === 'steps') {
        const best = movePaths(state, crew, spec.max(state), bonusFor(frame.player, crew))[a.to];
        moveCrewAlong(state, crew, best.path, frame.player, frame.source.card);
      } else {
        jumpCrew(state, crew, a.to, frame.player, frame.source.card);
      }
      return null;
    },
  };
}

const ownCrew = {
  crew: (state, seat, crew) => crew.owner === seat,
  crewReason: (state, seat, crew) => `That Crew is ${nameOf(state, crew.owner)}'s; this card moves your own Crew (R16.4.7).`,
};

/** A N00b from supply is placed in a hall (R16.4.1). spec: { label, badge(frame), halls(state, seat, frame), hallReason(...), front } */
function placeCrewStep(spec) {
  return {
    types: ['effectPlaceCrew'],
    label: spec.label,
    candidates(state, frame) {
      if (!state.crew.some((c) => c.owner === frame.player && c.hall === null)) return [];
      return spec.halls(state, frame.player, frame).map((hall) => ({ type: 'effectPlaceCrew', hall }));
    },
    check(state, frame, a) {
      if (!state.crew.some((c) => c.owner === frame.player && c.hall === null)) return 'All of your Crew are on the board (R16.4.1).';
      if (!isHallId(a.hall)) return notAHall(a.hall);
      if (isFull(state, a.hall)) return `${fullText(state, a.hall)}.`;
      if (!spec.halls(state, frame.player, frame).includes(a.hall)) return spec.hallReason(state, frame.player, a.hall);
      return null;
    },
    apply(state, frame, a) {
      placeNewCrew(state, frame.player, a.hall, spec.badge(frame), frame.source.card, { front: spec.front === true });
      return null;
    },
  };
}

/** Volunteers of one role go on empty spaces (R16.4.5), `max` of them (min 1, then effectDone). */
function placeVolunteersStep(spec) {
  const supplyBlock = (state, seat) => (state.players[seat].volunteers <= 0 ? 'You have no Volunteer left in your supply (R16.4.1).' : null);
  return {
    types: ['effectPlaceVolunteer', 'effectDone'],
    label: spec.label,
    candidates(state, frame) {
      const out = [];
      if (supplyBlock(state, frame.player) === null) {
        for (const sp of emptySpaces(state, spec.role)) out.push({ type: 'effectPlaceVolunteer', space: sp.id });
      }
      if (frame.data.placed >= 1) out.push({ type: 'effectDone' });
      return out;
    },
    check(state, frame, a) {
      if (a.type === 'effectDone') return frame.data.placed >= 1 ? null : 'Place at least one Volunteer first.';
      const sp = spaceById(a.space);
      if (!sp) return `"${a.space}" is not a volunteer space.`;
      if (spec.role !== null && sp.role !== spec.role) return `${cardName(frame.source)} places a ${spec.roleName}, and ${spaceLabel(a.space)} is not one of those spaces.`;
      if (state.volunteers[a.space] !== null) return `${upper(spaceLabel(a.space))} already holds ${nameOf(state, state.volunteers[a.space])}'s Volunteer (R3.5).`;
      return supplyBlock(state, frame.player);
    },
    apply(state, frame, a) {
      if (a.type === 'effectDone') return null;
      placeVolunteer(state, frame.player, a.space, frame.source.card);
      frame.data.placed += 1;
      return frame.data.placed >= spec.max ? null : 'place';
    },
  };
}

/**
 * A single choice among values: effectChooseHall (hall), effectChooseCrew (crew),
 * effectChooseCelebrity (celebrity), effectChooseAchievement (card).
 * spec: { type, param, label, options(state, frame), reason(state, frame, value), apply(state, frame, value) -> next step | null }
 */
function chooseStep(spec) {
  return {
    types: [spec.type],
    label: spec.label,
    candidates: (state, frame) => spec.options(state, frame).map((v) => ({ type: spec.type, [spec.param]: v })),
    check(state, frame, a) {
      if (!spec.options(state, frame).includes(a[spec.param])) return spec.reason(state, frame, a[spec.param]);
      return null;
    },
    apply: (state, frame, a) => spec.apply(state, frame, a[spec.param]),
  };
}

/** Gain selfies of chosen colours, `frame.data.total` in all. spec: { cause, then(state, frame, gain) } */
function gainSelfiesStep(spec) {
  return {
    types: ['effectGainSelfies'],
    label: (state, frame) => `choose the colours of ${plural(frame.data.total, 'Selfie', 'Selfies')}`,
    candidates: (state, frame) => compositions(frame.data.total).map((g) => ({ type: 'effectGainSelfies', gain: g })),
    check(state, frame, a) {
      if (!isSelfieObject(a.gain, frame.data.total)) return `Choose exactly ${plural(frame.data.total, 'Selfie', 'Selfies')} as { green, red, orange }.`;
      return null;
    },
    apply(state, frame, a) {
      spec.then(state, frame, a.gain);
      return null;
    },
  };
}

// ---------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------

/** card id -> { kind: 'swag' | 'club', begin, steps } */
export const EFFECTS = {};

function define(card, kind, begin, steps = {}) {
  EFFECTS[card] = { kind, begin, steps };
}

/** An effect with no choice. */
function auto(card, kind, fn) {
  define(card, kind, (state, seat) => {
    fn(state, seat, params(state, card));
    return null;
  });
}

const frameStart = (step, data) => ({ step, data });

// ----- Green ---------------------------------------------------------------

// swag_green_01 Jumper (Security), swag_red_01 Guide (Usher), swag_orange_01 Selfie Booth (Photographer)
for (const [card, role, name] of [
  ['swag_green_01', 'security', 'Security volunteer'],
  ['swag_red_01', 'usher', 'Usher'],
  ['swag_orange_01', 'photographer', 'Photographer'],
]) {
  define(card, 'swag', () => frameStart('place', { placed: 0 }), {
    place: placeVolunteersStep({ role, roleName: name, max: 1, label: () => `place a Volunteer on an empty ${name} space` }),
  });
}

// R16.8 swag_green_02 Teleport: a jump of one of your Crew to any other hall with room.
define('swag_green_02', 'swag', () => frameStart('move', {}), {
  move: moveStep({
    ...ownCrew,
    label: () => 'choose one of your Crew and any hall with room to move it to',
    mode: 'jump',
    dest: () => true,
  }),
});

// R16.8 swag_green_03 Star Chaser: a jump to a hall with room that holds a celebrity figure.
define('swag_green_03', 'swag', () => frameStart('move', {}), {
  move: moveStep({
    ...ownCrew,
    label: () => 'choose one of your Crew and a hall with a celebrity to move it to',
    mode: 'jump',
    dest: (state, seat, crew, to) => figuresOnBoard(state).some((s) => s.figure === to),
    destReason: (state, seat, crew, to) => `No celebrity is standing in ${hallName(to)}.`,
  }),
});

// R16.8 swag_green_04 3-2-1 Push! and swag_green_07 Run!: one Crew along a path of up to N steps.
for (const card of ['swag_green_04', 'swag_green_07']) {
  define(card, 'swag', () => frameStart('move', {}), {
    move: moveStep({
      ...ownCrew,
      label: (state) => `choose one of your Crew and a hall up to ${plural(params(state, card).MAX_STEPS, 'hall', 'halls')} away`,
      mode: 'steps',
      max: (state) => params(state, card).MAX_STEPS,
    }),
  });
}

// R16.8 swag_green_05 Line Monitor: coffee for each of your Crew in a hall where you have the Security volunteer.
define('swag_green_05', 'swag', () => frameStart('hall', {}), {
  hall: chooseStep({
    type: 'effectChooseHall',
    param: 'hall',
    label: () => 'choose a hall where you have the Security volunteer',
    options: (state, frame) => HALL_IDS.filter((h) => securityOwner(state, h) === frame.player),
    reason: (state, frame, h) => (isHallId(h) ? `You do not have the Security volunteer in ${hallName(h)}.` : notAHall(h)),
    apply(state, frame, h) {
      const P = params(state, frame.source.card);
      gain(state, frame.player, P.COFFEE_PER_CREW * ownCrewIn(state, frame.player, h), frame.source.card, 'swag');
      return null;
    },
  }),
});

// R16.8 swag_green_06 Fast Track: one of your Crew to the front of its class (an earlier stamp, R16.4.6).
define('swag_green_06', 'swag', () => frameStart('crew', {}), {
  crew: chooseStep({
    type: 'effectChooseCrew',
    param: 'crew',
    label: () => 'choose one of your Crew to move to the front of its queue class',
    options: (state, frame) => crewOnBoard(state, frame.player).map((c) => c.id),
    reason: (state, frame, id) => `${id} is not one of your Crew on the board.`,
    apply(state, frame, id) {
      stampToFront(state, crewById(state, id));
      return null;
    },
  }),
});

// R16.8 swag_green_08 Rush!: up to two single steps by different Crew (the R10.7 frame, at least one).
define('swag_green_08', 'swag', (state, seat) => {
  const P = params(state, 'swag_green_08');
  if (!hasAnyStep(state, seat)) return null;
  return { frame: { kind: 'moveSteps', player: seat, moved: [], max: P.MAX_CREW, source: 'swag_green_08' } };
});

// R16.8 swag_green_09 Hold Hands: two of your Crew in one hall step together to an adjacent hall with 2 free places.
function holdHandsPairs(state, seat) {
  const P = params(state, 'swag_green_09');
  const out = [];
  for (const hall of HALL_IDS) {
    const mine = queue(state, hall).filter((c) => c.owner === seat);
    if (mine.length < P.CREW) continue;
    for (let i = 0; i < mine.length; i++) {
      for (let j = i + 1; j < mine.length; j++) {
        for (const to of HALL_IDS) {
          if (!movePaths(state, mine[i], 1, null)[to]) continue; // adjacent (and has room for one)
          if (capacity(state) - hallCount(state, to) < P.CREW) continue; // room for both
          out.push({ crew: mine[i].id, other: mine[j].id, to });
        }
      }
    }
  }
  return out;
}
define('swag_green_09', 'swag', () => frameStart('pair', {}), {
  pair: {
    types: ['effectMovePair'],
    label: () => 'choose two of your Crew in one hall and an adjacent hall with room for both',
    candidates: (state, frame) => holdHandsPairs(state, frame.player).map((p) => ({ type: 'effectMovePair', ...p })),
    check(state, frame, a) {
      const seat = frame.player;
      const c1 = crewById(state, a.crew);
      const c2 = crewById(state, a.other);
      if (!c1 || !c2) return 'Choose two of your Crew.';
      if (c1.id === c2.id) return 'Choose two different Crew.';
      for (const c of [c1, c2]) {
        if (c.owner !== seat) return `That Crew is ${nameOf(state, c.owner)}'s; Hold Hands moves two of your own.`;
        if (c.hall === null) return 'That Crew is still in your supply.';
      }
      if (c1.hall !== c2.hall) return `The two Crew must start in the same hall (they are in ${hallName(c1.hall)} and ${hallName(c2.hall)}).`;
      if (!isHallId(a.to)) return notAHall(a.to);
      if (!areAdjacent(c1.hall, a.to)) return `${hallName(a.to)} is not next to ${hallName(c1.hall)}.`;
      const free = capacity(state) - hallCount(state, a.to);
      if (free < 2) return `${hallName(a.to)} has ${plural(Math.max(free, 0), 'free place', 'free places')} and Hold Hands needs 2 (capacity ${capacity(state)}).`;
      return null;
    },
    apply(state, frame, a) {
      const seat = frame.player;
      const pair = [crewById(state, a.crew), crewById(state, a.other)];
      const q = queue(state, pair[0].hall);
      pair.sort((x, y) => q.indexOf(x) - q.indexOf(y)); // the one further forward arrives first (old relative order kept)
      for (const c of pair) moveCrewAlong(state, c, [c.hall, a.to], seat, frame.source.card);
      return null;
    },
  },
});

// R16.8 swag_green_10 Too Crowded: an opponent's N00b steps to an adjacent hall with room. No Usher bonus (R10.4).
define('swag_green_10', 'swag', () => frameStart('move', {}), {
  move: moveStep({
    label: () => "choose another player's N00b and an adjacent hall with room",
    crew: (state, seat, crew) => crew.owner !== seat && crew.badge === 'N00b',
    crewReason: (state, seat, crew) =>
      crew.owner === seat ? 'Too Crowded moves an opponent\'s N00b, not your own.' : `${crewLabel(state, crew, seat)} is not a N00b; Too Crowded moves N00b only.`,
    mode: 'steps',
    max: () => 1,
  }),
});

// R16.8 swag_green_11 Priority: a fresh N00b in any hall with room, at the front of its class.
define('swag_green_11', 'swag', () => frameStart('place', {}), {
  place: placeCrewStep({
    label: () => 'choose a hall with room for a fresh N00b in Prime Position',
    badge: () => 'N00b',
    front: true,
    halls: (state) => HALL_IDS.filter((h) => hasRoom(state, h)),
    hallReason: (state, seat, h) => `${fullText(state, h)}.`,
  }),
});

// R16.8 swag_green_12 Over Here!: a jump to a hall with room where you have the Security volunteer.
define('swag_green_12', 'swag', () => frameStart('move', {}), {
  move: moveStep({
    ...ownCrew,
    label: () => 'choose one of your Crew and a hall where you have the Security volunteer',
    mode: 'jump',
    dest: (state, seat, crew, to) => securityOwner(state, to) === seat,
    destReason: (state, seat, crew, to) => `You do not have the Security volunteer in ${hallName(to)}.`,
  }),
});

// ----- Red -----------------------------------------------------------------

// R16.8 swag_red_02 Shared Ticket: a N00b in a hall with room that holds one of your VIP or AAA Crew.
define('swag_red_02', 'swag', () => frameStart('place', {}), {
  place: placeCrewStep({
    label: () => 'choose a hall with one of your VIP or AAA Crew for a fresh N00b',
    badge: () => 'N00b',
    halls: (state, seat) =>
      HALL_IDS.filter((h) => hasRoom(state, h) && state.crew.some((c) => c.owner === seat && c.hall === h && c.badge !== 'N00b')),
    hallReason: (state, seat, h) => `You have no VIP or AAA Crew in ${hallName(h)}.`,
  }),
});

// R16.8 swag_red_03 Coffee Break: gain 3 coffee.
auto('swag_red_03', 'swag', (state, seat, P) => gain(state, seat, P.COFFEE, 'swag_red_03', 'swag'));

// R16.8 swag_red_04 Upgrade!: as the Upgrade Crew action (R12) without the coffee.
function upgradable(state, seat) {
  const p = state.players[seat];
  return crewOnBoard(state, seat).filter((c) => (c.badge === 'N00b' && p.hats > 0) || (c.badge === 'VIP' && p.boxes > 0));
}
define('swag_red_04', 'swag', () => frameStart('crew', {}), {
  crew: chooseStep({
    type: 'effectChooseCrew',
    param: 'crew',
    label: () => 'choose one of your Crew to upgrade',
    options: (state, frame) => upgradable(state, frame.player).map((c) => c.id),
    reason: (state, frame, id) => {
      const c = crewById(state, id);
      if (!c || c.owner !== frame.player || c.hall === null) return `${id} is not one of your Crew on the board.`;
      if (c.badge === 'AAA') return 'That Crew is already AAA (R12.1).';
      return c.badge === 'N00b' ? 'You have no VIP hat left in your supply (R12.4).' : 'You have no AAA box left in your supply (R12.4).';
    },
    apply(state, frame, id) {
      upgradeCrew(state, crewById(state, id), frame.source.card);
      return null;
    },
  }),
});

// R16.8 swag_red_05 All Together / swag_red_11 Coffee Run: pick a hall, coffee for the Crew there.
for (const [card, who] of [
  ['swag_red_05', 'own'],
  ['swag_red_11', 'any'],
]) {
  define(card, 'swag', () => frameStart('hall', {}), {
    hall: chooseStep({
      type: 'effectChooseHall',
      param: 'hall',
      label: () => 'choose a hall',
      options: () => HALL_IDS.slice(),
      reason: (state, frame, h) => notAHall(h),
      apply(state, frame, h) {
        const P = params(state, card);
        const crews = who === 'own' ? ownCrewIn(state, frame.player, h) : hallCount(state, h);
        const n = P.COFFEE_PER_CREW * crews;
        gain(state, frame.player, P.MAX_COFFEE !== undefined ? Math.min(n, P.MAX_COFFEE) : n, card, 'swag');
        return null;
      },
    }),
  });
}

// R16.8 swag_red_06 Network: 2 coffee per Usher of yours on the board.
auto('swag_red_06', 'swag', (state, seat, P) =>
  gain(state, seat, P.COFFEE_PER_USHER * volunteersOf(state, seat, 'usher').length, 'swag_red_06', 'swag'));

// R16.8 swag_red_07 Special Line: a jump to a hall with room that is touched by an Usher's rope (any player's).
define('swag_red_07', 'swag', () => frameStart('move', {}), {
  move: moveStep({
    ...ownCrew,
    label: () => 'choose one of your Crew and a hall next to an Usher',
    mode: 'jump',
    dest: (state, seat, crew, to) => hallsTouchedByUshers(state, null).has(to),
    destReason: (state, seat, crew, to) => `No rope touching ${hallName(to)} holds an Usher.`,
  }),
});

// R16.8 swag_red_08 Staff Line: a N00b in a hall with room touched by a rope holding one of your Ushers.
define('swag_red_08', 'swag', () => frameStart('place', {}), {
  place: placeCrewStep({
    label: () => 'choose a hall next to one of your Ushers for a fresh N00b',
    badge: () => 'N00b',
    halls: (state, seat) => {
      const near = hallsTouchedByUshers(state, seat);
      return HALL_IDS.filter((h) => hasRoom(state, h) && near.has(h));
    },
    hallReason: (state, seat, h) => `No rope touching ${hallName(h)} holds one of your Ushers.`,
  }),
});

// R16.8 swag_red_09 Path: up to two Ushers on empty ropes (at least one, ruled Q18: one if only one is possible).
define('swag_red_09', 'swag', () => frameStart('place', { placed: 0 }), {
  place: placeVolunteersStep({ role: 'usher', roleName: 'Usher', max: 2, label: (state, frame) => (frame.data.placed === 0 ? 'place an Usher on an empty rope' : 'place a second Usher, or finish') }),
});

// R16.8 swag_red_10 Miranda!: 2 coffee per VIP or AAA Crew of yours on the board.
auto('swag_red_10', 'swag', (state, seat, P) =>
  gain(state, seat, P.COFFEE_PER_VIP * crewOnBoard(state, seat).filter((c) => c.badge !== 'N00b').length, 'swag_red_10', 'swag'));

// R16.8 swag_red_12 Velvet Rope: 1 VP per Crew of yours in a hall touched by a rope holding one of your Ushers.
auto('swag_red_12', 'swag', (state, seat, P) => {
  const near = hallsTouchedByUshers(state, seat);
  const n = crewOnBoard(state, seat).filter((c) => near.has(c.hall)).length;
  addVp(state, seat, P.VP_PER_CREW * n, 'swag', { card: 'swag_red_12' });
});

// ----- Orange --------------------------------------------------------------

// R16.8 swag_orange_02 Excuse Me!: two Crew adjacent in a queue (different players, same badge, same Security
// standing) swap places by swapping arrival stamps.
function swapPairs(state) {
  const out = [];
  for (const hall of HALL_IDS) {
    const q = queue(state, hall);
    const sec = securityOwner(state, hall);
    for (let i = 0; i + 1 < q.length; i++) {
      const a = q[i];
      const b = q[i + 1];
      if (a.owner === b.owner || a.badge !== b.badge) continue;
      if ((a.owner === sec) !== (b.owner === sec)) continue;
      out.push({ crew: a.id, other: b.id });
    }
  }
  return out;
}
define('swag_orange_02', 'swag', () => frameStart('swap', {}), {
  swap: {
    types: ['effectSwap'],
    label: () => 'choose two neighbours in a queue to swap places',
    candidates: (state) => swapPairs(state).map((p) => ({ type: 'effectSwap', ...p })),
    check(state, frame, a) {
      const c1 = crewById(state, a.crew);
      const c2 = crewById(state, a.other);
      if (!c1 || !c2 || c1.hall === null || c2.hall === null) return 'Choose two Crew on the board.';
      if (c1.hall !== c2.hall) return `The two Crew must be in the same queue (they are in ${hallName(c1.hall)} and ${hallName(c2.hall)}).`;
      const q = queue(state, c1.hall);
      if (Math.abs(q.indexOf(c1) - q.indexOf(c2)) !== 1) return 'The two Crew must be next to each other in the queue (R9.1).';
      if (c1.owner === c2.owner) return 'Excuse Me! swaps Crew of two different players: the queue rules would undo a swap of one player\'s own Crew.';
      if (c1.badge !== c2.badge) return `The two Crew must wear the same badge (${c1.badge} and ${c2.badge}), or the queue rules would undo the swap (R9.1).`;
      const sec = securityOwner(state, c1.hall);
      if ((c1.owner === sec) !== (c2.owner === sec)) return `One of them is led by ${nameOf(state, sec)}'s Security volunteer and the other is not, so the queue rules would undo the swap (R9.1).`;
      return null;
    },
    apply(state, frame, a) {
      swapStamps(crewById(state, a.crew), crewById(state, a.other));
      return null;
    },
  },
});

// R16.8 swag_orange_03 Collector: 3 selfies of the colour of any celebrity on the board.
define('swag_orange_03', 'swag', () => frameStart('celebrity', {}), {
  celebrity: chooseStep({
    type: 'effectChooseCelebrity',
    param: 'celebrity',
    label: () => 'choose a celebrity on the board',
    options: (state) => figuresOnBoard(state).map((s) => s.card),
    reason: (state, frame, c) => `${celebrityCard(c) ? celebrityCard(c).name : c} is not on the board.`,
    apply(state, frame, card) {
      const entry = scheduleOfCard(state, card);
      gainSelfies(state, frame.player, oneSelfie(entry.colour, params(state, 'swag_orange_03').SELFIES), 'swag', { card: frame.source.card, celebrity: card });
      return null;
    },
  }),
});

// R16.8 swag_orange_04 Much Better: score an Achievement in hand at x1 (source achievement-swag), then draw.
define('swag_orange_04', 'swag', (state, seat) => {
  const P = params(state, 'swag_orange_04');
  if (state.players[seat].hand.length === 0) {
    for (let i = 0; i < P.DRAW; i++) drawAchievement(state, seat, 'swag');
    return null;
  }
  return frameStart('card', {});
}, {
  card: chooseStep({
    type: 'effectChooseAchievement',
    param: 'card',
    label: () => 'choose an Achievement in your hand to score now',
    options: (state, frame) => state.players[frame.player].hand.slice(),
    reason: () => 'That Achievement is not in your hand.',
    apply(state, frame, card) {
      const P = params(state, 'swag_orange_04');
      scoreAchievement(state, frame.player, card, P.MULTIPLIER, 'swag');
      for (let i = 0; i < P.DRAW; i++) drawAchievement(state, frame.player, 'swag');
      return null;
    },
  }),
});

// R16.8 swag_orange_05 We're Full!: the last Crew in any hall's queue (any player's) steps to an adjacent hall with room.
define('swag_orange_05', 'swag', () => frameStart('move', {}), {
  move: moveStep({
    label: () => "choose the Crew at the end of a queue and an adjacent hall with room",
    crew: (state, seat, crew) => {
      const q = queue(state, crew.hall);
      return q[q.length - 1] === crew;
    },
    crewReason: (state, seat, crew) => `${crewLabel(state, crew, seat)} is not last in its queue; We're Full! moves the Crew at the end of a line.`,
    mode: 'steps',
    max: () => 1,
  }),
});

// R16.8 swag_orange_06 Cameras!: 2 coffee per Photographer of yours.
auto('swag_orange_06', 'swag', (state, seat, P) =>
  gain(state, seat, P.COFFEE_PER_PHOTOGRAPHER * volunteersOf(state, seat, 'photographer').length, 'swag_orange_06', 'swag'));

// R16.8 swag_orange_07 Achiever (variant `achiever`, R26.2): hand size +1 and draw 1, or draw 2 and keep 1.
define('swag_orange_07', 'swag', (state, seat) => {
  const P = params(state, 'swag_orange_07');
  const p = state.players[seat];
  p.achieversUsed += 1;
  if (state.variants.achiever === 'hand-size') {
    p.handSize += P.HAND_BONUS; // R19.1
    for (let i = 0; i < P.DRAW; i++) drawAchievement(state, seat, 'swag');
    return null;
  }
  // draw-two-keep-one: the two cards are held aside until one is kept; no lasting hand size effect.
  const cards = [];
  for (let i = 0; i < P.DRAW_TWO; i++) {
    const c = takeAchievementFromDeck(state);
    if (c === null) break;
    cards.push(c);
    emit({ type: EVENTS.ACHIEVEMENT_DRAWN, player: seat, card: c, cause: 'swag', secret: true });
  }
  if (cards.length === 1) {
    p.hand.push(cards[0]);
    return null;
  }
  if (cards.length === 0) return null;
  return { frame: { kind: 'achieverKeep', player: seat, cards } };
});

// R16.8 swag_orange_08 Influencer: 2 VP per selfie you hold after paying, at most 10. Selfies are not spent.
auto('swag_orange_08', 'swag', (state, seat, P) => {
  const n = selfieTotal(state.players[seat].selfies);
  addVp(state, seat, Math.min(P.VP_PER_SELFIE * n, P.MAX_VP), 'swag', { card: 'swag_orange_08' });
});

// R16.8 swag_orange_09 Photo Rally: 1 selfie per Photographer of yours, of colours you choose.
define('swag_orange_09', 'swag', (state, seat) => {
  const n = params(state, 'swag_orange_09').SELFIES_PER_PHOTOGRAPHER * volunteersOf(state, seat, 'photographer').length;
  return n > 0 ? frameStart('gain', { total: n }) : null;
}, {
  gain: gainSelfiesStep({
    then: (state, frame, g) => gainSelfies(state, frame.player, g, 'swag', { card: frame.source.card }),
  }),
});

// R16.8 swag_orange_10 Colour Swap: change the colour of any number of your selfies (each at most once).
function convertible(state, frame, colour) {
  return state.players[frame.player].selfies[colour] - frame.data.fixed[colour];
}
define('swag_orange_10', 'swag', (state, seat) => (selfieTotal(state.players[seat].selfies) > 0 ? frameStart('convert', { fixed: { green: 0, red: 0, orange: 0 } }) : null), {
  convert: {
    types: ['effectConvertSelfie', 'effectDone'],
    label: () => 'turn a Selfie into another colour, or finish',
    candidates(state, frame) {
      const out = [];
      for (const from of COLOURS) {
        if (convertible(state, frame, from) < 1) continue;
        for (const to of COLOURS) if (to !== from) out.push({ type: 'effectConvertSelfie', from, to });
      }
      out.push({ type: 'effectDone' });
      return out;
    },
    check(state, frame, a) {
      if (a.type === 'effectDone') return null;
      if (!COLOURS.includes(a.from) || !COLOURS.includes(a.to)) return 'Colour Swap names two colours: green, red or orange.';
      if (a.from === a.to) return 'Choose a different colour to turn the Selfie into.';
      if (convertible(state, frame, a.from) < 1) return `You have no ${a.from} Selfie left to change (a Selfie that has already been changed cannot change again).`;
      return null;
    },
    apply(state, frame, a) {
      if (a.type === 'effectDone') return null;
      spendSelfies(state, frame.player, oneSelfie(a.from), 'swag-convert');
      gainSelfies(state, frame.player, oneSelfie(a.to), 'swag', { card: frame.source.card, converted: a.from });
      frame.data.fixed[a.to] += 1;
      return 'convert';
    },
  },
});

// R16.8 swag_orange_11 Trending: 3 selfies of colours you choose.
define('swag_orange_11', 'swag', (state) => frameStart('gain', { total: params(state, 'swag_orange_11').SELFIES }), {
  gain: gainSelfiesStep({
    then: (state, frame, g) => gainSelfies(state, frame.player, g, 'swag', { card: frame.source.card }),
  }),
});

// R16.8 swag_orange_12 Look at me!: 3 VP per hall where you have the Photographer and one of your Crew is first.
auto('swag_orange_12', 'swag', (state, seat, P) => {
  const n = HALL_IDS.filter((h) => state.volunteers[`photographer-${h}`] === seat && primeOwner(state, h) === seat).length;
  addVp(state, seat, P.VP_PER_HALL * n, 'swag', { card: 'swag_orange_12' });
});

// ---------------------------------------------------------------------------
// The Clubs (R17.6): main-action powers. club_07 and club_09 are free
// conversions (legality.js / actions.js), not here.
// ---------------------------------------------------------------------------

/** R17.6 - the options a Club's main action offers (contract 5.1). */
export const CLUB_OPTIONS = Object.freeze({
  club_01: ['vip', 'aaa'],
  club_02: ['use'],
  club_03: ['use'],
  club_04: ['vp', 'selfies'],
  club_05: ['use'],
  club_06: ['use'],
  club_08: ['use'],
});

/** R17.6 - the coffee a Club power costs for an option. */
export function clubCost(state, club, option) {
  const C = getConstants(state).CLUBS.CLUBS[club];
  if (club === 'club_01') return option === 'aaa' ? C.COST_AAA : C.COST_VIP;
  return C.COST;
}

/** R17.6.8 - halls where one of your Crew holds Prime Position. */
function primeHalls(state, seat) {
  return HALL_IDS.filter((h) => primeOwner(state, h) === seat);
}

/**
 * R8.7, R17.6 - why a Club power has nothing to do right now (after paying
 * its cost), or null. Checked after the cost, in the card's own order.
 */
export function clubAvailability(state, seat, club, option) {
  const p = state.players[seat];
  const K = getConstants(state);
  switch (club) {
    case 'club_01': {
      if (!state.crew.some((c) => c.owner === seat && c.hall === null)) return `All ${K.SUPPLY.CREW_PER_PLAYER} of your Crew are on the board (R17.6.1).`;
      if (p.hats <= 0) return 'You have no VIP hat left in your supply (R17.6.1).';
      if (option === 'aaa' && p.boxes <= 0) return 'You have no AAA box left in your supply (R17.6.1).';
      if (!HALL_IDS.some((h) => hasRoom(state, h))) return 'Every hall is full (R17.6.1).';
      return null;
    }
    case 'club_02': {
      const canPlace = p.volunteers > 0 && emptySpaces(state).length > 0;
      const canMove = volunteersOf(state, seat).length > 0 && emptySpaces(state).length > 0;
      return canPlace || canMove ? null : 'You have no Volunteer to place or move, or no empty space to put one (R17.6.2).';
    }
    case 'club_03':
      return selfieTargets(state, seat).length > 0 ? null : 'You have no Crew in a hall with a celebrity (R17.6.3).';
    case 'club_04':
      if (option === 'vp' && selfieTotal(p.selfies) === 0) return 'You hold no Selfies, so Collectibles would score nothing (R17.6.4, R8.7).';
      return null;
    case 'club_08':
      return primeHalls(state, seat).length > 0 ? null : 'You are not first in the queue in any hall, so High Score would score nothing (R17.6.8, R8.7).';
    default:
      return null;
  }
}

// R17.6.1 club_01 Silver Screen Society: pay 5 (VIP) or 8 (AAA); place a badged Crew in any hall with room.
define('club_01', 'club', (state, seat, options) => frameStart('place', { badge: options.option === 'aaa' ? 'AAA' : 'VIP' }), {
  place: placeCrewStep({
    label: (state, frame) => `choose a hall with room for your new ${frame.data.badge} Crew`,
    badge: (frame) => frame.data.badge,
    halls: (state) => HALL_IDS.filter((h) => hasRoom(state, h)),
    hallReason: (state, seat, h) => `${fullText(state, h)}.`,
  }),
});

// R17.6.2 club_02 Player One Posse: place one Volunteer (once) and/or move placed Volunteers (each once), at least one.
define('club_02', 'club', () => frameStart('posse', { placed: false, moved: [] }), {
  posse: {
    types: ['effectPlaceVolunteer', 'effectMoveVolunteer', 'effectDone'],
    label: (state, frame) => (frame.data.placed || frame.data.moved.length > 0 ? 'place or move another Volunteer, or finish' : 'place a Volunteer on any empty space, or move one of yours'),
    candidates(state, frame) {
      const out = [];
      const empty = emptySpaces(state);
      if (!frame.data.placed && state.players[frame.player].volunteers > 0) {
        for (const sp of empty) out.push({ type: 'effectPlaceVolunteer', space: sp.id });
      }
      for (const from of volunteersOf(state, frame.player)) {
        if (frame.data.moved.includes(from.id)) continue;
        for (const sp of empty) out.push({ type: 'effectMoveVolunteer', from: from.id, to: sp.id });
      }
      if (frame.data.placed || frame.data.moved.length > 0) out.push({ type: 'effectDone' });
      return out;
    },
    check(state, frame, a) {
      const d = frame.data;
      if (a.type === 'effectDone') return d.placed || d.moved.length > 0 ? null : 'Place or move at least one Volunteer first (R17.6.2).';
      if (a.type === 'effectPlaceVolunteer') {
        if (d.placed) return 'You have already placed a Volunteer with this power; Player One Posse places one (R17.6.2).';
        if (!spaceById(a.space)) return `"${a.space}" is not a volunteer space.`;
        if (state.volunteers[a.space] !== null) return `${upper(spaceLabel(a.space))} already holds ${nameOf(state, state.volunteers[a.space])}'s Volunteer (R3.5).`;
        if (state.players[frame.player].volunteers <= 0) return 'You have no Volunteer left in your supply.';
        return null;
      }
      if (!spaceById(a.from) || state.volunteers[a.from] !== frame.player) return 'You have no Volunteer on that space.';
      if (d.moved.includes(a.from)) return 'That Volunteer has already been placed or moved with this power.';
      if (!spaceById(a.to)) return `"${a.to}" is not a volunteer space.`;
      if (state.volunteers[a.to] !== null) return `${upper(spaceLabel(a.to))} already holds ${nameOf(state, state.volunteers[a.to])}'s Volunteer (R3.5).`;
      return null;
    },
    apply(state, frame, a) {
      const d = frame.data;
      if (a.type === 'effectDone') return null;
      if (a.type === 'effectPlaceVolunteer') {
        placeVolunteer(state, frame.player, a.space, frame.source.card);
        d.placed = true;
        d.moved.push(a.space); // a Volunteer just placed is not moved again (it could have gone straight there)
      } else {
        moveVolunteer(state, frame.player, a.from, a.to, frame.source.card);
        d.moved.push(a.to);
      }
      return 'posse';
    },
  },
});

// R17.6.3 club_03 Hot Glue Syndicate: 4 selfies of the colour of a celebrity where you have a Crew.
define('club_03', 'club', () => frameStart('celebrity', {}), {
  celebrity: chooseStep({
    type: 'effectChooseCelebrity',
    param: 'celebrity',
    label: () => 'choose a celebrity in a hall where you have a Crew',
    options: (state, frame) => selfieTargets(state, frame.player).map((s) => s.card),
    reason: (state, frame, c) => {
      const entry = scheduleOfCard(state, c);
      if (!entry || entry.status !== 'onBoard') return `${celebrityCard(c) ? celebrityCard(c).name : c} is not on the board.`;
      return `You have no Crew in ${hallName(entry.figure)}, where ${celebrityCard(c).name} stands (R17.6.3).`;
    },
    apply(state, frame, card) {
      const entry = scheduleOfCard(state, card);
      gainSelfies(state, frame.player, oneSelfie(entry.colour, params(state, 'club_03').SELFIES), 'club', { club: frame.source.card, celebrity: card });
      return null;
    },
  }),
});

// R17.6.4 club_04 Otaku Alliance: 1 VP per selfie held (at most 5), or 4 selfies of chosen colours.
define('club_04', 'club', (state, seat, options) => {
  const C = params(state, 'club_04');
  if (options.option === 'vp') {
    addVp(state, seat, Math.min(C.VP_PER_SELFIE * selfieTotal(state.players[seat].selfies), C.MAX_VP), 'club', { club: 'club_04' });
    return null;
  }
  return frameStart('gain', { total: C.SELFIES });
}, {
  gain: gainSelfiesStep({
    then: (state, frame, g) => gainSelfies(state, frame.player, g, 'club', { club: frame.source.card }),
  }),
});

// R17.6.5 club_05 Longbox Legion: draw 3 Achievements, then discard 3 from the hand (unscored, no coffee).
// Discards are made in ascending card order so that one set of cards is not offered in six orders.
function longboxOptions(state, frame) {
  const hand = state.players[frame.player].hand.slice().sort();
  const need = frame.data.remaining;
  return hand.filter((card, i) => card > frame.data.last && hand.length - i >= need);
}
define('club_05', 'club', (state, seat) => {
  const C = params(state, 'club_05');
  for (let i = 0; i < C.DRAW; i++) drawAchievement(state, seat, 'club');
  const remaining = Math.min(C.DISCARD, state.players[seat].hand.length);
  return remaining > 0 ? frameStart('discard', { remaining, last: '' }) : null;
}, {
  discard: chooseStep({
    type: 'effectChooseAchievement',
    param: 'card',
    label: (state, frame) => `discard an Achievement from your hand (${frame.data.remaining} to go)`,
    options: longboxOptions,
    reason: (state, frame, card) =>
      state.players[frame.player].hand.includes(card) ? 'Discard your chosen cards in ascending card order (one set of cards, one order).' : 'That Achievement is not in your hand.',
    apply(state, frame, card) {
      discardAchievementUnscored(state, frame.player, card, 'club');
      frame.data.remaining -= 1;
      frame.data.last = card;
      return frame.data.remaining > 0 ? 'discard' : null;
    },
  }),
});

// R17.6.6 club_06 Meeple Militia: choose 6 colours; each token is kept on a coin flip (else 1 VP). Variant `militiaRoll`.
define('club_06', 'club', (state) => {
  const C = params(state, 'club_06');
  const coin = state.variants.militiaRoll === 'coin';
  return frameStart('gain', { total: coin ? C.TOKENS : C.FIXED_KEPT, coin });
}, {
  gain: gainSelfiesStep({
    then(state, frame, g) {
      const C = params(state, 'club_06');
      let kept = g;
      let lost = 0;
      if (frame.data.coin) {
        kept = { green: 0, red: 0, orange: 0 };
        for (const c of COLOURS) {
          for (let i = 0; i < g[c]; i++) {
            if (rngNext(state.rng) < C.KEEP_PROBABILITY) kept[c] += 1; // R23.4: the game RNG
            else lost += 1;
          }
        }
      } else {
        lost = C.TOKENS - C.FIXED_KEPT; // `fixed`: always 3 kept (the owner's chosen colours) and 3 VP
      }
      if (selfieTotal(kept) > 0) gainSelfies(state, frame.player, kept, 'militia', { club: frame.source.card, tokens: C.TOKENS });
      addVp(state, frame.player, C.VP_PER_TOKEN_LOST * lost, 'militia', { club: frame.source.card, tokens: lost });
    },
  }),
});

// R17.6.8 club_08 Retro Gaming Guild: 2 VP per hall where one of your Crew is first.
auto('club_08', 'club', (state, seat, P) => addVp(state, seat, P.VP_PER_HALL * primeHalls(state, seat).length, 'club', { club: 'club_08' }));

// ---------------------------------------------------------------------------
// The runner
// ---------------------------------------------------------------------------

function stepOf(frame) {
  const def = EFFECTS[frame.source.card];
  return def ? def.steps[frame.step] ?? null : null;
}

/** The complete list of legal actions of an `effect` frame's current step. */
export function effectCandidates(state, frame) {
  const step = stepOf(frame);
  return step ? step.candidates(state, frame) : [];
}

/** What the pending effect asks: "Teleport: choose one of your Crew ...". */
export function effectLabel(state, frame) {
  const step = stepOf(frame);
  return `${cardName(frame.source)}: ${step ? step.label(state, frame) : 'finish the effect'}`;
}

/** The first reason `a` is not legal in this effect frame, or null (the block reason of every effect action). */
export function effectCheck(state, frame, a) {
  const step = stepOf(frame);
  if (!step) return 'That card effect is not waiting for a choice.';
  if (!step.types.includes(a.type)) return `You cannot do that now: you must ${effectLabel(state, frame)}.`;
  return step.check(state, frame, a);
}

/**
 * Starts a card's effect after its cost is paid: resolves what needs no choice
 * and pushes the first decision, if there is one (R16.3, R17.2).
 * @param {{ kind: 'swag' | 'club', card: string }} source
 * @param {object} [options] `{ option }` for the Clubs with options
 */
export function startEffect(state, seat, source, options = {}) {
  const def = EFFECTS[source.card];
  const first = def.begin(state, seat, options);
  if (first === null) return;
  if (first.frame) {
    pushFrame(state, first.frame);
    return;
  }
  const frame = { kind: 'effect', player: seat, source: { kind: source.kind, card: source.card }, step: first.step, data: first.data };
  if (effectCandidates(state, frame).length > 0) pushFrame(state, frame); // R8.7: a step with no legal choice is skipped
}

/** Applies one action of the effect on top of the stack (the frame is still there). */
export function applyEffectStep(state, frame, a) {
  const step = stepOf(frame);
  const next = step.apply(state, frame, a);
  if (next === null) {
    popFrame(state);
    return;
  }
  frame.step = next;
  if (effectCandidates(state, frame).length === 0) popFrame(state);
}

/** A one-line label for an effect action, with the card name. Reads the pending frame, if any. */
export function describeEffectAction(state, frame, a) {
  const card = frame && frame.kind === 'effect' ? `${cardName(frame.source)}: ` : '';
  const seat = frame ? frame.player : state.toAct ?? 0;
  const crew = (id) => {
    const c = crewById(state, id);
    return c ? crewLabel(state, c, seat) : String(id);
  };
  switch (a.type) {
    case 'effectMove':
      return `${card}move ${crew(a.crew)} to ${hallName(a.to)}`;
    case 'effectMovePair':
      return `${card}move ${crew(a.crew)} and ${crew(a.other)} together to ${hallName(a.to)}`;
    case 'effectPlaceCrew':
      return `${card}place the new Crew in ${hallName(a.hall)}`;
    case 'effectPlaceVolunteer':
      return `${card}place a Volunteer on ${spaceLabel(a.space)}`;
    case 'effectMoveVolunteer':
      return `${card}move your Volunteer from ${spaceLabel(a.from)} to ${spaceLabel(a.to)}`;
    case 'effectChooseHall':
      return `${card}choose ${hallName(a.hall)}`;
    case 'effectChooseCrew':
      return `${card}choose ${crew(a.crew)}`;
    case 'effectChooseCelebrity': {
      const c = celebrityCard(a.celebrity);
      const e = scheduleOfCard(state, a.celebrity);
      return `${card}choose ${c ? c.name : a.celebrity}${e ? ` (${e.colour})` : ''}`;
    }
    case 'effectSwap':
      return `${card}swap ${crew(a.crew)} with ${crew(a.other)}`;
    case 'effectGainSelfies':
      return `${card}gain ${isSelfieObject(a.gain) ? formatSelfies(a.gain) : '?'}`;
    case 'effectConvertSelfie':
      return `${card}turn 1 ${a.from} Selfie into 1 ${a.to}`;
    case 'effectChooseAchievement': {
      const c = achievementCard(a.card);
      const discarding = frame && frame.kind === 'effect' && frame.source.kind === 'club';
      return `${card}${discarding ? 'discard' : 'score'} ${c ? c.name : a.card}`;
    }
    case 'effectDone':
      return `${card}finish`;
    default:
      return a.type;
  }
}
