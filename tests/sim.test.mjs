// sim.test.mjs - the simulator harness (sim/): flags generated from the engine tables, a small run
// with the bookkeeping assert, determinism whatever the thread count, turn-capped games reported
// separately, the report, and the output file never being overwritten.
//
// Random-bot games are used so the test does not depend on the bot task; one short run uses the
// medium bot when src/bots/index.js exists. Temp files go in a per-process folder under the system
// temp dir. Exits 1 on any failure.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const url = (p) => pathToFileURL(join(root, p)).href;
const E = await import(url('src/engine/index.js'));
const { parseArgs, constantLeaves, helpText, listText } = await import(url('sim/args.mjs'));
const { runGame } = await import(url('sim/run-game.mjs'));
const { aggregate } = await import(url('sim/aggregate.mjs'));
const { renderReport } = await import(url('sim/sim-report.mjs'));
const { playGames, buildOutput, freePath } = await import(url('sim/sim.mjs'));
const { checkBookkeeping, createTally, tallyEvents } = await import(url('sim/metrics.mjs'));
const { loadBots, resolveLevels } = await import(url('sim/bots.mjs'));
const { HEALTH_TABLE } = await import(url('sim/health.mjs'));

const tmp = mkdtempSync(join(tmpdir(), 'superfans-simtest-'));
process.on('exit', () => {
  try {
    rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* a locked temp folder is not a test failure */
  }
});

let failed = 0;
async function run(name, fn) {
  const t0 = performance.now();
  try {
    await fn();
    console.log(`ok   ${name} (${Math.round(performance.now() - t0)} ms)`);
  } catch (err) {
    failed++;
    console.log(`FAIL ${name}\n  ${err && err.stack ? err.stack.split('\n').slice(0, 5).join('\n  ') : err}`);
  }
}

function plan(extra = {}) {
  return {
    games: 12, levels: ['random'], jitter: 0.3, seed: 'simtest', rotate: true, variants: {}, constants: {}, constantFlags: [],
    label: '', maxDecisions: 5000, ...extra,
  };
}

const stripTiming = (records) => records.map((r) => ({ ...r, timing: undefined }));

// ---- flags ------------------------------------------------------------------------------

await run('flags: defaults, lists, booleans and unknown flags', () => {
  const { plan: p } = parseArgs([]);
  assert.equal(p.games, 200);
  assert.deepEqual(p.players, [3]);
  assert.ok(p.jitter > 0, 'jitter is on by default');
  assert.equal(p.rotate, true);
  assert.equal(parseArgs(['--no-rotate']).plan.rotate, false);
  assert.deepEqual(parseArgs(['--players=2,4']).plan.players, [2, 4]);
  assert.deepEqual(parseArgs(['--bots=Easy,medium']).plan.bots, ['easy', 'medium']);
  assert.throws(() => parseArgs(['--gams=5']), /Unknown flag --gams/);
  assert.throws(() => parseArgs(['--players=6']), /2 to 5/);
  assert.throws(() => parseArgs(['--games=0']), /at least 1/);
  assert.throws(() => parseArgs(['stray']), /Unexpected argument/);
  assert.ok(helpText().includes('--variant.queueCapacity=') && helpText().includes('--const.<GROUP>.<PATH>='));
});

await run('flags: every variant name and value is accepted, bad ones are refused (generated from VARIANTS)', () => {
  for (const v of E.VARIANTS) {
    for (const value of v.values) {
      const { plan: p } = parseArgs([`--variant.${v.name}=${value}`]);
      assert.deepEqual(p.variants, value === v.default ? {} : { [v.name]: value }, `${v.name}=${value}`);
    }
    assert.throws(() => parseArgs([`--variant.${v.name}=nonsense`]), /./, `${v.name}=nonsense is refused`);
    assert.ok(listText().includes(`--variant.${v.name}=`));
  }
  assert.throws(() => parseArgs(['--variant.noSuchVariant=on']), /unknown variant "noSuchVariant"/);
});

