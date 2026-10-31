// actions.js - everything that changes the game state.
//
//   applyAction(state, action)  the ONE way a player's decision reaches the state
//   MUTATORS                    one function per action type
//   the flow                    what happens between decisions (R6, R7, R8, R20, R22)
//   advance                     runs the flow and applies forced actions
//
// VALIDATE EVERYTHING, THEN APPLY. applyAction asks getBlockReason first and
// throws if the action is refused; only then does a mutator run. Mutators do
// not validate and must not throw: a mutator that throws half-way leaves a
// state no undo can repair. Costs are paid first (R8.5).
//
// The model in one paragraph (engine-contract.md has the long form):
// `state.stack` holds the pending decisions, the last one being asked now.
// A player's action answers it. Whenever the stack is empty the flow does the
// next automatic thing or pushes the next decision. Whenever the decision on
// top has exactly one legal action, the engine applies it itself (R23.5). The
// loop stops when a real choice is waiting, or the game is over.

import { getConstants, topFrame, pushFrame, popFrame } from './state.js';
import { openEventSink, closeEventSink, setEventSeq, eventsOn, emit, EVENTS } from './events.js';
import { COLOURS } from './board.js';
import {
  crewById,
  crewInSupply,
  movePaths,
  hasAnyStep,
  scheduleOfCard,
  scheduleSlot,
  slotsOfHour,
  hourIncome,
  seatsFrom,
  nextSeat,
  allPassed,
  primeOwner,
  photographerOwner,
  celebrityCard,
  selfieTotal,
  swagCard,
} from './queries.js';
import { ACTIONS, FRAMES, getBlockReason, describeAction, windowOf } from './legality.js';
import { addVp, scoreAchievement, scoreDestination, applyFinalScoring, scoreGame } from './scoring.js';
import {
  spendCoffee,
  gainCoffee,
  gainSelfies,
  spendSelfies,
  oneSelfie,
  placeCrew,
  moveCrewAlong,
  drawAchievement,
  upgradeCrew,
  placeVolunteer,
  refillSwagMarket,
} from './primitives.js';
import { startEffect, applyEffectStep, clubCost } from './cardeffects.js';

// The primitives live in primitives.js; they are re-exported here for callers that always imported them from actions.js.
export { spendCoffee, gainCoffee, gainSelfies, spendSelfies, placeCrew, moveCrewAlong, drawAchievement };

/** Safety limits of the engine itself. Not rules of the game. */
export const ENGINE_LIMITS = Object.freeze({
  /** Most automatic steps `advance` may take after one action before it reports an engine bug. */
  maxAutoSteps: 100000,
});

/** R8.9 - counts one main action (Pass excluded) and flags the safety stop when it is reached. */
function countMainAction(state, seat) {
  const K = getConstants(state);
  const p = state.players[seat];
  p.mainActionsThisHour += 1;
  const cap = K.SAFETY.MAX_MAIN_ACTIONS_PER_PLAYER_PER_HOUR;
  if (p.mainActionsThisHour === cap) {
    state.flags.turnCapped = true;
    emit({ type: EVENTS.SAFETY_STOP, kind: 'main-actions', player: seat, limit: cap });
  }
}

/** Counts one free conversion in the window `frame`, and flags the window's safety stop. */
function countConversion(state, frame) {
  const K = getConstants(state);
  frame.conversions += 1;
  if (frame.conversions === K.SAFETY.MAX_CONVERSIONS_PER_WINDOW) {
    emit({ type: EVENTS.SAFETY_STOP, kind: 'conversions', player: frame.player, limit: frame.conversions });
  }
}

/** R18.2.4 - after the Achievement step of a first pass: draw, unless this is Hour 5. */
function drawAfterPass(state, seat) {
  const K = getConstants(state);
  if (state.hour >= K.GAME.HOURS) return;
  for (let i = 0; i < K.PASS.PASS_DRAW_ACHIEVEMENTS; i++) drawAchievement(state, seat, 'pass');
}

// ---------------------------------------------------------------------------
// The mutators: (state, frame, action). `frame` is the decision answered.
// A main action pops the `turn` frame first; follow-up decisions are pushed
// after it, so the turn ends when the stack is empty again.
// ---------------------------------------------------------------------------

