// worker.mjs - a worker thread of sim.mjs: plays the game indices it is given and posts the records back.
// Games are pure functions of (plan, player count, index), so the thread count never changes a result.

import { parentPort, workerData } from 'node:worker_threads';
import { runGame } from './run-game.mjs';

const { plan, players, indices } = workerData;
const records = [];
for (const index of indices) records.push(await runGame(plan, players, index));
parentPort.postMessage(records);