await run('flags: every constant leaf of RULES is addressable and the engine accepts its default back (generated from RULES)', () => {
  const leaves = constantLeaves();
  assert.ok(leaves.length > 150, `only ${leaves.length} constant leaves found`);
  for (const leaf of leaves) {
    const text = Array.isArray(leaf.value) ? leaf.value.join(',') : leaf.value === null ? 'null' : String(leaf.value);
    const { plan: p } = parseArgs([`--const.${leaf.key}=${text}`]);
    assert.equal(p.constantFlags.length, 1, leaf.key);
    // The engine must take the parsed override (kind and length checked there).
    E.createGame({ playerCount: 2, constants: p.constants }, { seed: 'c' });
    assert.ok(listText().includes(`--const.${leaf.key}=`), `--list shows ${leaf.key}`);
  }
  assert.deepEqual(parseArgs(['--const.COSTS.COST_MOVE_2=2']).plan.constants, { COSTS: { COST_MOVE_2: 2 } });
  assert.deepEqual(parseArgs(['--const.PASS.PASS_SLOT_REWARD=0,0,1,2,4']).plan.constants, { PASS: { PASS_SLOT_REWARD: [0, 0, 1, 2, 4] } });
  assert.deepEqual(parseArgs(['--const.CAPACITY.QUEUE_CAPACITY.rulebook.2=5']).plan.constants, { CAPACITY: { QUEUE_CAPACITY: { rulebook: { 2: 5 } } } });
  assert.throws(() => parseArgs(['--const.COSTS.COST_NOPE=1']), /does not exist/);
  assert.throws(() => parseArgs(['--const.NOPE.X=1']), /unknown constant group/);
  assert.throws(() => parseArgs(['--const.COSTS.COST_MOVE_2=abc']), /not a number/);
  assert.throws(() => parseArgs(['--const.PASS.PASS_SLOT_REWARD=1,2']), /needs 5/);
  assert.throws(() => parseArgs(['--const.EXCHANGE=1']), /name a constant/);
  assert.throws(() => parseArgs(['--const.EXCHANGE.EXCHANGE_E1=1']), /is a table/);
});

await run('bots: random is always a level; unknown levels are refused with the list', async () => {
  const bots = await loadBots();
  assert.ok(bots.levels.includes('random'));
  assert.deepEqual(await resolveLevels(['random'], 3), ['random', 'random', 'random']);
  assert.deepEqual(await resolveLevels(['random', 'random'], 4), ['random', 'random', 'random', 'random']);
  await assert.rejects(() => resolveLevels(['wizard'], 3), /Unknown bot level "wizard"/);
  await assert.rejects(() => resolveLevels(['random', 'random', 'random'], 2), /only 2 players/);
});

// ---- a small run -------------------------------------------------------------------------

let records3;
await run('12 three-player games: no failures, the bookkeeping holds, every record field is present', async () => {
  records3 = await playGames(plan(), 3, 1);
  assert.equal(records3.length, 12);
  for (const r of records3) {
    assert.equal(r.failed, undefined, `game ${r.index} failed: ${r.failed && r.failed.reason}`);
    const P = r.players;
    for (const key of [
      'levels', 'colours', 'startPlayer', 'clubs', 'startHands', 'schedule', 'capacity', 'decisions', 'engineActions', 'autos', 'branching',
      'scores', 'rank', 'vpRank', 'winner', 'sharedTop', 'margin', 'marginPct', 'vp', 'vpBucket', 'vpBucketSource', 'leadChanges', 'coffee',
      'selfies', 'conversions', 'actions', 'autoActions', 'actionHour', 'turns', 'passTurns', 'passOrder', 'passRewards', 'achievements',
      'achHeld', 'achDiscarded', 'swag', 'swagSeen', 'clubUses', 'celebrities', 'counters', 'floorEnd', 'final', 'timing',
    ]) assert.notEqual(r[key], undefined, `record.${key}`);
    // seat colour and celebrity colours per Hour
    assert.equal(r.colours.length, P);
    assert.equal(new Set(r.colours).size, P, 'seat colours differ');
    assert.equal(r.schedule.length, 6);
    for (const s of r.schedule) assert.ok(E.COLOURS.includes(s.colour), `celebrity colour ${s.colour}`);
    // VP by source from events: per seat, sums to the final score and uses only engine sources
    for (let s = 0; s < P; s++) {
      assert.equal(Object.values(r.vp[s]).reduce((a, b) => a + b, 0), r.scores[s]);
      for (const src of Object.keys(r.vp[s])) assert.ok(E.VP_SOURCES.includes(src), `VP source ${src}`);
    }
    // VP by Hour adds up to the same totals
    for (let s = 0; s < P; s++) assert.equal(r.vpBucket.reduce((a, b) => a + b[s], 0), r.scores[s]);
    assert.equal(r.vpBucket.length, 6);
    assert.equal(r.passOrder.length, 5);
    for (const order of r.passOrder) assert.equal(order.length, P, 'every seat passes once each Hour');
    assert.equal(r.celebrities.length, 6, 'six destination scorings: Hours 1-4 and two in Hour 5');
    assert.ok(r.rank.includes(1) && r.winner === r.rank.indexOf(1));
    assert.ok(r.branching.n === r.decisions);
    assert.equal(r.floorEnd.filter(Boolean).length, 5, 'a Floor-end snapshot for each Hour');
    for (const f of r.floorEnd) assert.equal(f.halls.length, E.HALL_IDS.length);
  }
});