export const MUTATORS = {
  move2(state, frame, a) {
    const K = getConstants(state);
    popFrame(state);
    countMainAction(state, frame.player);
    spendCoffee(state, frame.player, K.COSTS.COST_MOVE_2, 'move2');
    const crew = crewById(state, a.crew);
    const best = movePaths(state, crew, K.MOVEMENT.MOVE_2_MAX_STEPS, frame.player)[a.to];
    moveCrewAlong(state, crew, best.path, frame.player, 'move2');
  },
  move3(state, frame, a) {
    const K = getConstants(state);
    popFrame(state);
    countMainAction(state, frame.player);
    spendCoffee(state, frame.player, K.COSTS.COST_MOVE_3_CREW, 'move3');
    const crew = crewById(state, a.crew);
    moveCrewAlong(state, crew, [crew.hall, a.to], frame.player, 'move3');
    const max = K.MOVEMENT.MOVE_3_MAX_CREW;
    const moved = [crew.id];
    if (moved.length < max && hasAnyStep(state, frame.player, moved)) {
      pushFrame(state, { kind: 'moveSteps', player: frame.player, moved, max, source: 'move3' });
    }
  },
  moveStep(state, frame, a) {
    const crew = crewById(state, a.crew);
    moveCrewAlong(state, crew, [crew.hall, a.to], frame.player, frame.source);
    frame.moved.push(crew.id);
    if (frame.moved.length >= frame.max || !hasAnyStep(state, frame.player, frame.moved)) popFrame(state);
  },
  stopMoving(state) {
    popFrame(state);
  },
  newNoob(state, frame, a) {
    const K = getConstants(state);
    popFrame(state);
    countMainAction(state, frame.player);
    spendCoffee(state, frame.player, K.COSTS.COST_NEW_NOOB, 'newNoob');
    placeCrew(state, crewInSupply(state, frame.player)[0], a.hall, 'newNoob');
  },
  upgrade(state, frame, a) {
    // R12.1-R12.2: pay 5, raise the badge one step, new arrival stamp.
    const K = getConstants(state);
    popFrame(state);
    countMainAction(state, frame.player);
    spendCoffee(state, frame.player, K.COSTS.COST_UPGRADE, 'upgrade');
    upgradeCrew(state, crewById(state, a.crew), 'upgrade');
  },
  volunteer(state, frame, a) {
    // R13.1: pay 2, place one Volunteer on an empty space.
    const K = getConstants(state);
    popFrame(state);
    countMainAction(state, frame.player);
    spendCoffee(state, frame.player, K.COSTS.COST_VOLUNTEER, 'volunteer');
    placeVolunteer(state, frame.player, a.space, 'volunteer');
  },
  buySwag(state, frame, a) {
    // R16.1-R16.5: pay the card's selfies (its own colour), take it, replace it, resolve it.
    const K = getConstants(state);
    const seat = frame.player;
    popFrame(state);
    countMainAction(state, seat);
    const card = swagCard(a.card);
    const cost = K.SWAG.SWAG_COST[a.card];
    const slot = state.swag.market.indexOf(a.card);
    spendSelfies(state, seat, oneSelfie(card.colour, cost), 'swag');
    emit({ type: EVENTS.SWAG_BOUGHT, player: seat, card: a.card, colour: card.colour, cost, slot });
    state.swag.market[slot] = null;
    state.swag.discard.push(a.card);
    refillSwagMarket(state, slot); // R16.5: the card just used is in the discard pile before any reshuffle
    startEffect(state, seat, { kind: 'swag', card: a.card });
  },
  clubPower(state, frame, a) {
    // R17.2, R17.5: pay the Club's coffee, mark it used this Hour, resolve it.
    const seat = frame.player;
    const p = state.players[seat];
    popFrame(state);
    countMainAction(state, seat);
    const price = clubCost(state, p.club, a.option);
    spendCoffee(state, seat, price, 'clubPower');
    p.clubUsedThisHour = true;
    emit({ type: EVENTS.CLUB_USED, player: seat, club: p.club, option: a.option, coffee: price });
    startEffect(state, seat, { kind: 'club', card: p.club }, { option: a.option });
  },
  takeSelfie(state, frame, a) {
    const K = getConstants(state);
    popFrame(state);
    countMainAction(state, frame.player);
    spendCoffee(state, frame.player, K.COSTS.COST_TAKE_SELFIE, 'takeSelfie');
    const entry = scheduleOfCard(state, a.celebrity);
    gainSelfies(state, frame.player, oneSelfie(entry.colour, K.COSTS.SELFIE_GAIN_TAKE_SELFIE), 'take-selfie', {
      celebrity: entry.card,
      hall: entry.figure,
    });
  },
  pass(state, frame) {
    // R18.2 steps 1-4.
    const K = getConstants(state);
    const seat = frame.player;
    const p = state.players[seat];
    popFrame(state);
    p.passSlot = 1;
    const first = state.hourState.firstPasser === null;
    state.hourState.passOrder.push(seat);
    emit({ type: EVENTS.PASSED, player: seat, hour: state.hour, order: state.hourState.passOrder.length, first });
    if (first) {
      state.hourState.firstPasser = seat;
      gainCoffee(state, seat, K.PASS.PASS_FIRST_PASSER_COFFEE, 'first-pass');
    }
    if (p.hand.length > 0) pushFrame(state, { kind: 'passAchievement', player: seat });
    else drawAfterPass(state, seat);
  },
  scoreAchievement(state, frame, a) {
    popFrame(state);
    scoreAchievement(state, frame.player, a.card, getConstants(state).ACHIEVEMENTS.ACHIEVEMENT_OTHER_MULTIPLIER, 'pass');
    drawAfterPass(state, frame.player);
  },
  discardAchievement(state, frame, a) {
    const K = getConstants(state);
    const p = state.players[frame.player];
    popFrame(state);
    p.hand.splice(p.hand.indexOf(a.card), 1);
    state.achievements.discard.push({ card: a.card, owner: frame.player, scored: false });
    emit({ type: EVENTS.ACHIEVEMENT_DISCARDED, player: frame.player, card: a.card, cause: 'pass', secret: true });
    gainCoffee(state, frame.player, K.PASS.PASS_DISCARD_COFFEE, 'achievement-discard');
    drawAfterPass(state, frame.player);
  },
  passReward(state, frame, a) {
    // R18.4 - move the marker one slot (slot 4 repeats), then take coffee or VP.
    const K = getConstants(state);
    const p = state.players[frame.player];
    popFrame(state);
    p.passSlot = Math.min(p.passSlot + 1, K.PASS.PASS_SLOTS);
    const amount = K.PASS.PASS_SLOT_REWARD[p.passSlot];
    emit({ type: EVENTS.PASS_REWARD, player: frame.player, slot: p.passSlot, reward: a.reward, amount });
    if (a.reward === 'coffee') gainCoffee(state, frame.player, amount, 'pass-slot', { detail: { slot: p.passSlot } });
    else addVp(state, frame.player, amount, 'pass-slot', { slot: p.passSlot, hour: state.hour });
  },
  exchange(state, frame, a) {
    const K = getConstants(state);
    countConversion(state, frame);
    spendSelfies(state, frame.player, a.pay, 'exchange');
    const window = windowOf(frame);
    let gain = null;
    if (a.rate === 'E1') {
      gain = { coffee: gainCoffee(state, frame.player, K.EXCHANGE.EXCHANGE_E1.GAIN_COFFEE, 'exchange') };
    } else if (a.rate === 'E2') {
      gain = oneSelfie(a.gain, K.EXCHANGE.EXCHANGE_E2.GAIN_SELFIES);
      gainSelfies(state, frame.player, gain, 'exchange');
    } else {
      gain = { vp: K.EXCHANGE.EXCHANGE_E3.GAIN_VP };
      addVp(state, frame.player, K.EXCHANGE.EXCHANGE_E3.GAIN_VP, 'exchange', { window });
    }
    emit({ type: EVENTS.CONVERSION, player: frame.player, kind: a.rate, window, pay: { ...a.pay }, gain });
  },
  strikeAPose(state, frame, a) {
    const K = getConstants(state);
    countConversion(state, frame);
    spendCoffee(state, frame.player, K.CLUBS.CLUBS.club_09.COST, 'strikeAPose');
    gainSelfies(state, frame.player, a.gain, 'strike-a-pose');
    emit({ type: EVENTS.CONVERSION, player: frame.player, kind: 'strike-a-pose', window: windowOf(frame), pay: { coffee: K.CLUBS.CLUBS.club_09.COST }, gain: { ...a.gain } });
  },
  rareFinds(state, frame, a) {
    const K = getConstants(state);
    const def = K.CLUBS.CLUBS.club_07;
    countConversion(state, frame);
    frame.rareFindsUsed = true;
    const pay = oneSelfie(a.pay, def.PAY);
    const gain = oneSelfie(a.gain, def.GAIN);
    spendSelfies(state, frame.player, pay, 'rare-finds');
    gainSelfies(state, frame.player, gain, 'rare-finds');
    emit({ type: EVENTS.CONVERSION, player: frame.player, kind: 'rare-finds', window: windowOf(frame), pay, gain });
  },
  endConversions(state) {
    popFrame(state);
  },
  // ----- card effect steps (cardeffects.js runs the card's own rule) -----
  effectMove: (state, frame, a) => applyEffectStep(state, frame, a),
  effectMovePair: (state, frame, a) => applyEffectStep(state, frame, a),
  effectChooseCelebrity: (state, frame, a) => applyEffectStep(state, frame, a),
  effectPlaceCrew: (state, frame, a) => applyEffectStep(state, frame, a),
  effectPlaceVolunteer: (state, frame, a) => applyEffectStep(state, frame, a),
  effectMoveVolunteer: (state, frame, a) => applyEffectStep(state, frame, a),
  effectChooseHall: (state, frame, a) => applyEffectStep(state, frame, a),
  effectChooseCrew: (state, frame, a) => applyEffectStep(state, frame, a),
  effectSwap: (state, frame, a) => applyEffectStep(state, frame, a),
  effectGainSelfies: (state, frame, a) => applyEffectStep(state, frame, a),
  effectConvertSelfie: (state, frame, a) => applyEffectStep(state, frame, a),
  effectChooseAchievement: (state, frame, a) => applyEffectStep(state, frame, a),
  effectDone: (state, frame, a) => applyEffectStep(state, frame, a),
  // ----- variant-only decisions -----
  placeOpeningCrew(state, frame, a) {
    // R5.9.1 fallback: the owner places the overflow Crew as a New N00b would be (R11.2).
    popFrame(state);
    placeCrew(state, crewInSupply(state, frame.player)[0], a.hall, 'opening');
  },
  discardSelfie(state, frame, a) {
    // R17.7 on: one Selfie at a time until the player is at the limit.
    spendSelfies(state, frame.player, oneSelfie(a.colour), 'club-limit');
    if (selfieTotal(state.players[frame.player].selfies) <= frame.limit) popFrame(state);
  },
  keepAchievement(state, frame, a) {
    // R16.8 draw-two-keep-one: keep one of the two drawn; the other is discarded unscored and secret (R19.7).
    popFrame(state);
    state.players[frame.player].hand.push(a.card);
    const other = frame.cards.find((c) => c !== a.card);
    if (other !== undefined) {
      state.achievements.discard.push({ card: other, owner: frame.player, scored: false });
      emit({ type: EVENTS.ACHIEVEMENT_DISCARDED, player: frame.player, card: other, cause: 'swag', secret: true });
    }
  },
};

