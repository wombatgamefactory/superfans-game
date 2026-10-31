// legality.js - what a player may do, and why not.
//
// The three layers of the legality ladder all rest on ONE set of functions,
// the block-reason functions in ACTIONS below:
//
//   1. getValidActions(state)        - the complete list of legal next actions
//                                      for the one player who must decide
//                                      (state.toAct).
//   2. getBlockReason(state, action) - null if legal, else a sentence for the
//                                      player naming the FIRST blocker in
//                                      rulebook order, with real numbers.
//   3. applyAction (actions.js)      - refuses whatever layer 2 refuses.
//
// Layer 1 lists an action only if its block reason is null, and layer 3 asks
// the same function, so the list and the mutators cannot disagree.
//
// Writing a block-reason function:
//   - check rule conditions in the order the spec states them (R8.6);
//   - put the timing check ("it is not your decision") LAST, or it hides
//     every structural reason from a player asking ahead of time;
//   - quote the numbers ("Move 2 costs 1 coffee and you have 0");
//   - write to the player as "you", in British English.
//
// Nothing here changes or copies the state.

import { getConstants, topFrame } from './state.js';
import {
  isHallId,
  hallName,
  ADJACENT,
  areAdjacent,
  hallDistance,
  ENTRANCE,
  COLOURS,
} from './board.js';
import {
  capacity,
  crewById,
  hallCount,
  isFull,
  hasRoom,
  movePaths,
  newNoobHalls,
  crewInSupply,
  crewOnBoard,
  queuePosition,
  scheduleOfCard,
  hasCrewIn,
  selfieTargets,
  canPaySelfies,
  formatSelfies,
  coffeeGainWasted,
  celebrityCard,
  achievementCard,
  clubCard,
  ordinal,
  selfieTotal,
} from './queries.js';
import { achievementValue } from './achievements.js';

// ---------------------------------------------------------------------------
// Small helpers for sentences
// ---------------------------------------------------------------------------

function nameOf(state, seat) {
  return state.players[seat].name;
}

function plural(n, one, many) {
  return `${n} ${n === 1 ? one : many}`;
}

/** "your VIP in Main Hall (2nd)" */
function crewLabel(state, crew, viewer) {
  const whose = viewer === crew.owner ? 'your' : `${nameOf(state, crew.owner)}'s`;
  if (crew.hall === null) return `${whose} ${crew.badge} in supply`;
  return `${whose} ${crew.badge} in ${hallName(crew.hall)} (${ordinal(queuePosition(state, crew.id))})`;
}

function isSelfieObject(v, total) {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  const keys = Object.keys(v);
  if (keys.length !== 3 || !COLOURS.every((c) => Number.isInteger(v[c]) && v[c] >= 0)) return false;
  return total === undefined || selfieTotal(v) === total;
}

// ---------------------------------------------------------------------------
// Families of action types, and which decision accepts which
// ---------------------------------------------------------------------------

/** R8.3 - the nine main actions (Pass included). Taking one ends the free-conversion part of the turn. */
export const MAIN_ACTION_TYPES = Object.freeze([
  'move2', 'move3', 'newNoob', 'upgrade', 'volunteer', 'takeSelfie', 'buySwag', 'clubPower', 'pass',
]);

/** R15.5 - the free conversions. They never end a turn or a conversion window by themselves. */
export const CONVERSION_TYPES = Object.freeze(['exchange', 'strikeAPose', 'rareFinds']);

/** Follow-up steps of Swag and Club effects (frame `effect`, task T9). */
export const EFFECT_STEP_TYPES = Object.freeze([
  'effectMove', 'effectMovePair', 'effectPlaceCrew', 'effectPlaceVolunteer', 'effectMoveVolunteer', 'effectChooseHall',
  'effectChooseCrew', 'effectChooseCelebrity', 'effectSwap', 'effectGainSelfies', 'effectConvertSelfie',
  'effectChooseAchievement', 'effectDone',
]);

/** The action types each kind of decision frame accepts. */
export const FRAME_ACCEPTS = Object.freeze({
  turn: [...MAIN_ACTION_TYPES, ...CONVERSION_TYPES],
  passTurn: [...CONVERSION_TYPES, 'passReward'],
  squadWindow: ['strikeAPose', 'endConversions'],
  finalWindow: ['exchange', 'strikeAPose', 'endConversions'],
  passAchievement: ['scoreAchievement', 'discardAchievement'],
  moveSteps: ['moveStep', 'stopMoving'],
  effect: [...EFFECT_STEP_TYPES], // T9
  openingPlacement: ['placeOpeningCrew'], // T9, fivePlayerOpening = fallback
  discardToLimit: ['discardSelfie'], // T9, clubHandLimits = on
  achieverKeep: ['keepAchievement'], // T9, achiever = draw-two-keep-one
});

/** The window a frame kind is, for conversion events and stats. */
const WINDOW_OF = { turn: 'turn', passTurn: 'pass-turn', squadWindow: 'squad', finalWindow: 'final' };

