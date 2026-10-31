# Simulator output format (`superfans-sim-v1`)

Written by `sim/sim.mjs`, one file per player count. Read it with `sim/sim-report.mjs`
(text report) or, for charts, `aggregate(data.games, { players })` from `sim/aggregate.mjs`
(the same function that produced `data.summary`).

Seats are 0-based in the data (the report prints them 1-based). Per-seat values are arrays
indexed by seat. Everything is built from engine events, never inferred from state; the few
facts read from the state (start hands, clubs, schedule, Floor-end snapshot, final board) are
named below. Hour index `b` = 0..4 for Hours 1-5 and 5 for **Final scoring** (R22: the last
Achievement tripled, leftover selfies); an event is filed under the Hour in which the engine
awarded it (Coffee Break, On the Floor and Walk of that Hour).

## File

```
{ schema: 'superfans-sim-v1', players,
  plan:    { games, levels[per seat], jitter, seed, rotate, variants (non-default only), constants, constantFlags[], label, maxDecisions },
  meta:    { rulesId, engineSchema, node, threads, wallMs, generated },
  summary: aggregate(games),        // sections listed below
  games:   [ record, ... ] }        // in game-index order
```

Game `k` is a pure function of `plan` and `k`: game seed `"<seed>-<k>"`; bot streams
`"bots:<game seed>:<seat>"`, forked per decision. Same plan, same games, whatever the thread count.
With `rotate` and mixed levels, seat `s` plays `levels[(s + k) % players]`.

## Per-game record

| Field | Meaning |
|---|---|
| `index, seed, players` | |
| `levels[seat]` | bot level per seat |
| `colours[seat]` | seat (player) colour |
| `startPlayer` | Hour 1 first player (seat) |
| `variants` | non-default variants of the run |
| `clubs[seat]` | Club card dealt (`club_01`..) |
| `startHands[seat]` | Achievement cards dealt at setup (the simulator may see hidden cards) |
| `schedule[]` | `{ slot, hour, card, colour }` for the six celebrity slots: **celebrity colour per Hour** |
| `capacity` | hall queue capacity in force |
| `decisions, engineActions, autos` | chosen actions; all applied actions; forced ones the engine applied itself |
| `scores[seat], rank[seat], vpRank[seat], winner, sharedTop[]` | from `scoreGame` (rank after the R22.6 tie-break) |
| `margin, marginPct` | winner minus second place, and as % of the winner |
| `turnCapped`, `end { reason, turnCapped }` | a safety stop ended the game early (R8.9, R27.18) |
| `vp[seat]` | `{ source: VP }` from VP events (sources: `VP_SOURCES`) |
| `vpBucket[b][seat]` | VP per Hour per seat (b = 5 final scoring) |
| `vpBucketSource[b]` | `{ source: VP }` per Hour, all seats |
| `leadChanges` | times a new sole leader (by running VP, per VP event) replaced the previous sole leader; ties keep the old leader |
| `coffee[seat]` | `{ earned: {cause: n}, lost: {cause: n}, spent: {actionType: n} }` (earned = kept; lost = over the cap) |
| `selfies[seat]` | `{ gainedByColour, gainedByCause, spentByColour, spentByCause }` (causes: `SELFIE_CAUSES`; spend causes include `exchange, swag, rare-finds, final-selfies, swag-convert, club-limit`) |
| `conversions[seat]` | `{ E1, E2, E3, strike-a-pose, rare-finds }` counts |
| `actions[seat]` | chosen action counts by type; `autoActions[seat]` forced ones |
| `actionHour[seat][b]` | chosen action counts by type per Hour |
| `turns[seat][b], passTurns[seat][b]` | normal turns and pass-turns per Hour |
| `passOrder[hour]` | seats in the order they passed that Hour (**passes and pass order**) |
| `passRewards[seat]` | `{ coffee: n, vp: n }` taken on the pass ladder |
| `achievements[]` | `{ seat, card, hour, when: pass\|final\|swag, count, multiplier, vp, tripled }` (**completed, which, when**; `vp: 0` = scored for nothing) |
| `achHeld[seat]` | every Achievement the seat ever held (start hand plus draws) |
| `achDiscarded[]` | `{ seat, card, cause, hour }` unscored discards |
| `swag[]` | `{ seat, card, colour, cost, hour, slot }` bought; `swagSeen[]` cards that were ever in the market; `swagVp{card: VP}` |
| `clubUses[]` | `{ seat, club, option, hour }` main-action uses (Rare Finds and Strike a Pose are conversions); `clubVp{club: VP}` |
| `celebrities[]` | per destination scoring: `{ hour, slot, card, colour, hall, method, queueLen, scoring, totals[seat] }` (**who scored what**; `queueLen` = Crew in the hall, `scoring` = Crew that scored VP) |
| `counters` | flat counts: `crewMoves, usherCrossings, usherPaid, usherCoffee, jumps, volunteer.<role>, volunteerMoved, upgrade.<badge>, placed.<cause>, primeSelfies, photographerSelfies, walkSteps, achievementTripled, reshuffle.<deck>, safety.<kind>` |
| `branching` | decision space, see below |
| `floorEnd[hour]` | snapshot taken before the last Floor decision of each Hour: `{ halls: [[total, ...bySeat] x 9 in HALL_IDS order], coffee[seat], selfies[seat] (all colours), vp[seat] }` (**queue lengths and contention per hall**; the Walk follows that decision) |
| `final[seat]` | end state read from the state: `coffee, handLeft, passSlot, volunteersPlaced, badges {N00b,VIP,AAA} on board, crewOnBoard` |
| `timing.ms` | wall time of the game |
| `failed` | only when the game failed: `{ type: refusal\|error\|integrity\|cap, seat, hash, reason, action? }`; such games are never analysed |

### `branching`

`n, sum, distinct, max`: over every decision (legal action count, distinct action types, largest list).
`hour[b] = [decisions, sum of legal actions, sum of distinct types]`; `kind{frameKind: same triple}`;
`turnStart` and `turnStartHour[b]`: the same triple counted only at the **first decision of a turn**
(frame `turn` or `passTurn`); `turnStartByType{type: [turns offered, options of that type summed]}`;
`offered{type: decisions in which it was offered}`.

### Bookkeeping check (per game, failure type `integrity`)

Per seat: the VP of the events, by source and in total, equals `scoreGame` and the state; and
coffee and each selfie colour at the end equal `start + gains - spends` from the flow events.
A `gameEnd` event must have been announced.

## `summary` sections (one player count)

`counts` (games, finished, analysed, turnLimit, engineActionCap, decisionCapHits, refusals, errors,
integrity, failures[]), `length`, `scores`, `margin`, `seats` (win rate per seat and per turn-order
position with sigma), `levels` (when levels are mixed), `vpSources`, `pacing`, `leads`, `actions`,
`branching`, `economy`, `queues`, `cards { achievements[], swag[], clubs[], celebrities[],
celebrityRollups }`, `subsystems[]` (`{ id, label, games, share, rare }`), `allFinished` (headline
figures including turn-capped games, when there were any) and `health[]` (`{ id, label, value,
unit, healthy, status: OK|WARN|n/a, sigma?, detail?, bad }`, thresholds in `sim/health.mjs`).
Turn-capped games are excluded from every section except `counts` and `allFinished`.

Win-correlation figures compare a rate with `1/players` and give `sigma` = standard errors from
that share (binomial); a card's `winN` says how few cases it rests on.
