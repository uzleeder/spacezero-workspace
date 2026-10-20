'use strict';

// SpaceZero is a DARK-first product: everyone, on every page (sign-in, error pages, the app), starts in dark mode.
// Light mode is only used by a person who chose it with the sun/moon button - that choice is remembered in a cookie
// and wins from then on. One place decides, so no page can quietly fall back to light.
const THEME_COOKIE = 'sz_theme';
const DEFAULT_THEME = 'dark';

/** 'light' only when this browser explicitly chose light; otherwise dark. */
function themeFor(req) {
  const chosen = req && req.cookies ? req.cookies[THEME_COOKIE] : undefined;
  return chosen === 'light' ? 'light' : DEFAULT_THEME;
}

module.exports = { THEME_COOKIE, DEFAULT_THEME, themeFor };