/** The conversion window name of a frame, or null. */
export function windowOf(frame) {
  return frame ? WINDOW_OF[frame.kind] ?? null : null;
}

// ---------------------------------------------------------------------------
// Timing
// ---------------------------------------------------------------------------

// True only inside getStructuralBlockReason ("apart from whose decision it is and which decision is pending").
let timingSuspended = false;

/** The near-universal check, always called LAST. */
function timingBlock(state, seat, type) {
  if (timingSuspended) return null;
  if (state.phase === 'ended') return 'The game is over.';
  const top = topFrame(state);
  if (top === null) return 'Nothing is waiting to be decided.';
  if (top.player !== seat) return `It is ${nameOf(state, top.player)}'s decision (${frameLabel(state, top)}), not yours.`;
  if (!FRAME_ACCEPTS[top.kind].includes(type)) return `You cannot do that now: you must ${frameLabel(state, top)} first.`;
  if (CONVERSION_TYPES.includes(type)) {
    const K = getConstants(state);
    if (top.conversions >= K.SAFETY.MAX_CONVERSIONS_PER_WINDOW) {
      return `You have made ${top.conversions} free conversions in this window (the digital safety stop): finish it with your main action or Done.`;
    }
  }
  return null;
}

/** R18.3, R8.9 - conditions on every main action, checked before its own. */
function mainActionBlock(state, seat, type) {
  const K = getConstants(state);
  const p = state.players[seat];
  if (p.passSlot > 0) return 'You have passed this Hour, so you take no more main actions until the next Hour (R18.3).';
  if (type !== 'pass' && p.mainActionsThisHour >= K.SAFETY.MAX_MAIN_ACTIONS_PER_PLAYER_PER_HOUR) {
    return `You have taken ${p.mainActionsThisHour} main actions this Hour (the digital safety stop, R8.9): you may only Pass.`;
  }
  return null;
}

function costBlock(state, seat, label, cost) {
  const have = state.players[seat].coffee;
  return have < cost ? `${label} costs ${cost} coffee and you have ${have}.` : null;
}

/** Common checks of "one of your Crew on the board". */
function ownCrewBlock(state, seat, crewId) {
  const c = crewById(state, crewId);
  if (!c) return { reason: `There is no Crew "${crewId}".`, crew: null };
  if (c.owner !== seat) return { reason: `That Crew is ${nameOf(state, c.owner)}'s; you may only move your own.`, crew: null };
  if (c.hall === null) return { reason: 'That Crew is still in your supply; only Crew on the board can move.', crew: null };
  return { reason: null, crew: c };
}

function fullText(state, hall) {
  return `${hallName(hall)} is full (${hallCount(state, hall)} of ${capacity(state)})`;
}

/** R10.2 - why no path reaches `to` within `max` steps. */
function noPathReason(state, crew, to, max, label) {
  const d = hallDistance(crew.hall, to);
  if (d > max) return `${hallName(to)} is ${d} halls from ${hallName(crew.hall)}; ${label} reaches at most ${plural(max, 'hall', 'halls')}.`;
  if (isFull(state, to)) return `${fullText(state, to)}.`;
  return `Every way from ${hallName(crew.hall)} to ${hallName(to)} within ${plural(max, 'hall', 'halls')} passes through a full hall (capacity ${capacity(state)}).`;
}

function notYet(label) {
  return `${label} is not in this build yet.`;
}

// ---------------------------------------------------------------------------
// The action catalogue. Every family the spec has is here; `implemented`
// false marks the ones task T9 writes (their block reason refuses them and
// getValidActions never offers them).
// ---------------------------------------------------------------------------

function selfieKey(s) {
  return `g${s.green}r${s.red}o${s.orange}`;
}