// ---------------------------------------------------------------------------
// The Celebrity Walk (R20) - no decisions, resolved in one go.
// ---------------------------------------------------------------------------

/** R20.3 - a celebrity enters a hall: Prime Position, then Photographer. R4.3.4: the selfies are of the celebrity's own colour only. */
function enterHall(state, entry, hall) {
  const K = getConstants(state);
  const prime = primeOwner(state, hall);
  if (prime !== null) {
    gainSelfies(state, prime, oneSelfie(entry.colour, K.WALK.WALK_SELFIES_PRIME_POSITION), 'walk-prime', { celebrity: entry.card, hall });
  }
  const photographer = photographerOwner(state, hall);
  if (photographer !== null) {
    gainSelfies(state, photographer, oneSelfie(entry.colour, K.WALK.WALK_SELFIES_PHOTOGRAPHER), 'walk-photographer', { celebrity: entry.card, hall });
  }
}

/**
 * R20.2-R20.6 - walk this Hour's celebrity (or both in Hour 5, interleaved, 5a first) and score.
 * R20.1: the Walk needs no decisions. R20.7: nothing in it ever changes a queue (selfies and VP only).
 */
function resolveWalk(state) {
  const walkers = slotsOfHour(state, state.hour).filter((s) => s.status === 'onBoard');
  const progress = walkers.map((entry) => ({ entry, route: celebrityCard(entry.card).route, index: 0 }));
  while (progress.some((w) => w.index < w.route.length - 1)) {
    for (const w of progress) {
      if (w.index >= w.route.length - 1) continue; // R20.6: an arrived celebrity stops
      w.index += 1;
      const hall = w.route[w.index];
      w.entry.figure = hall;
      emit({ type: EVENTS.CELEBRITY_ENTERED, celebrity: w.entry.card, slot: w.entry.slot, colour: w.entry.colour, hall, step: w.index, of: w.route.length - 1 });
      enterHall(state, w.entry, hall);
    }
  }
  for (const w of progress) scoreDestination(state, w.entry); // R20.4, R20.6 (5a first)
}

