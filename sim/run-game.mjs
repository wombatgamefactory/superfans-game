// run-game.mjs - plays ONE game and returns its record (the format is documented in SCHEMA.md).
//
// The driver is the loop every consumer of the engine uses:
//
//   ask the bot of state.toAct  ->  applyAction(state, what it chose)  ->  repeat
//
// It never switches on action types to apply them and never touches the state to "help"
// a game along. A game is a pure function of (config, game seed, bot seeds):
//
//   game seed   "<--seed>-<game index>"                  -> createGame seed (the game stream)
//   bot streams "bots:<game seed>:<seat>", forked per decision (the bot stream; bots never read state.rng)
//
// so game k is the same game whatever the thread count or the order games are played in.
//
// A game that fails (refused action, decision cap, crash, bookkeeping mismatch) still returns
// a record with `failed` set, so the run can report it and exit non-zero.

import {
  createGame, getValidActions, applyAction, isGameOver, scoreGame, topFrame, hashState, getConstants, makeRng, forkRng,
  HALL_IDS, capacity,
} from '../src/engine/index.js';
import { loadBots } from './bots.mjs';
import { createTally, tallyEvents, checkBookkeeping, BUCKETS } from './metrics.mjs';
import { inc, sortedKeys } from './stats.mjs';

/** The seed of game `index` of a run. */
export function gameSeed(plan, index) {
  return `${plan.seed}-${index}`;
}

/** The bot level at each seat for game `index`. With --rotate and mixed levels the assignment moves one seat per game. */
export function levelsForGame(plan, players, index) {
  const list = plan.levels.slice();
  while (list.length < players) list.push(list[list.length - 1]); // a short list is padded with its last level
  const out = [];
  for (let s = 0; s < players; s++) out.push(plan.rotate ? list[(s + index) % players] : list[s]);
  return out;
}

const HALL_INDEX = Object.fromEntries(HALL_IDS.map((h, i) => [h, i]));

/** Hall occupancy and economy of every seat right now: { halls: [[total, ...bySeat] x9 in HALL_IDS order], coffee, selfies, vp }. */
function floorSnapshot(state) {
  const P = state.players.length;
  const halls = HALL_IDS.map(() => Array(P + 1).fill(0));
  for (const c of state.crew) {
    if (c.hall === null) continue;
    const row = halls[HALL_INDEX[c.hall]];
    row[0]++;
    row[1 + c.owner]++;
  }
  return {
    halls,
    coffee: state.players.map((p) => p.coffee),
    selfies: state.players.map((p) => p.selfies.green + p.selfies.red + p.selfies.orange),
    vp: state.players.map((p) => p.vp),
  };
}

function badgeCounts(state, seat) {
  const out = { N00b: 0, VIP: 0, AAA: 0 };
  for (const c of state.crew) if (c.owner === seat && c.hall !== null) out[c.badge]++;
  return out;
}