await run('determinism: the same plan gives identical records, one thread or two', async () => {
  const again = await playGames(plan(), 3, 1);
  assert.deepEqual(stripTiming(again), stripTiming(records3));
  const threaded = await playGames(plan(), 3, 2);
  assert.deepEqual(stripTiming(threaded), stripTiming(records3), 'two threads give the same games');
  const other = await playGames(plan({ seed: 'another' }), 3, 1);
  assert.notDeepEqual(other.map((r) => r.scores), records3.map((r) => r.scores));
});

await run('instrument check: a plain engine loop with the same seeds gives the harness scores and winner', async () => {
  const p = plan({ games: 3, levels: ['random', 'random', 'random'], rotate: false });
  for (let index = 0; index < 3; index++) {
    const seed = `${p.seed}-${index}`;
    const state = E.createGame({ players: [{ name: 'a' }, { name: 'b' }, { name: 'c' }] }, { seed });
    const botRng = [0, 1, 2].map((s) => E.makeRng(`bots:${seed}:${s}`));
    const { chooseRandomAction } = await import(url('src/bots/randomBot.js'));
    while (!E.isGameOver(state)) E.applyAction(state, chooseRandomAction(state, E.forkRng(botRng[state.toAct])), E.SILENT);
    const score = E.scoreGame(state);
    const rec = records3[index];
    assert.deepEqual(rec.scores, score.players.map((x) => x.vp), `game ${index} scores`);
    assert.equal(rec.winner, score.winner);
    assert.deepEqual(rec.rank, score.players.map((x) => x.rank));
    assert.equal(rec.engineActions, state.seq);
  }
});

await run('bookkeeping assert: a mismatch between events and scores is caught', async () => {
  const made = E.createGame({ playerCount: 2 }, { seed: 'bk', events: true });
  const state = made.state;
  const rng = E.makeRng('bk-bot');
  const tally = createTally(2);
  tallyEvents(tally, made.events);
  while (!E.isGameOver(state)) tallyEvents(tally, E.applyAction(state, E.rngPick(rng, E.getValidActions(state))));
  const score = E.scoreGame(state);
  const start = { coffee: E.getConstants(state).START.START_COFFEE, selfies: { ...E.getConstants(state).START.START_SELFIES } };
  assert.deepEqual(checkBookkeeping(tally, score, state, start), [], 'a real game balances');
  // 1. an invented VP event
  const t1 = structuredClone(tally);
  t1.vp[0].celebrity = (t1.vp[0].celebrity ?? 0) + 1;
  assert.ok(checkBookkeeping(t1, score, state, start).some((p) => p.includes('celebrity')), 'extra VP in events');
  // 2. a missing VP source
  const t2 = structuredClone(tally);
  const some = Object.keys(t2.vp[1])[0];
  delete t2.vp[1][some];
  assert.ok(checkBookkeeping(t2, score, state, start).length > 0, 'VP missing from events');
  // 3. a coffee gain the events never announced
  const t3 = structuredClone(tally);
  t3.coffeeNet[0] += 1;
  assert.ok(checkBookkeeping(t3, score, state, start).some((p) => p.includes('coffee')), 'coffee flow');
  // 4. a selfie spend the events never announced
  const t4 = structuredClone(tally);
  t4.selfieNet[1].red -= 1;
  assert.ok(checkBookkeeping(t4, score, state, start).some((p) => p.includes('red selfies')), 'selfie flow');
});

await run('turn-capped games are counted on their own and left out of the means', async () => {
  // A free Move 2 lets a random player hit the R8.9 main-action stop, which flags the game turnCapped.
  const p = plan({ games: 6, constants: { COSTS: { COST_MOVE_2: 0 } }, constantFlags: ['COSTS.COST_MOVE_2=0'] });
  const records = await playGames(p, 2, 1);
  const capped = records.filter((r) => r.turnCapped).length;
  assert.ok(capped > 0, 'the probe produces turn-capped games');
  assert.ok(records.every((r) => !r.failed), 'turn-capped games are not failures');
  const a = aggregate(records, { players: 2 });
  assert.equal(a.counts.turnLimit, capped);
  assert.equal(a.counts.analysed, records.length - capped);
  assert.equal(a.health.find((h) => h.id === 'turnLimit').status, 'WARN', 'a turn-capped game is flagged');
  if (a.counts.analysed < records.length) assert.ok(a.allFinished, 'an all-finished figure is given when games were excluded');
});