function removeFigure(state, entry) {
  entry.status = 'done';
  entry.figure = null;
  entry.marker = null;
  emit({ type: EVENTS.CELEBRITY_REMOVED, celebrity: entry.card, slot: entry.slot });
}

/** R20.5 - Hours 1-4: clear this Hour's figure and place the next scheduled celebrity in its colour. */
function clearUp(state) {
  const K = getConstants(state);
  for (const entry of slotsOfHour(state, state.hour)) removeFigure(state, entry);
  const nextSlot = K.SCHEDULE.PLACED_AFTER_HOUR[state.hour];
  if (nextSlot) {
    const next = scheduleSlot(state, nextSlot);
    const card = celebrityCard(next.card);
    next.status = 'onBoard';
    next.figure = card.start;
    next.marker = card.destination;
    emit({ type: EVENTS.CELEBRITY_PLACED, celebrity: next.card, slot: next.slot, colour: next.colour, figure: next.figure, marker: next.marker });
  }
}

// ---------------------------------------------------------------------------
// The flow: what happens when no decision is pending.
// ---------------------------------------------------------------------------

/** R6.4 - the per-Hour state is fresh at the start of every Hour. */
function startHour(state) {
  for (const p of state.players) {
    p.passSlot = 0;
    p.mainActionsThisHour = 0;
    p.clubUsedThisHour = false;
  }
  state.hourState = { firstPasser: null, passOrder: [] };
}

