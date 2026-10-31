// how-to-play.js - the plain-English rules (T17).
//
// Hand-written from rules-spec/superfans-rules-spec-v2.md (the rules of record
// for the code, 31/10/2026), with every number read from the engine's
// constants so the page can never disagree with the game. Rule numbers are in
// the comments, not on the page. Shared by the landing page ("How to play")
// and the in-game Rules modal.
//
// Rule book v1 (24/07/2026) is NOT linked: Dean's 31/10/2026 rulings changed
// the queue capacity (now 4/6/7/7) and named the centre hall Main Hall.

import { RULES, CAPACITY } from '../engine/index.js';
import { art, ICON } from './art.js';

const coffee = (n) => `${n} coffee`;

/**
 * @param {object} [opts]
 * @param {object} [opts.K]        engine constants (getConstants(state)); defaults to RULES
 * @param {object} [opts.variants] the game's variants, to show the queue sizes in use
 * @param {number} [opts.players]  player count of the game in progress, to mark its column
 * @returns {string} HTML
 */
export function howToPlayHtml({ K = RULES, variants = null, players = null } = {}) {
  const C = K.COSTS;
  const P = K.PASS;
  const X = K.EXCHANGE;
  const capKey = variants && variants.queueCapacity ? variants.queueCapacity : 'printed-board';
  const cap = (K.CAPACITY || CAPACITY).QUEUE_CAPACITY[capKey];
  const capCells = [2, 3, 4, 5].map((n) => `<td${players === n ? ' class="is-now"' : ''}>${cap[n]}</td>`).join('');
  const capHead = [2, 3, 4, 5].map((n) => `<th scope="col"${players === n ? ' class="is-now"' : ''}>${n}</th>`).join('');
  const S = K.SUPPLY;
  const startCoffee = K.START.START_COFFEE;
  const capCoffee = K.LIMITS.COFFEE_CAP;
  const ladder = P.PASS_SLOT_REWARD;
  const fin = K.FINAL;
  const mult = K.ACHIEVEMENTS.ACHIEVEMENT_FINAL_MULTIPLIER;

  const action = (icon, name, cost, text) =>
    `<li class="sf-htp__act"><span class="sf-htp__acticon">${art(icon, { alt: '' })}</span><span><b>${name}</b> <span class="sf-htp__cost">${cost}</span><br>${text}</span></li>`;

  return `<div class="sf-htp">
  <nav class="sf-htp__toc" aria-label="How to play contents">
    <a href="#htp-goal">Goal</a><a href="#htp-setup">Setup</a><a href="#htp-hour">An Hour</a><a href="#htp-actions">Actions</a><a href="#htp-queues">Queues</a><a href="#htp-selfies">Selfies</a><a href="#htp-pass">Passing</a><a href="#htp-walk">The Walk</a><a href="#htp-ach">Achievements</a><a href="#htp-end">The end</a>
  </nav>

  <section id="htp-goal">
    <h3>The goal</h3>
    <p>You run a fan club at a busy convention. Over <b>five Hours</b> you move your Crew between nine halls, queue for the celebrities, take selfies, buy swag and complete Achievements. Whoever has the most victory points (VP) after Hour 5 wins.</p>
  </section>

  <section id="htp-setup">
    <h3>Setup</h3>
    <ul>
      <li>Each fan club has ${S.CREW_PER_PLAYER} Crew (all start as <b>N00bs</b>), ${S.HATS_PER_PLAYER} VIP hats, ${S.BOXES_PER_PLAYER} AAA box and ${S.VOLUNTEERS_PER_PLAYER} Volunteers, plus <b>${coffee(startCoffee)}</b> and <b>3 Selfies</b> (one green, one red, one orange).</li>
      <li>Everyone gets one <b>Club</b> card, face up, with its own power, and <b>2 secret Achievements</b>.</li>
      <li>Six celebrities are scheduled: two rank A stars for Hours 1 and 2, two rank B for Hours 3 and 4, and two rank C who <b>both</b> walk in Hour 5. Each celebrity has a colour (green, red or orange), shown on the schedule from the start.</li>
      <li>The celebrities of Hours 1-3 stand on their start halls, with a marker on the hall where they will finish. Five Swag cards are dealt face up.</li>
      <li>The doors open: in reverse turn order, everyone puts 2 N00bs into the <b>Entrance</b>. The first player acts first but queues last.</li>
    </ul>
    <p>The board is a 3 by 3 grid of halls joined by velvet ropes (no diagonals). Each hall's queue holds a limited number of Crew:</p>
    <table class="sf-htp__table"><thead><tr><th scope="row">Players</th>${capHead}</tr></thead><tbody><tr><th scope="row">Crew per hall</th>${capCells}</tr></tbody></table>
    <p class="sf-htp__fine">With 4 or 5 players the Entrance starts over-full; it counts as full until enough Crew have left.</p>
  </section>

  <section id="htp-hour">
    <h3>An Hour</h3>
    <ol>
      <li><b>Coffee Break.</b> Everyone gains coffee equal to the number on this Hour's celebrity card (in Hour 5, both cards added together). Coffee never goes above ${capCoffee}; anything over is lost.</li>
      <li><b>On the Floor.</b> Starting with the first player and going clockwise, take turns. On your turn you may make any free Selfie trades, then take <b>one</b> action. Keep going round until everyone has passed.</li>
      <li><b>Celebrity Walk.</b> This Hour's celebrity walks its route, hands out selfies and scores the queue where it stops. Then the first player marker moves one seat clockwise.</li>
    </ol>
  </section>

  <section id="htp-actions">
    <h3>Actions</h3>
    <p>Pay the full cost first; you can repeat an action on later turns as often as you can afford it.</p>
    <ul class="sf-htp__acts">
      ${action(ICON.footprints, 'Move 2', coffee(C.COST_MOVE_2), 'Move one Crew up to 2 halls.')}
      ${action(ICON.moveArrows, 'Move 1 Crew x3', coffee(C.COST_MOVE_3_CREW), 'Up to three different Crew each move 1 hall, one after another.')}
      ${action(ICON.noob, 'New N00b', coffee(C.COST_NEW_NOOB), 'A new Crew joins the Entrance (or a hall next to it if the Entrance is full, or else any hall with room).')}
      ${action(ICON.vip, 'Upgrade', coffee(C.COST_UPGRADE), 'N00b to VIP (uses a hat) or VIP to AAA (uses your box). Badges are permanent.')}
      ${action(ICON.volunteer, 'Volunteer', coffee(C.COST_VOLUNTEER), 'Put a Volunteer on any empty space: an <b>Usher</b> on a rope, <b>Security</b> or a <b>Photographer</b> in a hall. Volunteers stay all game.')}
      ${action(ICON.photographer, 'Take a Selfie', coffee(C.COST_TAKE_SELFIE), 'Gain 1 Selfie in the colour of a celebrity standing in a hall where you have a Crew.')}
      ${action(ICON.gift, 'Swag', 'selfies, no coffee', 'Take a market card, pay its price in Selfies of its colour, and do what it says at once.')}
      ${action(ICON.star, 'Club Power', 'as the card', 'Use your Club’s power: usually once an Hour, as your action.')}
      ${action(ICON.rest, 'Pass', 'free', 'Stop taking actions this Hour (see Passing).')}
    </ul>
    <p><b>Volunteers at work.</b> <b>Usher:</b> +${K.MOVEMENT.USHER_COFFEE_PER_CROSSING} coffee each time your own Crew steps across that rope. <b>Security:</b> your Crew stand in front of others with the same badge in that hall. <b>Photographer:</b> a Selfie every time a walking celebrity enters that hall.</p>
  </section>

  <section id="htp-queues">
    <h3>Queues and Prime Position</h3>
    <ul>
      <li>Each hall's queue is sorted by <b>badge</b> (AAA, then VIP, then N00b), then <b>Security</b>, then <b>who arrived first</b>. A Crew that moves in or is upgraded joins the back of its badge group.</li>
      <li>The front spot is <b>Prime Position</b>.</li>
      <li>A full hall is a wall: no Crew can enter it or move through it. Leaving is always allowed.</li>
    </ul>
  </section>

  <section id="htp-selfies">
    <h3>Selfies and the Selfie Exchange</h3>
    <p>Selfies come in three colours: green (thumbs-up), red (heart) and orange (star). There is no limit on how many you hold. Free trades, as often as you like on your turn:</p>
    <ul>
      <li>${X.EXCHANGE_E1.PAY} Selfies → ${X.EXCHANGE_E1.GAIN_COFFEE} coffee</li>
      <li>${X.EXCHANGE_E2.PAY} Selfies → ${X.EXCHANGE_E2.GAIN_SELFIES} Selfie of a different colour</li>
      <li>${X.EXCHANGE_E3.PAY} Selfies → ${X.EXCHANGE_E3.GAIN_VP} VP</li>
    </ul>
  </section>

  <section id="htp-pass">
    <h3>Passing</h3>
    <ul>
      <li>The <b>first</b> player to pass this Hour gains ${coffee(P.PASS_FIRST_PASSER_COFFEE)}.</li>
      <li>When you pass, choose one of your Achievements and either <b>score</b> it now or <b>bin</b> it for ${coffee(P.PASS_DISCARD_COFFEE)}. Then draw a new one (not in Hour 5).</li>
      <li>After passing you still take turns: each one moves your marker up the Pass card for ${ladder[2]}, then ${ladder[3]}, then ${ladder[4]} (and ${ladder[4]} again every later turn) coffee <b>or</b> VP, your choice.</li>
      <li>When everyone has passed, the queues are locked and the Walk begins.</li>
    </ul>
  </section>

  <section id="htp-walk">
    <h3>The Celebrity Walk and scoring</h3>
    <ul>
      <li>The celebrity moves along its route one hall at a time. In every hall it <b>enters</b> (not the start hall): whoever has Prime Position gains a Selfie of its colour, and so does the owner of that hall's Photographer.</li>
      <li>At the destination the <b>whole queue</b> scores, by the method on the card: <b>Everyone</b> (each Crew scores the same), <b>by badge</b> (N00b, VIP and AAA values), <b>No N00bs</b> (N00bs score nothing), <b>Score in Order</b> (1st, 2nd, 3rd... in the queue score the listed values) or <b>Count total</b> (everyone scores by how crowded the hall is).</li>
      <li>The celebrity then leaves, and the next scheduled celebrity takes its figure and colour. In Hour 5 both celebrities walk, taking turns step by step.</li>
    </ul>
  </section>

  <section id="htp-ach">
    <h3>Achievements</h3>
    <p>You always hold 2 secret Achievements. Each says what it counts (Crew in corner halls, Volunteers, Selfies...). When it scores, count it on the board right now and multiply by its laurel number. Achievements score only when you pass, through a few Swag cards, and at the end.</p>
  </section>

  <section id="htp-end">
    <h3>The end of the convention</h3>
    <ul>
      <li>The game ends when both Hour 5 celebrities have scored.</li>
      <li>You may make last Selfie trades, then score your last Achievement at <b>x${mult}</b>.</li>
      <li>Leftover Selfies: every ${fin.FINAL_SELFIES_PER_EXCHANGE} score ${fin.FINAL_VP_PER_EXCHANGE} VP. Leftover coffee scores nothing.</li>
      <li>Most VP wins. A tie goes to the tied player who comes first clockwise from the Hour 5 first player.</li>
    </ul>
  </section>
</div>`;
}