export const ACTIONS = {
  // ----- main actions (R8.3) -----
  move2: {
    params: ['crew', 'to'],
    rule: 'R10.6',
    implemented: true,
    block: (state, seat, a) => {
      const K = getConstants(state);
      const pre = mainActionBlock(state, seat, 'move2');
      if (pre) return pre;
      const cost = costBlock(state, seat, 'Move 2', K.COSTS.COST_MOVE_2);
      if (cost) return cost;
      const { reason, crew } = ownCrewBlock(state, seat, a.crew);
      if (reason) return reason;
      if (!isHallId(a.to)) return `"${a.to}" is not a hall.`;
      if (a.to === crew.hall) return `That Crew is already in ${hallName(a.to)}; a move must end somewhere else (R10.2).`;
      const max = K.MOVEMENT.MOVE_2_MAX_STEPS;
      if (!movePaths(state, crew, max, seat)[a.to]) return noPathReason(state, crew, a.to, max, 'Move 2');
      return timingBlock(state, seat, 'move2');
    },
    describe: (state, a) => {
      const K = getConstants(state);
      const c = crewById(state, a.crew);
      const best = c ? movePaths(state, c, K.MOVEMENT.MOVE_2_MAX_STEPS, c.owner)[a.to] : null;
      const via = best && best.path.length > 2 ? ` via ${best.path.slice(1, -1).map(hallName).join(', ')}` : '';
      const usher = best && best.ushers > 0 ? `, +${best.ushers * K.MOVEMENT.USHER_COFFEE_PER_CROSSING} coffee from your Ushers` : '';
      return `Move 2: ${c ? crewLabel(state, c, c.owner) : a.crew} to ${hallName(a.to)}${via} (${K.COSTS.COST_MOVE_2} coffee${usher})`;
    },
  },
  move3: {
    params: ['crew', 'to'],
    rule: 'R10.7',
    implemented: true,
    block: (state, seat, a) => {
      const K = getConstants(state);
      const pre = mainActionBlock(state, seat, 'move3');
      if (pre) return pre;
      const cost = costBlock(state, seat, 'Move 1 Crew x3', K.COSTS.COST_MOVE_3_CREW);
      if (cost) return cost;
      const { reason, crew } = ownCrewBlock(state, seat, a.crew);
      if (reason) return reason;
      if (!isHallId(a.to)) return `"${a.to}" is not a hall.`;
      if (!areAdjacent(crew.hall, a.to)) return `Move 1 Crew x3 moves each Crew 1 hall, and ${hallName(a.to)} is not next to ${hallName(crew.hall)}.`;
      if (isFull(state, a.to)) return `${fullText(state, a.to)}.`;
      return timingBlock(state, seat, 'move3');
    },
    describe: (state, a) => {
      const K = getConstants(state);
      const c = crewById(state, a.crew);
      return `Move 1 Crew x3: first ${c ? crewLabel(state, c, c.owner) : a.crew} to ${hallName(a.to)} (${K.COSTS.COST_MOVE_3_CREW} coffee)`;
    },
  },
  newNoob: {
    params: ['hall'],
    rule: 'R11',
    implemented: true,
    block: (state, seat, a) => {
      const K = getConstants(state);
      const pre = mainActionBlock(state, seat, 'newNoob');
      if (pre) return pre;
      const cost = costBlock(state, seat, 'New N00b Crew', K.COSTS.COST_NEW_NOOB);
      if (cost) return cost;
      if (crewInSupply(state, seat).length === 0) return `All ${K.SUPPLY.CREW_PER_PLAYER} of your Crew are on the board (R11.3).`;
      if (!isHallId(a.hall)) return `"${a.hall}" is not a hall.`;
      if (isFull(state, a.hall)) return `${fullText(state, a.hall)}.`;
      if (!newNoobHalls(state).includes(a.hall)) {
        if (hasRoom(state, ENTRANCE)) return 'The Entrance has room, so a new N00b goes there (R11.2).';
        return `A hall next to the Entrance (${ADJACENT[ENTRANCE].map(hallName).join(', ')}) has room, so the new N00b goes to one of those (R11.2).`;
      }
      return timingBlock(state, seat, 'newNoob');
    },
    describe: (state, a) => `New N00b Crew into ${hallName(a.hall)} (${getConstants(state).COSTS.COST_NEW_NOOB} coffee)`,
  },
  upgrade: {
    params: ['crew'],
    rule: 'R12',
    implemented: false,
    block: () => notYet('Upgrade Crew'),
    describe: (state, a) => `Upgrade ${a.crew} (${getConstants(state).COSTS.COST_UPGRADE} coffee)`,
  },
  volunteer: {
    params: ['space'],
    rule: 'R13.1',
    implemented: false,
    block: () => notYet('Volunteer'),
    describe: (state, a) => `Place a Volunteer on ${a.space} (${getConstants(state).COSTS.COST_VOLUNTEER} coffee)`,
  },
  takeSelfie: {
    params: ['celebrity'],
    rule: 'R14',
    implemented: true,
    block: (state, seat, a) => {
      const K = getConstants(state);
      const pre = mainActionBlock(state, seat, 'takeSelfie');
      if (pre) return pre;
      const cost = costBlock(state, seat, 'Take a Selfie', K.COSTS.COST_TAKE_SELFIE);
      if (cost) return cost;
      const entry = scheduleOfCard(state, a.celebrity);
      const card = celebrityCard(a.celebrity);
      if (!card) return `"${a.celebrity}" is not a celebrity.`;
      if (!entry || entry.status !== 'onBoard') return `${card.name} is not on the board.`;
      if (!hasCrewIn(state, seat, entry.figure)) return `You have no Crew in ${hallName(entry.figure)}, where ${card.name} stands (R14.1).`;
      return timingBlock(state, seat, 'takeSelfie');
    },
    describe: (state, a) => {
      const entry = scheduleOfCard(state, a.celebrity);
      const card = celebrityCard(a.celebrity);
      const where = entry && entry.figure ? ` in ${hallName(entry.figure)}` : '';
      return `Take a Selfie with ${card ? card.name : a.celebrity}${where}: +1 ${entry ? entry.colour : ''} Selfie (${getConstants(state).COSTS.COST_TAKE_SELFIE} coffee)`;
    },
  },
  buySwag: {
    params: ['card'],
    rule: 'R16',
    implemented: false,
    block: () => notYet('Swag'),
    describe: (state, a) => `Take the Swag card ${a.card}`,
  },
  clubPower: {
    params: ['option'],
    rule: 'R17',
    implemented: false,
    block: () => notYet('Club Power'),
    describe: (state, a) => `Use your Club power (${a.option})`,
  },
  pass: {
    params: [],
    rule: 'R18',
    implemented: true,
    block: (state, seat) => mainActionBlock(state, seat, 'pass') ?? timingBlock(state, seat, 'pass'),
    describe: (state) => {
      const K = getConstants(state);
      return state.hourState.firstPasser === null
        ? `Pass (first to pass: +${K.PASS.PASS_FIRST_PASSER_COFFEE} coffee)`
        : 'Pass';
    },
  },

  // ----- follow-up of Pass (R18.2.3) -----
  scoreAchievement: {
    params: ['card'],
    rule: 'R18.2.3, R19.4',
    implemented: true,
    block: (state, seat, a) => {
      if (!state.players[seat].hand.includes(a.card)) return 'That Achievement is not in your hand.';
      return timingBlock(state, seat, 'scoreAchievement');
    },
    describe: (state, a) => {
      const seat = state.toAct ?? 0;
      const card = achievementCard(a.card);
      const vp = state.players[seat].hand.includes(a.card) ? achievementValue(state, seat, a.card, 1) : 0;
      return `Score ${card ? card.name : a.card} now: ${vp} VP`;
    },
  },
  discardAchievement: {
    params: ['card'],
    rule: 'R18.2.3',
    implemented: true,
    block: (state, seat, a) => {
      if (!state.players[seat].hand.includes(a.card)) return 'That Achievement is not in your hand.';
      return timingBlock(state, seat, 'discardAchievement');
    },
    describe: (state, a) => {
      const card = achievementCard(a.card);
      return `Discard ${card ? card.name : a.card} for ${getConstants(state).PASS.PASS_DISCARD_COFFEE} coffee`;
    },
  },

  // ----- pass-turn (R18.4) -----
  passReward: {
    params: ['reward'],
    rule: 'R18.4',
    implemented: true,
    block: (state, seat, a) => {
      const K = getConstants(state);
      const p = state.players[seat];
      if (a.reward !== 'coffee' && a.reward !== 'vp') return 'A pass-turn reward is "coffee" or "vp".';
      if (p.passSlot === 0) return 'You have not passed this Hour.';
      if (a.reward === 'coffee' && coffeeGainWasted(state, seat)) {
        return `You are on ${K.LIMITS.COFFEE_CAP} coffee, so the coffee reward would gain nothing (R18.4.1).`;
      }
      return timingBlock(state, seat, 'passReward');
    },
    describe: (state, a) => {
      const K = getConstants(state);
      const seat = state.toAct ?? 0;
      const slot = Math.min(state.players[seat].passSlot + 1, K.PASS.PASS_SLOTS);
      const n = K.PASS.PASS_SLOT_REWARD[slot];
      return a.reward === 'coffee' ? `Take ${n} coffee (pass slot ${slot})` : `Take ${n} VP (pass slot ${slot})`;
    },
  },

  // ----- Move 1 Crew x3, later steps (R10.7) -----
  moveStep: {
    params: ['crew', 'to'],
    rule: 'R10.7',
    implemented: true,
    block: (state, seat, a) => {
      const { reason, crew } = ownCrewBlock(state, seat, a.crew);
      if (reason) return reason;
      const top = topFrame(state);
      const moved = top && top.kind === 'moveSteps' ? top.moved : [];
      if (moved.includes(crew.id)) return 'That Crew has already moved this action; each step is made by a different Crew (R10.7).';
      if (!isHallId(a.to)) return `"${a.to}" is not a hall.`;
      if (!areAdjacent(crew.hall, a.to)) return `Each step moves 1 hall, and ${hallName(a.to)} is not next to ${hallName(crew.hall)}.`;
      if (isFull(state, a.to)) return `${fullText(state, a.to)}.`;
      return timingBlock(state, seat, 'moveStep');
    },
    describe: (state, a) => {
      const c = crewById(state, a.crew);
      const top = topFrame(state);
      const n = top && top.kind === 'moveSteps' ? top.moved.length + 1 : 2;
      const of = top && top.kind === 'moveSteps' ? top.max : 3;
      return `Move ${c ? crewLabel(state, c, c.owner) : a.crew} to ${hallName(a.to)} (Crew ${n} of ${of})`;
    },
  },
  stopMoving: {
    params: [],
    rule: 'R10.7',
    implemented: true,
    stop: true,
    block: (state, seat) => timingBlock(state, seat, 'stopMoving'),
    describe: () => 'Stop moving',
  },

  // ----- free conversions (R15) -----
  exchange: {
    params: ['rate', 'pay', 'gain'],
    nullable: ['gain'],
    rule: 'R15.2',
    implemented: true,
    block: (state, seat, a) => {
      const K = getConstants(state);
      const p = state.players[seat];
      const def = K.EXCHANGE[`EXCHANGE_${a.rate}`];
      if (!['E1', 'E2', 'E3'].includes(a.rate) || !def) return `"${a.rate}" is not an exchange rate (E1, E2 or E3).`;
      if (!isSelfieObject(a.pay)) return 'An exchange must say how many Selfies of each colour it pays, as { green, red, orange }.';
      if (selfieTotal(a.pay) !== def.PAY) return `The ${a.rate} exchange pays exactly ${def.PAY} Selfies; ${selfieTotal(a.pay)} were offered.`;
      if (!canPaySelfies(p.selfies, a.pay)) return `You hold ${formatSelfies(p.selfies)}, and this exchange pays ${formatSelfies(a.pay)}.`;
      if (a.rate === 'E2') {
        if (!COLOURS.includes(a.gain)) return 'Say which colour of Selfie the exchange gains.';
        if (a.pay[a.gain] > 0) return `The Selfie you gain must be a colour different from each Selfie you pay, and you pay ${a.gain} (R15.2).`;
      } else if (a.gain !== null) return `The ${a.rate} exchange gains no Selfie; leave "gain" empty.`;
      if (a.rate === 'E1' && coffeeGainWasted(state, seat)) {
        return `You are on ${K.LIMITS.COFFEE_CAP} coffee, so exchanging for coffee would gain nothing (R15.4).`;
      }
      return timingBlock(state, seat, 'exchange');
    },
    describe: (state, a) => {
      const K = getConstants(state);
      const pay = isSelfieObject(a.pay) ? formatSelfies(a.pay) : '?';
      if (a.rate === 'E1') return `Exchange ${pay} for ${K.EXCHANGE.EXCHANGE_E1.GAIN_COFFEE} coffee`;
      if (a.rate === 'E2') return `Exchange ${pay} for 1 ${a.gain} Selfie`;
      return `Exchange ${pay} for ${K.EXCHANGE.EXCHANGE_E3.GAIN_VP} VP`;
    },
  },
  strikeAPose: {
    params: ['gain'],
    rule: 'R17.6.9',
    implemented: true,
    block: (state, seat, a) => {
      const K = getConstants(state);
      const p = state.players[seat];
      if (p.club !== 'club_09') return "Strike a Pose is the Selfie Stick Squad's power, and that is not your Club.";
      const cost = costBlock(state, seat, 'Strike a Pose', K.CLUBS.CLUBS.club_09.COST);
      if (cost) return cost;
      if (!isSelfieObject(a.gain, K.CLUBS.CLUBS.club_09.SELFIES)) return `Strike a Pose gains exactly ${K.CLUBS.CLUBS.club_09.SELFIES} Selfies, as { green, red, orange }.`;
      return timingBlock(state, seat, 'strikeAPose');
    },
    describe: (state, a) =>
      `Strike a Pose: ${getConstants(state).CLUBS.CLUBS.club_09.COST} coffee for ${isSelfieObject(a.gain) ? formatSelfies(a.gain) : '?'}`,
  },
  rareFinds: {
    params: ['pay', 'gain'],
    rule: 'R17.6.7',
    implemented: true,
    block: (state, seat, a) => {
      const K = getConstants(state);
      const def = K.CLUBS.CLUBS.club_07;
      const p = state.players[seat];
      if (p.club !== 'club_07') return "Rare Finds is the TCG Traders' power, and that is not your Club.";
      if (!COLOURS.includes(a.pay) || !COLOURS.includes(a.gain)) return 'Rare Finds pays one colour and gains another: green, red or orange.';
      if (a.pay === a.gain) return 'Rare Finds gains Selfies of a different colour from the ones you pay.';
      if (p.selfies[a.pay] < def.PAY) return `Rare Finds pays ${def.PAY} ${a.pay} Selfies and you have ${p.selfies[a.pay]}.`;
      const top = topFrame(state);
      if (top && top.player === seat && top.rareFindsUsed) return 'You have used Rare Finds this turn (once per turn, R17.6.7).';
      return timingBlock(state, seat, 'rareFinds');
    },
    describe: (state, a) => {
      const def = getConstants(state).CLUBS.CLUBS.club_07;
      return `Rare Finds: ${def.PAY} ${a.pay} Selfies for ${def.GAIN} ${a.gain}`;
    },
  },
  endConversions: {
    params: [],
    rule: 'R7.1, R22.2',
    implemented: true,
    stop: true,
    block: (state, seat) => timingBlock(state, seat, 'endConversions'),
    describe: (state) => {
      const top = topFrame(state);
      return top && top.kind === 'squadWindow' ? 'Done: on to the Coffee Break' : 'Done: on to final scoring';
    },
  },

  // ----- Swag and Club effect steps (frame `effect`, T9) -----
  effectMove: { params: ['crew', 'to'], rule: 'R16.4.2, R16.4.3', implemented: false, block: () => notYet('That card effect'), describe: (s, a) => `Move ${a.crew} to ${hallName(a.to)}` },
  effectMovePair: { params: ['crew', 'other', 'to'], rule: 'swag_green_09', implemented: false, block: () => notYet('That card effect'), describe: (s, a) => `Move ${a.crew} and ${a.other} together to ${hallName(a.to)}` },
  effectChooseCelebrity: { params: ['celebrity'], rule: 'swag_orange_03, R17.6.3', implemented: false, block: () => notYet('That card effect'), describe: (s, a) => `Choose ${celebrityCard(a.celebrity) ? celebrityCard(a.celebrity).name : a.celebrity}` },
  effectPlaceCrew: { params: ['hall'], rule: 'R16.4.1', implemented: false, block: () => notYet('That card effect'), describe: (s, a) => `Place a Crew in ${hallName(a.hall)}` },
  effectPlaceVolunteer: { params: ['space'], rule: 'R16.4.5', implemented: false, block: () => notYet('That card effect'), describe: (s, a) => `Place a Volunteer on ${a.space}` },
  effectMoveVolunteer: { params: ['from', 'to'], rule: 'R17.6.2', implemented: false, block: () => notYet('That card effect'), describe: (s, a) => `Move your Volunteer from ${a.from} to ${a.to}` },
  effectChooseHall: { params: ['hall'], rule: 'R16.8', implemented: false, block: () => notYet('That card effect'), describe: (s, a) => `Choose ${hallName(a.hall)}` },
  effectChooseCrew: { params: ['crew'], rule: 'R16.8', implemented: false, block: () => notYet('That card effect'), describe: (s, a) => `Choose ${a.crew}` },
  effectSwap: { params: ['crew', 'other'], rule: 'swag_orange_02', implemented: false, block: () => notYet('That card effect'), describe: (s, a) => `Swap ${a.crew} and ${a.other}` },
  effectGainSelfies: { params: ['gain'], rule: 'R16.8, R17.6', implemented: false, block: () => notYet('That card effect'), describe: (s, a) => `Gain ${isSelfieObject(a.gain) ? formatSelfies(a.gain) : '?'}` },
  effectConvertSelfie: { params: ['from', 'to'], rule: 'swag_orange_10', implemented: false, block: () => notYet('That card effect'), describe: (s, a) => `Turn 1 ${a.from} Selfie into ${a.to}` },
  effectChooseAchievement: { params: ['card'], rule: 'R16.8, R17.6.5', implemented: false, block: () => notYet('That card effect'), describe: (s, a) => `Choose ${achievementCard(a.card) ? achievementCard(a.card).name : a.card}` },
  effectDone: { params: [], rule: 'R8.8', implemented: false, stop: true, block: () => notYet('That card effect'), describe: () => 'Done' },

  // ----- variant-only decisions (T9) -----
  placeOpeningCrew: { params: ['hall'], rule: 'R5.9.1 fallback', implemented: false, block: () => notYet('The fallback opening'), describe: (s, a) => `Place an opening Crew in ${hallName(a.hall)}` },
  discardSelfie: { params: ['colour'], rule: 'R17.7 on', implemented: false, block: () => notYet('Club hand limits'), describe: (s, a) => `Discard 1 ${a.colour} Selfie` },
  keepAchievement: { params: ['card'], rule: 'swag_orange_07 draw-two-keep-one', implemented: false, block: () => notYet('Achiever (draw two, keep one)'), describe: (s, a) => `Keep ${achievementCard(a.card) ? achievementCard(a.card).name : a.card}` },
};

