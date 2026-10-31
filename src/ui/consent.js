// consent.js - cookie consent for analytics, through the CookieYes banner that
// Wombat Game Factory already uses on its other games.
//
// While CONFIG.COOKIEYES_ID is set, analytics.js asks analyticsConsent() before
// every send:
//   'granted'  the visitor accepted the Analytics category: send
//   'unknown'  no choice yet (or the banner has not loaded): hold the event
//   'denied'   the visitor rejected it: drop the event
// With COOKIEYES_ID empty there is no banner and consent is treated as granted.
//
// The banner script is only loaded on the published site, never on a local
// address, so local play and the test suite make no request to CookieYes.
//
// CookieYes API used: window.getCkyConsent() -> { categories: { analytics }, isUserActionCompleted },
// the document events 'cookieyes_banner_load' and 'cookieyes_consent_update'
// (detail.accepted / detail.rejected), window.revisitCkyConsent() and the
// 'cky-banner-element' class, which opens the preferences from any link.

import { CONFIG } from './config.js';

const listeners = new Set();
let wired = false;

/** Whether a consent banner is configured. */
export function consentRequired() {
  return typeof CONFIG.COOKIEYES_ID === 'string' && CONFIG.COOKIEYES_ID.trim() !== '';
}

/** 'granted' | 'unknown' | 'denied' for the Analytics category. Never throws. */
export function analyticsConsent() {
  if (!consentRequired()) return 'granted';
  try {
    if (typeof window === 'undefined' || typeof window.getCkyConsent !== 'function') return 'unknown';
    const c = window.getCkyConsent();
    if (c && c.categories && c.categories.analytics === true) return 'granted';
    if (c && c.isUserActionCompleted) return 'denied';
    return 'unknown';
  } catch {
    return 'unknown';
  }
}

/** Calls fn(state) whenever the visitor's choice is known or changes. Returns an unsubscribe function. */
export function onConsentChange(fn) {
  listeners.add(fn);
  wire();
  return () => listeners.delete(fn);
}

function wire() {
  if (wired || typeof document === 'undefined') return;
  wired = true;
  const fire = (event) => {
    let state = analyticsConsent();
    // The update event says what was just chosen; trust it over a stale getCkyConsent().
    const d = event && event.detail;
    if (d && Array.isArray(d.accepted) && d.accepted.includes('analytics')) state = 'granted';
    else if (d && Array.isArray(d.rejected) && d.rejected.includes('analytics')) state = 'denied';
    for (const f of listeners) {
      try {
        f(state);
      } catch {
        // a listener must not break the others
      }
    }
  };
  document.addEventListener('cookieyes_banner_load', fire);
  document.addEventListener('cookieyes_consent_update', fire);
}

/** Adds the CookieYes script (once) on the published site. Returns true when it is on the page. */
export function loadConsentBanner({ local }) {
  try {
    if (!consentRequired() || local || typeof document === 'undefined') return false;
    if (document.getElementById('cookieyes')) return true;
    const s = document.createElement('script');
    s.id = 'cookieyes';
    s.src = `https://cdn-cookieyes.com/client_data/${encodeURIComponent(CONFIG.COOKIEYES_ID.trim())}/script.js`;
    document.head.prepend(s);
    wire();
    return true;
  } catch {
    return false;
  }
}

/** Opens the cookie preferences again (the "Cookie settings" link). */
export function openCookieSettings() {
  try {
    if (typeof window !== 'undefined' && typeof window.revisitCkyConsent === 'function') window.revisitCkyConsent();
  } catch {
    // nothing to do: the banner is not on this page
  }
}

/** For tests: forget the wiring so a fresh page state can be simulated. */
export function _resetConsentForTests() {
  listeners.clear();
  wired = false;
}
