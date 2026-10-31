# Superfans

Browser version of the Superfans board game. Pure JavaScript, no build step, served by GitHub Pages.

## About the game

Superfans is a fan-convention board game for 2-5 players (about 45-75 minutes). You run a crew of fans around nine halls, queue for celebrities, take selfies, buy swag, use club powers and score achievements. The game lasts five Hours; each Hour a celebrity walks a printed route through the halls and scores the queue at the hall where it stops. Most points at the end of Hour 5 wins.

This version lets you play at one screen with friends (pass-and-play, with a handover screen so hands stay private), against bots at Easy, Medium or Hard, or set every seat to a bot and watch a demo game. When a game ends you get a stats screen and can download a record of the game as a JSON file.

### Play it locally

You need Node.js (any recent version). Then:

    npm install
    npm run dev        # serves http://localhost:8080

Open http://localhost:8080 and pick your seats on the landing page. Any other static file server works too (the game is plain files; there is nothing to build). Serve the whole repository folder, not just `index.html`: the game loads modules from `src/`, art from `assets/` and the stats code from `sim/`.

Handy page addresses (add to the end of the address):

| Address | What it does |
|---|---|
| `?seats=h,m` | Skips the landing page: a human against a Medium bot. Letters: `h` human, `e` Easy, `m` Medium, `d` Hard (up to five seats) |
| `?seats=m,m,m` | Three Medium bots playing each other: a demo game to watch |
| `&speed=fast` or `&speed=instant` | Quicker bot turns (`normal` is the default) |
| `&seed=42` | A fixed shuffle, so the same game can be set up again |
| `?generic=1` | Plain list of buttons for every legal action, instead of clicking the board |

In a game, press Ctrl+Shift+B to open the Report a problem dialog.

## For developers

### Run and test

    npm install
    npm run dev           # http-server on port 8080, caching off
    npm test              # every suite plus the publication sweep: the full gate, about 15 minutes
    npm run test:quick    # same without the slow Hard-bot ladder, and fewer bot games (a few minutes)
    node tests/qa/sweep.mjs --list    # just the publication sweep

`npm test` runs each `tests/*.test.mjs` in its own process and prints each suite's time. The browser suites drive Microsoft Edge through Playwright (`chromium.launch({ channel: 'msedge' })`), so Edge must be installed; Playwright's own browser download is not needed. Test temporary files go in a folder under the system temp directory.

The two slow suites are `bots.test.mjs` (bot strength: Medium against Random and Easy, 500 mixed games) and `bot-ladder.test.mjs` (100 games of Hard against Medium, which must win at least 65%). `test:quick` sets `QUICK=1`: `bot-ladder` is skipped and `bots.test` plays about a quarter of the games with the same thresholds. Use the full run before any release.

### Simulate

The simulator plays bot-against-bot games headlessly and reports designer metrics (scores, where points come from, action mix, seat win rates with error bars, card usage):

    node sim/sim.mjs --help                                     # every flag, variant and constant
    node sim/sim.mjs --games=200 --players=3 --bots=medium      # a 3-player Medium run
    node sim/sim.mjs --games=100 --players=2 --bots=hard,medium # Hard in seat 0 against Medium
    node sim/sim.mjs --list                                     # every --variant. and --const. flag
    node sim/sim-report-html.mjs <run.json> [more.json ...]     # a self-contained HTML report

Output files go to the system temp directory and are never overwritten (`-v2`, `-v3` are added). Rule variants and tuning numbers can be changed at run time (`--variant.queueCapacity=rulebook`, `--const.COSTS.COST_MOVE_2=2`) without touching `src/`. Always run with the default jitter when quoting seat win rates. The record format is in `sim/SCHEMA.md`.

### Replay a game record

The end screen has a "Download game record" button. The file holds the rules version, variants, seed, seats and every action taken. To replay one headlessly and check it reproduces the scores shown:

    node tools/replay.mjs path/to/superfans-game-record-12345.json

Exit code 0 means the replay matches the record.

### Release settings

