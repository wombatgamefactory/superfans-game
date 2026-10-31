// config.js - values filled in by the designer at release.
// An EMPTY value switches its feature off: no analytics request is made and no
// bug-report email link is shown.
// Analytics never sends from a local address (localhost, 127.0.0.1, file:) unless
// the page has ?ga_debug=1, so local play and the test suite do not reach GA.

export const CONFIG = {
  /** GA4 measurement id ("G-XXXXXXXXXX"). Empty: analytics is inert. Set 31/10/2026. */
  GA4_MEASUREMENT_ID: 'G-MR6BSY8BC6',
  /** Where "Email this report" goes. Empty: the mailto link is hidden. */
  BUG_REPORT_EMAIL: '',
  VERSION: '0.1.0',
};