await run('a refused action, a crash and the decision cap are reported as failures, not hidden', async () => {
  // Patch the shared bot table with two misbehaving levels (restored afterwards).
  const bots = await loadBots();
  const original = bots.choose;
  bots.levels.push('rogue', 'crasher');
  bots.choose = (state, level, rng, opts) => {
    if (level === 'rogue') return { type: 'move2', crew: 'c9-9', to: 'nowhere' };
    if (level === 'crasher') throw new Error('boom');
    return original(state, level, rng, opts);
  };
  try {
    const refused = await runGame(plan({ levels: ['rogue', 'rogue'] }), 2, 0);
    assert.equal(refused.failed.type, 'refusal');
    assert.ok(refused.failed.reason.length > 0 && refused.failed.hash);
    const crashed = await runGame(plan({ levels: ['crasher', 'crasher'] }), 2, 0);
    assert.equal(crashed.failed.type, 'error');
    assert.ok(crashed.failed.reason.includes('boom'));
    const a = aggregate([refused, crashed], { players: 2 });
    assert.equal(a.counts.refusals, 1);
    assert.equal(a.counts.errors, 1);
    assert.equal(a.health.find((h) => h.id === 'refusals').status, 'WARN');
  } finally {
    bots.choose = original;
    bots.levels.splice(bots.levels.indexOf('rogue'), 2);
  }
  const cap = await runGame(plan({ maxDecisions: 100 }), 2, 0);
  assert.equal(cap.failed.type, 'cap');
  const a = aggregate([cap], { players: 2 });
  assert.equal(a.counts.decisionCapHits, 1);
  assert.equal(a.health.find((h) => h.id === 'decisionCap').status, 'WARN');
  assert.equal(a.empty, true, 'nothing analysable');
  assert.ok(renderReport(a, plan()).includes('No analysable games'));
});

await run('aggregate and report: every section, sane totals', async () => {
  const a = aggregate(records3, { players: 3 });
  assert.equal(a.counts.analysed, 12);
  for (const key of ['length', 'scores', 'margin', 'seats', 'levels', 'vpSources', 'pacing', 'leads', 'actions', 'branching', 'economy', 'queues', 'cards', 'subsystems', 'health']) {
    assert.ok(a[key], `section ${key}`);
  }
  assert.equal(a.seats.seat.reduce((x, s) => x + s.wins, 0), 12, 'every game has one winner by seat');
  assert.equal(a.seats.position.reduce((x, s) => x + s.wins, 0), 12, 'and by turn-order position');
  assert.ok(Math.abs(a.vpSources.rows.reduce((x, r) => x + r.share, 0) - 1) < 1e-9, 'VP shares add to 1');
  assert.ok(Math.abs(a.pacing.buckets.reduce((x, b) => x + b.share, 0) - 1) < 1e-9, 'Hour shares add to 1');
  assert.equal(a.cards.achievements.length, E.ACHIEVEMENT_CARDS.length);
  assert.equal(a.cards.swag.length, E.SWAG_CARDS.length);
  assert.equal(a.cards.clubs.length, E.CLUB_CARDS.length);
  assert.equal(a.cards.celebrities.length, E.CELEBRITY_CARDS.length);
  assert.equal(a.cards.celebrities.reduce((x, c) => x + c.scored, 0), 72, '6 scorings x 12 games');
  assert.equal(a.cards.clubs.reduce((x, c) => x + c.holders, 0), 36, 'one Club per seat');
  assert.equal(a.health.length, HEALTH_TABLE.length);
  for (const h of a.health) assert.ok(['OK', 'WARN', 'n/a'].includes(h.status), `${h.id} ${h.status}`);
  assert.equal(a.health.find((h) => h.id === 'refusals').status, 'OK');
  const text = renderReport(a, plan());
  for (let i = 1; i <= 17; i++) assert.ok(new RegExp(`^${i}\\. `, 'm').test(text), `report section ${i}`);
  assert.ok(/OK|WARN/.test(text));
  assert.ok(!text.includes('undefined') && !text.includes('NaN'), 'no undefined or NaN in the report');
  // the JSON output is plain data
  const out = buildOutput(plan(), 3, records3, 1000, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(out)).summary.counts, out.summary.counts);
});