/** Plays game `index` for `players` seats. `plan` is the serialisable plan (see sim.mjs). */
export async function runGame(plan, players, index) {
  const bots = await loadBots();
  const seed = gameSeed(plan, index);
  const started = performance.now();
  const record = { index, seed, players };
  let state = null;

  try {
    const levels = levelsForGame(plan, players, index);
    const config = { players: Array.from({ length: players }, (_, i) => ({ name: `Seat ${i + 1}` })), variants: plan.variants };
    if (plan.constants && Object.keys(plan.constants).length > 0) config.constants = plan.constants;
    const made = createGame(config, { seed, events: true });
    state = made.state;
    const K = getConstants(state);
    const P = players;

    const tally = createTally(P);
    tallyEvents(tally, made.events);

    const botRng = levels.map((_, seat) => makeRng(`bots:${seed}:${seat}`));
    const opts = { jitter: plan.jitter };

    // Start-of-game facts (the simulator may read hidden cards: it is not a player).
    record.levels = levels;
    record.colours = state.players.map((p) => p.colour);
    record.startPlayer = state.startPlayer;
    record.variants = plan.variants;
    record.clubs = state.players.map((p) => p.club);
    record.startHands = state.players.map((p) => p.hand.slice());
    record.schedule = state.schedule.map((s) => ({ slot: s.slot, hour: s.hour, card: s.card, colour: s.colour }));
    record.capacity = capacity(state);
    const marketAtStart = state.swag.market.filter((c) => c !== null);
    for (const c of marketAtStart) tally.swagSeen.add(c);
    const startResources = { coffee: K.START.START_COFFEE, selfies: { ...K.START.START_SELFIES } };

    // Branching: legal actions at every decision.
    const br = {
      n: 0, sum: 0, distinct: 0, max: 0,
      hour: Array.from({ length: BUCKETS }, () => [0, 0, 0]),
      kind: {},
      turnStart: [0, 0, 0],
      turnStartHour: Array.from({ length: BUCKETS }, () => [0, 0, 0]),
      turnStartByType: {}, // type -> [turns it was offered at the first decision, options of that type summed]
      offered: {}, // type -> decisions where at least one action of this type was offered
    };
    let lastTurn = -1;
    let decisions = 0;
    let failed = null;
    const seen = [];
    const typeCount = {};

    while (!isGameOver(state)) {
      if (decisions >= plan.maxDecisions) {
        failed = { type: 'cap', seat: state.toAct, hash: hashState(state), reason: `${decisions} decisions without an end` };
        break;
      }
      const seat = state.toAct;
      const legal = getValidActions(state);
      const frame = topFrame(state);
      const bucket = state.phase === 'final' ? 5 : Math.min(state.hour, 5) - 1;

      seen.length = 0;
      for (const k of Object.keys(typeCount)) delete typeCount[k];
      for (let i = 0; i < legal.length; i++) {
        const ty = legal[i].type;
        if (typeCount[ty] === undefined) {
          typeCount[ty] = 0;
          seen.push(ty);
        }
        typeCount[ty]++;
      }
      const n = legal.length;
      const d = seen.length;
      br.n++;
      br.sum += n;
      br.distinct += d;
      if (n > br.max) br.max = n;
      const hb = br.hour[bucket];
      hb[0]++;
      hb[1] += n;
      hb[2] += d;
      const kb = (br.kind[frame.kind] ??= [0, 0, 0]);
      kb[0]++;
      kb[1] += n;
      kb[2] += d;
      for (const ty of seen) inc(br.offered, ty);
      if ((frame.kind === 'turn' || frame.kind === 'passTurn') && state.turn.number !== lastTurn) {
        lastTurn = state.turn.number;
        br.turnStart[0]++;
        br.turnStart[1] += n;
        br.turnStart[2] += d;
        const tb = br.turnStartHour[bucket];
        tb[0]++;
        tb[1] += n;
        tb[2] += d;
        for (const ty of seen) {
          const e = (br.turnStartByType[ty] ??= [0, 0]);
          e[0]++;
          e[1] += typeCount[ty];
        }
      }

      // The economy and board just before the decision; the last one taken On the Floor
      // of an Hour is the Floor-end snapshot (the Walk follows the last Floor decision).
      if (state.phase === 'floor') tally.floorEnd[state.hour - 1] = floorSnapshot(state);

      const rng = forkRng(botRng[seat]);
      const action = bots.choose(state, levels[seat], rng, opts);
      let events;
      try {
        events = applyAction(state, action);
      } catch (err) {
        if (err && err.code === 'ILLEGAL_ACTION') {
          failed = { type: 'refusal', seat, hash: hashState(state), action, reason: err.reason ?? err.message };
          break;
        }
        throw err;
      }
      decisions++;
      tallyEvents(tally, events);
    }

    record.decisions = decisions;
    record.engineActions = state.seq;
    record.autos = state.seq - decisions;
    record.branching = {
      ...br,
      kind: sortedKeys(br.kind),
      turnStartByType: sortedKeys(br.turnStartByType),
      offered: sortedKeys(br.offered),
    };

    if (failed) {
      record.failed = failed;
      record.timing = { ms: round1(performance.now() - started) };
      return record;
    }

    const score = scoreGame(state);
    const flags = state.flags;
    record.end = { reason: flags.endReason, turnCapped: Boolean(flags.turnCapped) };
    record.turnCapped = Boolean(flags.turnCapped);
    record.scores = score.players.map((p) => p.vp);
    record.rank = score.players.map((p) => p.rank);
    record.vpRank = score.players.map((p) => p.vpRank);
    record.winner = score.winner;
    record.sharedTop = score.sharedTop;
    const sorted = record.scores.slice().sort((a, b) => b - a);
    record.margin = sorted[0] - sorted[1];
    record.marginPct = sorted[0] > 0 ? (100 * (sorted[0] - sorted[1])) / sorted[0] : 0;

    record.vp = tally.vp.map((o) => sortedKeys(o));
    record.vpBucket = tally.vpBucket;
    record.vpBucketSource = tally.vpBucketSource.map((o) => sortedKeys(o));
    record.leadChanges = tally.leadChanges;

    record.coffee = tally.coffeeEarned.map((_, s) => ({
      earned: sortedKeys(tally.coffeeEarned[s]),
      lost: sortedKeys(tally.coffeeLost[s]),
      spent: sortedKeys(tally.coffeeSpent[s]),
    }));
    record.selfies = tally.selfieGainCause.map((_, s) => ({
      gainedByColour: sortedKeys(tally.selfieGainColour[s]),
      gainedByCause: sortedKeys(tally.selfieGainCause[s]),
      spentByColour: sortedKeys(tally.selfieSpendColour[s]),
      spentByCause: sortedKeys(tally.selfieSpendCause[s]),
    }));
    record.conversions = tally.conversions.map((o) => sortedKeys(o));

    record.actions = tally.chosen.map((o) => sortedKeys(o));
    record.autoActions = tally.auto.map((o) => sortedKeys(o));
    record.actionHour = tally.actionHour.map((hours) => hours.map((o) => sortedKeys(o)));
    record.turns = tally.turns;
    record.passTurns = tally.passTurns;
    record.passOrder = tally.passOrder;
    record.passRewards = tally.passRewards.map((o) => sortedKeys(o));

    record.achievements = tally.achievements;
    record.achHeld = state.players.map((p, s) => [...new Set([...record.startHands[s], ...tally.achDrawn[s]])].sort());
    record.achDiscarded = tally.achDiscarded;
    record.swag = tally.swag;
    record.swagSeen = [...tally.swagSeen].sort();
    record.clubUses = tally.clubUses;
    record.celebrities = tally.celebrities;
    record.counters = sortedKeys(tally.counters);
    record.clubVp = sortedKeys(tally.clubVp);
    record.swagVp = sortedKeys(tally.swagVp);
    record.floorEnd = tally.floorEnd;

    record.final = state.players.map((p, s) => ({
      coffee: p.coffee,
      handLeft: p.hand.length,
      passSlot: p.passSlot,
      volunteersPlaced: K.SUPPLY.VOLUNTEERS_PER_PLAYER - p.volunteers,
      badges: badgeCounts(state, s),
      crewOnBoard: state.crew.filter((c) => c.owner === s && c.hall !== null).length,
    }));

    // Bookkeeping check: the VP and flow announced by events must equal the engine's own totals.
    const problems = checkBookkeeping(tally, score, state, startResources);
    if (tally.ended === null) problems.push('no gameEnd event was announced');
    if (problems.length > 0) {
      record.failed = { type: 'integrity', seat: null, hash: hashState(state), reason: problems.slice(0, 6).join('; ') };
    }
  } catch (err) {
    let h = null;
    try {
      h = state ? hashState(state) : null;
    } catch {
      h = null;
    }
    record.failed = { type: 'error', seat: null, hash: h, reason: String(err && err.stack ? err.stack.split('\n').slice(0, 4).join(' | ') : err) };
  }
  record.timing = { ms: round1(performance.now() - started) };
  return record;
}

function round1(x) {
  return Math.round(x * 10) / 10;
}