function newWindowFrame(kind, player) {
  return { kind, player, conversions: 0, rareFindsUsed: false };
}

/** R27.18 - the engine's own guard: end the game where it stands. */
function stopAtEngineCap(state) {
  const K = getConstants(state);
  state.flags.turnCapped = true;
  state.flags.endReason = 'engine-action-cap';
  emit({ type: EVENTS.SAFETY_STOP, kind: 'engine-actions', player: null, limit: K.SAFETY.MAX_ENGINE_ACTIONS_PER_GAME });
  state.phase = 'final';
  state.step = 'score';
}

/** R17.7 - the printed selfie limit of a seat's Club (applied only under clubHandLimits = on), or null. */
function selfieLimit(state, seat) {
  const K = getConstants(state);
  const club = state.players[seat].club;
  if (club === 'club_06') return K.LIMITS.CLUB_HAND_LIMIT_MILITIA;
  if (club === 'club_07') return K.LIMITS.CLUB_HAND_LIMIT_TCG;
  return null;
}

// R1.2, R6.1: an Hour is Coffee Break, On the Floor, Celebrity Walk, in that order; R5.10 Hour 1 begins with its Coffee Break
// (setup ends in phase `coffeeBreak`, step `start`).
function runFlow(state) {
  const K = getConstants(state);
  const n = state.players.length;
  switch (state.phase) {
    case 'setup': {
      // R5.9.1 fallback: each overflow opening Crew is placed by its owner, in opening order.
      if (state.openingQueue.length > 0) {
        const seat = state.openingQueue.shift();
        pushFrame(state, { kind: 'openingPlacement', player: seat, remaining: state.openingQueue.length + 1 });
        return;
      }
      state.phase = 'coffeeBreak';
      state.step = 'start';
      return;
    }
    case 'coffeeBreak': {
      if (state.step === 'start') {
        startHour(state);
        emit({ type: EVENTS.HOUR_START, hour: state.hour, firstPlayer: state.firstPlayer, celebrities: slotsOfHour(state, state.hour).map((s) => s.slot) });
        emit({ type: EVENTS.PHASE_START, hour: state.hour, phase: 'coffeeBreak' });
        state.step = 'squad';
        state.stepIndex = 0;
        return;
      }
      if (state.step === 'squad') {
        // R7.1 - Selfie Stick Squad owners, in turn order from this Hour's first player.
        const order = seatsFrom(state, state.firstPlayer);
        while (state.stepIndex < n) {
          const seat = order[state.stepIndex++];
          if (state.players[seat].club === 'club_09') {
            pushFrame(state, newWindowFrame('squadWindow', seat));
            return;
          }
        }
        state.step = 'income';
        return;
      }
      // R7.2, R7.3, R7.3.1 - income, logged even when it gains nothing.
      const amount = hourIncome(state, state.hour);
      for (const seat of seatsFrom(state, state.firstPlayer)) gainCoffee(state, seat, amount, 'coffee-break', { coffeeBreak: true });
      state.phase = 'floor';
      state.step = 'turnStart';
      state.turn = { number: 1, player: state.firstPlayer, kind: null };
      emit({ type: EVENTS.PHASE_START, hour: state.hour, phase: 'floor' });
      return;
    }
    case 'floor': {
      if (state.step === 'turnStart') {
        // R8.1 - a normal turn, or a pass-turn for a player who has passed.
        const seat = state.turn.player;
        const kind = state.players[seat].passSlot > 0 ? 'pass' : 'normal';
        state.turn.kind = kind;
        emit({ type: EVENTS.TURN_START, hour: state.hour, player: seat, turn: state.turn.number, kind });
        pushFrame(state, newWindowFrame(kind === 'pass' ? 'passTurn' : 'turn', seat));
        state.step = 'turnEnd';
        return;
      }
      // 'turnEnd': the turn's decisions are all resolved.
      // R17.7, variant clubHandLimits = on: a Meeple Militia / TCG Traders owner discards down to the printed limit
      // at the end of their own turn. The frame ends at the limit, so this check passes next time round.
      if (state.variants.clubHandLimits === 'on') {
        const seat = state.turn.player;
        const limit = selfieLimit(state, seat);
        if (limit !== null && selfieTotal(state.players[seat].selfies) > limit) {
          pushFrame(state, { kind: 'discardToLimit', player: seat, limit });
          return;
        }
      }
      if (state.seq >= K.SAFETY.MAX_ENGINE_ACTIONS_PER_GAME) {
        stopAtEngineCap(state);
        return;
      }
      if (allPassed(state)) {
        // R8.2, R18.5
        state.phase = 'walk';
        state.step = 'start';
        state.turn = { number: state.turn.number, player: null, kind: null };
        return;
      }
      state.turn = { number: state.turn.number + 1, player: nextSeat(state, state.turn.player), kind: null };
      state.step = 'turnStart';
      return;
    }
    case 'walk': {
      emit({ type: EVENTS.PHASE_START, hour: state.hour, phase: 'walk' });
      resolveWalk(state);
      if (state.hour < K.GAME.HOURS) {
        clearUp(state);
        const from = state.firstPlayer;
        state.firstPlayer = nextSeat(state, from); // R6.3
        emit({ type: EVENTS.FIRST_PLAYER_MOVED, from, to: state.firstPlayer });
        state.hour += 1;
        state.phase = 'coffeeBreak';
        state.step = 'start';
      } else {
        state.phase = 'final'; // R6.5; the marker does not pass after Hour 5 (R6.3)
        state.step = 'start';
      }
      return;
    }
    case 'final': {
      if (state.step === 'start') {
        emit({ type: EVENTS.PHASE_START, hour: state.hour, phase: 'final' });
        if (state.variants.finalBoard === 'figures-removed') {
          for (const entry of slotsOfHour(state, state.hour)) if (entry.status === 'onBoard') removeFigure(state, entry);
        }
        state.step = 'window';
        state.stepIndex = 0;
        return;
      }
      if (state.step === 'window') {
        // R22.2 - each player's final conversion window, in turn order from the Hour 5 first player.
        if (state.stepIndex < n) {
          const seat = seatsFrom(state, state.firstPlayer)[state.stepIndex++];
          pushFrame(state, newWindowFrame('finalWindow', seat));
          return;
        }
        state.step = 'score';
        return;
      }
      // 'score' - R22.3, R22.4, then the end.
      applyFinalScoring(state);
      if (state.flags.endReason === null) state.flags.endReason = 'complete';
      state.phase = 'ended';
      state.step = null;
      state.turn = { number: state.turn.number, player: null, kind: null };
      emit({ type: EVENTS.GAME_END, reason: state.flags.endReason, turnCapped: state.flags.turnCapped, scores: scoreGame(state) });
      return;
    }
    default:
      throw new Error(`Engine bug: unknown phase "${state.phase}".`);
  }
}