await run('a variant and a constant change the games they are asked to (and only those)', async () => {
  const base = await playGames(plan({ games: 6 }), 3, 1);
  const rulebook = await playGames(plan({ games: 6, variants: { queueCapacity: 'rulebook' } }), 3, 1);
  assert.equal(base[0].capacity, E.getConstants(E.createGame({ playerCount: 3 }, { seed: 'x' })).CAPACITY.QUEUE_CAPACITY['printed-board'][3]);
  assert.equal(rulebook[0].capacity, E.getConstants(E.createGame({ playerCount: 3 }, { seed: 'x' })).CAPACITY.QUEUE_CAPACITY.rulebook[3]);
  assert.notEqual(base[0].capacity, rulebook[0].capacity);
  assert.deepEqual(rulebook[0].variants, { queueCapacity: 'rulebook' });
  assert.ok(rulebook.every((r) => !r.failed));
  // setup (clubs, hands, schedule) is a function of the seed alone
  assert.deepEqual(rulebook.map((r) => r.clubs), base.map((r) => r.clubs));
});

await run('the command line: JSON per player count, never overwritten, report printed', () => {
  const out = join(tmp, 'run.json');
  const args = [join(root, 'sim', 'sim.mjs'), '--games=4', '--players=2,3', '--bots=random', `--out=${out}`, '--quiet', '--seed=cli', '--section=health,seats'];
  const r1 = spawnSync(process.execPath, args, { encoding: 'utf8' });
  assert.equal(r1.status, 0, r1.stderr);
  assert.ok(existsSync(join(tmp, 'run-2p.json')) && existsSync(join(tmp, 'run-3p.json')), readdirSync(tmp).join(','));
  assert.ok(r1.stdout.includes('1. Health') && r1.stdout.includes('5. Who wins') && !r1.stdout.includes('9. Action mix'), '--section limits the report');
  const data = JSON.parse(readFileSync(join(tmp, 'run-3p.json'), 'utf8'));
  assert.equal(data.schema, 'superfans-sim-v1');
  assert.equal(data.games.length, 4);
  assert.equal(data.summary.counts.refusals, 0);
  const r2 = spawnSync(process.execPath, args, { encoding: 'utf8' });
  assert.equal(r2.status, 0, r2.stderr);
  assert.ok(existsSync(join(tmp, 'run-2p-v2.json')) && existsSync(join(tmp, 'run-3p-v2.json')), 'the second run is versioned, not overwritten');
  assert.equal(freePath(join(tmp, 'run-2p.json')), join(tmp, 'run-2p-v3.json'));
  // errors exit 2 with a message, nothing is played
  const bad = spawnSync(process.execPath, [join(root, 'sim', 'sim.mjs'), '--variant.queueCapacity=huge'], { encoding: 'utf8' });
  assert.equal(bad.status, 2);
  assert.ok(/queueCapacity/.test(bad.stderr), bad.stderr);
  const rep = spawnSync(process.execPath, [join(root, 'sim', 'sim-report.mjs'), join(tmp, 'run-3p.json'), '--section=integrity'], { encoding: 'utf8' });
  assert.equal(rep.status, 0, rep.stderr);
  assert.ok(rep.stdout.includes('Run integrity'));
});

await run('the heuristic bots (when src/bots/index.js exists): 4 two-player games, no refusals, bookkeeping holds', async () => {
  const bots = await loadBots();
  if (!bots.hasIndex) {
    console.log('     (src/bots/index.js not available: skipped)');
    return;
  }
  assert.ok(bots.levels.includes('medium'), bots.levels.join(','));
  const levels = await resolveLevels(['easy', 'medium'], 2);
  const records = await playGames(plan({ games: 4, levels }), 2, 1);
  for (const r of records) assert.equal(r.failed, undefined, `game ${r.index}: ${r.failed && r.failed.reason}`);
  assert.ok(new Set(records.flatMap((r) => r.levels)).size === 2, 'both levels played');
  const a = aggregate(records, { players: 2 });
  assert.equal(a.levels.mixed, true);
  assert.equal(a.levels.rows.reduce((x, r) => x + r.wins, 0), 4);
});

if (failed > 0) {
  console.log(`sim: ${failed} failed`);
  process.exit(1);
}
console.log('sim ok');