/** Action types the decision `stop`s, done or skip ("there was nothing to do here" when automatic). */
export const STOP_ACTION_TYPES = Object.freeze(Object.keys(ACTIONS).filter((t) => ACTIONS[t].stop === true));

// ---------------------------------------------------------------------------
// Candidates
// ---------------------------------------------------------------------------

/** Every { green, red, orange } with this total, in a fixed order. */
function compositions(total) {
  const out = [];
  for (let g = total; g >= 0; g--) {
    for (let r = total - g; r >= 0; r--) out.push({ green: g, red: r, orange: total - g - r });
  }
  return out;
}

function conversionCandidates(state, seat, kinds) {
  const K = getConstants(state);
  const p = state.players[seat];
  const out = [];
  if (kinds.includes('exchange') && selfieTotal(p.selfies) >= K.EXCHANGE.EXCHANGE_E1.PAY) {
    const pay2 = compositions(K.EXCHANGE.EXCHANGE_E1.PAY).filter((x) => canPaySelfies(p.selfies, x));
    for (const pay of pay2) out.push({ type: 'exchange', rate: 'E1', pay, gain: null });
    for (const pay of compositions(K.EXCHANGE.EXCHANGE_E2.PAY).filter((x) => canPaySelfies(p.selfies, x))) {
      for (const c of COLOURS) if (pay[c] === 0) out.push({ type: 'exchange', rate: 'E2', pay, gain: c });
    }
    for (const pay of compositions(K.EXCHANGE.EXCHANGE_E3.PAY).filter((x) => canPaySelfies(p.selfies, x))) {
      out.push({ type: 'exchange', rate: 'E3', pay, gain: null });
    }
  }
  if (kinds.includes('strikeAPose') && p.club === 'club_09') {
    for (const gain of compositions(K.CLUBS.CLUBS.club_09.SELFIES)) out.push({ type: 'strikeAPose', gain });
  }
  if (kinds.includes('rareFinds') && p.club === 'club_07') {
    for (const pay of COLOURS) for (const gain of COLOURS) if (pay !== gain) out.push({ type: 'rareFinds', pay, gain });
  }
  return out;
}

