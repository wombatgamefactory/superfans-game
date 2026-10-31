# Superfans

Browser version of the Superfans board game. Pure JavaScript, no build step, served by GitHub Pages.

## Run

    npm install
    npm run dev        # serves http://localhost:8080

## Test

    npm test           # runs every tests/*.test.mjs

## Layout

- `index.html`, `style.css` - the page and design tokens
- `src/engine/` - pure game rules (no DOM)
- `src/bots/` - pure bot players
- `src/ui/` - browser interface; `config.js` holds release settings (empty values switch features off)
- `sim/` - headless simulation
- `tests/` - test suites
- `assets/` - web-sized runtime art