`src/ui/config.js` holds the values only the owner can supply. An empty value switches its feature off:

- `GA4_MEASUREMENT_ID` - the Google Analytics 4 id (`G-XXXXXXXXXX`), set. Empty: no analytics script is loaded and nothing is sent. Local addresses (`localhost`, `127.0.0.1`, `file:`) never send, so local play and the tests stay out of the figures; add `?ga_debug=1` to the address to send from a local run and watch the events in GA4 DebugView.
- `COOKIEYES_ID` - the CookieYes site id for the cookie banner (`src/ui/consent.js`). Set: on the published site the banner loads and analytics waits until the visitor accepts the Analytics category (events from before the choice are held, then sent or dropped); the landing page footer gets a "Cookie settings" link. Empty: no banner. The banner never loads on a local address.
- `BUG_REPORT_EMAIL` - where the "Email this report" link in the Report a problem dialog goes. Empty: the email link is hidden (the report can still be downloaded).
- `VERSION` - shown in game records and analytics.

The address assumed in the page's social-sharing tags (`og:url` in `index.html`) is `https://www.wombatgamefactory.com/superfans-game/`; change it there if the game is published elsewhere. There is no consent banner in the game itself: add one on the host page before switching analytics on where the law requires it.

### How it fits together

- `index.html`, `style.css` - the page and the design tokens (colours, type, components).
- `src/engine/` - the rules, pure JavaScript with no DOM, no clock and no `Math.random`. State is plain JSON. The public face is `src/engine/index.js`: `createGame`, `getValidActions`, `applyAction`, `describeAction`, `scoreGame`, `isGameOver`. The engine is a decision stack: `getValidActions(state)` lists every legal next step for `state.toAct`, a decision with only one option is applied automatically, and events are returned by `applyAction` rather than stored. Rules that vary are in the `VARIANTS` table (`variants.js`); tuning numbers are objects in `rules.js` read through one accessor, so a saved game replays under the rules it was played with. Rule numbers (`R7.3`) are cited in comments and test names.
- `src/bots/` - pure bot players. `randomBot.js`; `heuristicBot.js` (Easy and Medium: plan from the state at each decision and score every legal action); `mctsBot.js` (Hard: paired samples over Medium's best candidates, played to the end of the Hour). `bot-worker.js` runs Hard in a Web Worker in the browser; in Node it runs inline.
- `src/ui/` - the browser interface, rendered from the engine state with delegated event listeners. `main.js` is the game flow; `setup.js` the landing page; `board-render.js`, `panels.js`, `walk.js` and `end-screen.js` draw the table; `action-targets.js` is the one place that maps clicks to legal actions; `ui-state.js` the pending-action machine; `bot-driver.js` paces bot turns. Analytics (`analytics.js`), end-screen stats (`stats.js`, which reuses `sim/metrics.mjs`), the game record (`record.js`), play history (`history.js`) and the bug reporter (`bug-report-*.js`) hang off hooks. The published site must therefore include `sim/` as well as `src/`.
- `sim/` - the headless simulator and its reports.
- `assets/` - web-sized art (each file 200 KB or less) with `manifest.json`, which lists every image with its size, status and use. The UI asks for art by manifest id. `tools/validate-assets.mjs` checks the manifest against the files; `tools/build-assets.py` regenerates the art from the print sources (only possible with the full design folder).
- `tests/` - the suites; `tests/qa/sweep.mjs` is the pre-publication sweep (local paths, e-mail addresses, secrets, internal document names, files over 1 MB) and `tests/qa/references.mjs` checks that every file reference matches the real file name letter for letter.
- `design/` - static mock-ups and the component gallery for the visual design (open `design/mockups.html`).

Files are plain ES modules; there is no bundler. Game files must be served with the exact case used in the code, because GitHub Pages is case-sensitive.

## Credits

Game design and art direction by Dean Morris, Wombat Game Factory. Browser version built for Wombat Game Factory.

## Licence

Copyright (c) 2026 Dean Morris / Wombat Game Factory. All rights reserved. See `LICENSE`.