function mainCandidates(state, seat) {
  const K = getConstants(state);
  const out = [];
  for (const c of crewOnBoard(state, seat)) {
    for (const to of Object.keys(movePaths(state, c, K.MOVEMENT.MOVE_2_MAX_STEPS, seat))) out.push({ type: 'move2', crew: c.id, to });
  }
  for (const c of crewOnBoard(state, seat)) {
    for (const to of ADJACENT[c.hall]) out.push({ type: 'move3', crew: c.id, to });
  }
  for (const hall of newNoobHalls(state)) out.push({ type: 'newNoob', hall });
  for (const s of selfieTargets(state, seat)) out.push({ type: 'takeSelfie', celebrity: s.card });
  out.push({ type: 'pass' });
  return out;
}

function keepLegal(state, seat, candidates) {
  const out = [];
  for (const a of candidates) if (ACTIONS[a.type].block(state, seat, a) === null) out.push(a);
  return out;
}

// ---------------------------------------------------------------------------
// The decision table: one entry per kind of frame on state.stack.
//   label(state, frame) - what the player is asked, reading after "you must ..."
//   list(state, frame)  - the COMPLETE list of legal actions (each passed by its block reason)
// ---------------------------------------------------------------------------

export const FRAMES = {
  /** R8.1, R15.5 window 1. Frame: { kind, player, conversions, rareFindsUsed }. */
  turn: {
    label: () => 'take your turn (free conversions, then one main action)',
    list: (state, f) => keepLegal(state, f.player, [...conversionCandidates(state, f.player, CONVERSION_TYPES), ...mainCandidates(state, f.player)]),
  },
  /** R18.4, R15.5 window 1. Frame: { kind, player, conversions, rareFindsUsed }. */
  passTurn: {
    label: (state, f) => {
      const K = getConstants(state);
      const slot = Math.min(state.players[f.player].passSlot + 1, K.PASS.PASS_SLOTS);
      return `take your pass reward (slot ${slot}: ${K.PASS.PASS_SLOT_REWARD[slot]} coffee or VP)`;
    },
    list: (state, f) =>
      keepLegal(state, f.player, [
        ...conversionCandidates(state, f.player, CONVERSION_TYPES),
        { type: 'passReward', reward: 'coffee' },
        { type: 'passReward', reward: 'vp' },
      ]),
  },
  /** R7.1, R15.5 window 2. Frame: { kind, player, conversions }. */
  squadWindow: {
    label: () => 'use Strike a Pose before the Coffee Break, or finish',
    list: (state, f) => keepLegal(state, f.player, [...conversionCandidates(state, f.player, ['strikeAPose']), { type: 'endConversions' }]),
  },
  /** R22.2, R15.5 window 3. Frame: { kind, player, conversions }. */
  finalWindow: {
    label: () => 'make any last conversions before final scoring, then finish',
    list: (state, f) =>
      keepLegal(state, f.player, [...conversionCandidates(state, f.player, ['exchange', 'strikeAPose']), { type: 'endConversions' }]),
  },
  /** R18.2.3. Frame: { kind, player }. */
  passAchievement: {
    label: () => 'score one Achievement, or discard it for coffee',
    list: (state, f) => {
      const hand = state.players[f.player].hand;
      return keepLegal(state, f.player, [
        ...hand.map((card) => ({ type: 'scoreAchievement', card })),
        ...hand.map((card) => ({ type: 'discardAchievement', card })),
      ]);
    },
  },
  /** R10.7. Frame: { kind, player, moved: [crew ids], max, source: 'move3' | swag card id }. */
  moveSteps: {
    label: (state, f) => `move another Crew 1 hall (${f.moved.length} of ${f.max} moved), or stop`,
    list: (state, f) => {
      const cands = [];
      for (const c of crewOnBoard(state, f.player)) {
        if (f.moved.includes(c.id)) continue;
        for (const to of ADJACENT[c.hall]) cands.push({ type: 'moveStep', crew: c.id, to });
      }
      cands.push({ type: 'stopMoving' });
      return keepLegal(state, f.player, cands);
    },
  },
  /** T9: Swag and Club follow-up steps. Frame: { kind, player, source: { kind: 'swag'|'club', card }, step, data }. */
  effect: { label: () => 'finish the card effect', list: () => [] },
  /** T9: fivePlayerOpening = fallback. Frame: { kind, player, remaining }. */
  openingPlacement: { label: () => 'place an opening Crew', list: () => [] },
  /** T9: clubHandLimits = on. Frame: { kind, player, limit }. */
  discardToLimit: { label: () => 'discard Selfies down to your Club limit', list: () => [] },
  /** T9: achiever = draw-two-keep-one. Frame: { kind, player, cards }. */
  achieverKeep: { label: () => 'keep one of the two Achievements drawn', list: () => [] },
};

