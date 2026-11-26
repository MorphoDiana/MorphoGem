// MorphoGem Clean-Room Bilingual Helper (Simplified Chinese zh-CN & English en ONLY)

const STORAGE_KEY = 'morphogem.locale';
export const SUPPORTED_LOCALES = Object.freeze(['zh-CN', 'en']);

export function normalizeLocale(raw) {
  const s = String(raw || '').trim().toLowerCase();
  if (s.startsWith('en')) return 'en';
  return 'zh-CN';
}

let currentLocale = (() => {
  try {
    const saved = globalThis.localStorage?.getItem(STORAGE_KEY);
    if (saved) return normalizeLocale(saved);
    const nav = globalThis.navigator?.language || 'zh-CN';
    return normalizeLocale(nav);
  } catch {
    return 'zh-CN';
  }
})();

const listeners = new Set();

export function getLocale() {
  return currentLocale;
}

export function isEn() {
  return currentLocale === 'en';
}

export function setLocale(next) {
  const norm = normalizeLocale(next);
  if (norm === currentLocale) return currentLocale;
  currentLocale = norm;
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, currentLocale);
    if (globalThis.document?.documentElement) {
      globalThis.document.documentElement.lang = currentLocale;
    }
  } catch {
    // ignore in Node CLI context
  }
  for (const fn of listeners) {
    try { fn(currentLocale); } catch { /* ignore */ }
  }
  if (typeof globalThis.dispatchEvent === 'function' && typeof CustomEvent === 'function') {
    globalThis.dispatchEvent(new CustomEvent('morphogem-locale-change', {detail: currentLocale}));
  }
  return currentLocale;
}

export function onLocaleChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function tr(zhText, enText, locale = currentLocale) {
  return normalizeLocale(locale) === 'en' ? enText : zhText;
}
