// art.js - the ONE place that knows where an image lives.
//
// Everything else asks for a picture by manifest id ("hall-main-hall",
// "token-crew-blue", "card-swag-green-04"); this module loads
// assets/manifest.json, resolves the id to a URL and returns markup. Nothing
// else in src/ui contains an image path (style.css refers to a few UI plates
// by URL, which is CSS and not script).
//
// Guarded fallback: an id that is not in the manifest, or a file that fails to
// load, becomes a small text chip instead of a broken-image icon.

const ASSET_ROOT = 'assets/';
const MANIFEST_URL = `${ASSET_ROOT}manifest.json`;

/** id -> manifest entry. Filled by loadArt(). */
const entries = new Map();

/** Fetches the manifest. Resolves even when it fails (every id then falls back to a chip). */
export async function loadArt() {
  try {
    const res = await fetch(MANIFEST_URL, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    const list = Array.isArray(json) ? json : json.assets;
    entries.clear();
    for (const entry of list) entries.set(entry.id, entry);
    return { ok: true, count: entries.size };
  } catch (err) {
    return { ok: false, count: 0, error: String(err) };
  }
}

/** Whether the manifest knows this id. */
export function hasArt(id) {
  return entries.has(id);
}

/** The URL of an id, or null. */
export function artUrl(id) {
  const e = entries.get(id);
  return e ? ASSET_ROOT + e.file : null;
}

export function escapeHtml(text) {
  return String(text ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

/** A text stand-in for a picture. */
export function chip(label, cls = '') {
  return `<span class="sf-artchip ${cls}">${escapeHtml(label)}</span>`;
}

/**
 * An <img> for a manifest id, or a chip when the id is unknown.
 * @param {string} id manifest id
 * @param {{ cls?: string, alt?: string, label?: string, title?: string, style?: string }} [opts]
 */
export function art(id, opts = {}) {
  const url = id ? artUrl(id) : null;
  const alt = opts.alt ?? opts.label ?? '';
  if (url === null) return chip(opts.label ?? opts.alt ?? String(id ?? '?'), opts.cls ?? '');
  const title = opts.title ? ` title="${escapeHtml(opts.title)}"` : '';
  const style = opts.style ? ` style="${escapeHtml(opts.style)}"` : '';
  return `<img class="${opts.cls ?? ''}" src="${url}" alt="${escapeHtml(alt)}" data-art-id="${escapeHtml(id)}" data-art-label="${escapeHtml(opts.label ?? opts.alt ?? id)}" decoding="async" draggable="false"${title}${style}>`;
}

/** Swaps any picture that fails to load for a text chip. Call once; the error event does not bubble. */
export function installArtFallback(root = document) {
  root.addEventListener(
    'error',
    (event) => {
      const el = event.target;
      if (!(el instanceof HTMLImageElement) || !el.dataset.artId) return;
      const span = document.createElement('span');
      span.className = `sf-artchip ${el.className}`;
      span.textContent = el.dataset.artLabel || el.dataset.artId;
      el.replaceWith(span);
    },
    true,
  );
}

// ---- named helpers (ids live here, nowhere else) ---------------------------------

export const ICON = Object.freeze({
  coffee: 'icon-coffee',
  trophy: 'icon-trophy',
  star: 'icon-star',
  vp: 'icon-vp',
  gift: 'icon-gift',
  rest: 'icon-rest',
  cross: 'icon-cross',
  tick: 'icon-tick',
  footprints: 'icon-footprints',
  moveArrows: 'icon-move-arrows',
  noob: 'icon-badge-noob',
  vip: 'icon-badge-vip',
  aaa: 'icon-badge-aaa',
  volunteer: 'icon-volunteer',
  usher: 'icon-usher',
  security: 'icon-security',
  photographer: 'icon-photographer',
  stopwatch: 'icon-hour-stopwatch',
  selfie: { green: 'icon-selfie-green', red: 'icon-selfie-red', orange: 'icon-selfie-orange' },
});

/** The meeple token of a player colour. */
export function crewArt(colour) {
  return `token-crew-${colour}`;
}

/** The meeple with its badge overlays, sized by the surrounding CSS (board cqw, or `px` for off-board). */
export function crewPiece(colour, badge, { px = false, label = '', cls = '', target = '', attrs = '' } = {}) {
  const b = badge === 'AAA' ? 'aaa' : badge === 'VIP' ? 'vip' : 'noob';
  const hat = b !== 'noob' ? art('overlay-vip-hat', { cls: 'sf-crew__hat', alt: '' }) : '';
  const box = b === 'aaa' ? art('overlay-aaa-box', { cls: 'sf-crew__box', alt: '' }) : '';
  const attr = target ? ` data-target="${escapeHtml(target)}"` : '';
  return `<span class="sf-crew sf-crew--${b}${px ? ' sf-crew--px' : ''} ${cls}"${attr}${attrs ? ` ${attrs}` : ''}${label ? ` title="${escapeHtml(label)}"` : ''}>${box}${art(crewArt(colour), { cls: 'sf-crew__body', alt: '' })}${hat}</span>`;
}

export const SELFIE_COLOURS = Object.freeze(['green', 'red', 'orange']);
export const SYMBOL_WORD = Object.freeze({ green: 'thumbs-up', red: 'heart', orange: 'star' });