// ---------------------------------------------------------------------------
// advance and applyAction
// ---------------------------------------------------------------------------

function applyOne(state, frame, action, auto) {
  state.seq += 1;
  setEventSeq(state.seq);
  if (eventsOn()) {
    emit({ type: EVENTS.ACTION, player: frame.player, action: JSON.parse(JSON.stringify(action)), auto, text: describeAction(state, action) });
  }
  MUTATORS[action.type](state, frame, action);
}

/**
 * Runs the game forward until a real choice is waiting or the game is over.
 * THE AUTO-ADVANCE RULE (R23.5): a decision with exactly one legal action is
 * not a choice, so the engine applies it itself (its `action` event has
 * `auto: true`).
 */
function advance(state) {
  for (let steps = 0; ; steps++) {
    if (steps > ENGINE_LIMITS.maxAutoSteps) throw new Error('Engine bug: the game does not reach a decision (advance made no progress).');
    if (state.phase === 'ended') return;
    const frame = topFrame(state);
    if (frame === null) {
      runFlow(state);
      continue;
    }
    const list = FRAMES[frame.kind].list(state, frame);
    if (list.length === 0) {
      throw new Error(`Engine bug: the decision "${frame.kind}" has no legal action for ${state.players[frame.player].name}.`);
    }
    if (list.length > 1) return;
    applyOne(state, frame, list[0], true);
  }
}