/** What the pending decision asks, as a verb phrase. */
export function frameLabel(state, frame) {
  const def = FRAMES[frame.kind];
  return def ? def.label(state, frame) : frame.kind;
}

// ---------------------------------------------------------------------------
// The public functions
// ---------------------------------------------------------------------------

/**
 * LAYER 1. The complete list of legal next actions, all for `state.toAct`.
 * Empty only when the game is over. On a state that came from createGame or
 * applyAction the list never has exactly one entry: a forced action is
 * applied by the engine itself (R23.5). Returns fresh objects.
 */
export function getValidActions(state) {
  if (state.phase === 'ended') return [];
  const frame = topFrame(state);
  if (frame === null) return [];
  return FRAMES[frame.kind].list(state, frame);
}

/**
 * LAYER 2. Why `action` cannot be taken now: a sentence for the player, or
 * null when it is legal. Asked for `action.player` if given, else state.toAct.
 */
export function getBlockReason(state, action) {
  if (action === null || typeof action !== 'object' || typeof action.type !== 'string') {
    return 'An action must be an object with a `type`.';
  }
  const def = ACTIONS[action.type];
  if (!def) return `"${action.type}" is not an action of this game.`;
  for (const param of def.params) {
    const nullable = def.nullable && def.nullable.includes(param);
    if (action[param] === undefined || (!nullable && action[param] === null)) return `The action "${action.type}" needs \`${param}\`.`;
  }
  let seat = action.player;
  if (seat === undefined || seat === null) {
    if (state.toAct === null) return 'The game is over.';
    seat = state.toAct;
  } else if (!Number.isInteger(seat) || seat < 0 || seat >= state.players.length) {
    return `There is no player ${JSON.stringify(seat)} in this game.`;
  }
  return def.block(state, seat, action);
}

