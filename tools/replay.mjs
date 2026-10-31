// replay.mjs - replays a downloaded Superfans game record headless and checks it.
//
//   node tools/replay.mjs path/to/superfans-game-record-12345.json [--quiet]
//
// A record holds the engine config (players, seed, variants), the full list of
// actions the players chose and the final scores the page showed. The tool
// rebuilds the game with the engine (replayGame), then compares the replayed
// scores, ranks and final state hash with the record.
//
// Exit code 0 = the replay reproduces the record. 1 = it does not (the reasons are
// printed). 2 = bad usage or an unreadable file.

import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { replayRecord } from '../src/ui/record.js';
import { scoreGame } from '../src/engine/index.js';

export function replayFile(file) {
  const rec = JSON.parse(fs.readFileSync(file, 'utf8'));
  return { rec, result: replayRecord(rec) };
}

function main(argv) {
  const args = argv.slice(2);
  const quiet = args.includes('--quiet');
  const file = args.find((a) => !a.startsWith('--'));
  if (!file) {
    console.error('usage: node tools/replay.mjs <game-record.json> [--quiet]');
    return 2;
  }
  let out;
  try {
    out = replayFile(file);
  } catch (err) {
    console.error(`Could not read ${file}: ${err.message}`);
    return 2;
  }
  const { rec, result } = out;
  if (!quiet) {
    console.log(`Record: ${rec.game} ${rec.version}, rules ${rec.rulesId}, seed ${rec.seed}, ${rec.config && rec.config.players ? rec.config.players.length : '?'} players, ${rec.actions ? rec.actions.length : '?'} actions, ${rec.finished ? 'finished' : 'UNFINISHED'}`);
    if (result.state) {
      const sc = scoreGame(result.state);
      for (const p of [...sc.players].sort((a, b) => a.rank - b.rank)) {
        const was = result.expected.find((e) => e.seat === p.seat);
        console.log(`  #${p.rank} ${p.name}: ${p.vp} VP${was ? ` (record: ${was.vp} VP)` : ''}`);
      }
    }
  }
  if (result.ok) {
    console.log('REPLAY OK: the replayed scores and final state match the record.');
    return 0;
  }
  console.log('REPLAY FAILED:');
  for (const p of result.problems) console.log(`  - ${p}`);
  return 1;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) process.exit(main(process.argv));