/** For createGame: runs a fresh state forward to its first decision, collecting events if asked. */
export function advanceToFirstDecision(state, collect = false) {
  openEventSink(collect, state.seq);
  let events = null;
  try {
    advance(state);
  } finally {
    events = closeEventSink();
  }
  return events;
}

/** Options for applyAction that switch event collection off: the fast path for search and bulk simulation. */
export const SILENT = Object.freeze({ events: false });

const WITH_EVENTS = Object.freeze({ events: true });

/**
 * Applies one action for the player who must decide (state.toAct), then runs
 * the game forward to the next real choice (or the end).
 *
 * - Changes `state` in place.
 * - Throws an Error with `code: 'ILLEGAL_ACTION'` and `reason` (the sentence
 *   from getBlockReason) if the action is not legal; the state is untouched.
 * - Returns the events of this action and of everything that followed from
 *   it automatically, in order; or null when called with SILENT.
 */
export function applyAction(state, action, options = WITH_EVENTS) {
  const reason = getBlockReason(state, action);
  if (reason !== null) {
    const type = action !== null && typeof action === 'object' ? action.type : String(action);
    const err = new Error(`Illegal action "${type}": ${reason}`);
    err.code = 'ILLEGAL_ACTION';
    err.reason = reason;
    throw err;
  }
  if (!ACTIONS[action.type].implemented || !MUTATORS[action.type]) {
    throw new Error(`Engine bug: no mutator for action type "${action.type}".`);
  }
  let events = null;
  openEventSink(options.events !== false, state.seq);
  try {
    applyOne(state, topFrame(state), action, false);
    advance(state);
  } finally {
    events = closeEventSink();
  }
  return events;
}