/**
 * As getBlockReason, leaving aside whose decision it is and which decision is
 * pending: "if it were my move of the right kind, could I?". For tooltips
 * shown ahead of time and for planning bots.
 */
export function getStructuralBlockReason(state, action) {
  timingSuspended = true;
  try {
    return getBlockReason(state, action);
  } finally {
    timingSuspended = false;
  }
}

/** A canonical text key: equal actions give equal keys. For maps, logs and search trees. */
export function actionKey(action) {
  const def = ACTIONS[action.type];
  if (!def || def.params.length === 0) return action.type;
  let key = action.type;
  for (const param of def.params) {
    const v = action[param];
    key += `:${v !== null && typeof v === 'object' ? selfieKey(v) : v}`;
  }
  return key;
}

/** A short imperative phrase for an action, for buttons and logs (British English). */
export function describeAction(state, action) {
  const def = action && ACTIONS[action.type];
  if (!def) return String(action && action.type);
  try {
    return def.describe(state, action);
  } catch {
    return action.type;
  }
}

/** What is being asked, and of whom: `{ player, kind, prompt }`, or null when the game is over. */
export function describeDecision(state) {
  const frame = topFrame(state);
  if (state.phase === 'ended' || frame === null) return null;
  return { player: frame.player, kind: frame.kind, prompt: `${nameOf(state, frame.player)}: ${frameLabel(state, frame)}` };
}

/**
 * The action families, for the contract and for tests: type -> { params, rule,
 * implemented, frames } where `frames` are the frame kinds that accept it.
 */
export function actionFamilies() {
  const out = {};
  for (const type of Object.keys(ACTIONS)) {
    const d = ACTIONS[type];
    out[type] = {
      params: d.params.slice(),
      rule: d.rule,
      implemented: d.implemented,
      frames: Object.keys(FRAME_ACCEPTS).filter((k) => FRAME_ACCEPTS[k].includes(type)),
    };
  }
  return out;
}

/** The club card data of a seat, or null. */
export function clubOf(state, seat) {
  const id = state.players[seat].club;
  return id ? clubCard(id) : null;
}
