// i18n: 30 languages, one JSON file each in web/locales/. English is always loaded as the fallback.
import { LANGS, CODES, pickLang, langInfo } from './langs.js';
export { LANGS };

let DICT = {};   // active language
let EN = {};     // fallback
let lang = 'en';

const load = (code) => fetch(`locales/${code}.json`, { cache: 'no-cache' }).then((r) => r.json());

// ?lang=xx wins, then the saved choice, then the system language list; English if none is supported
function initialLang() {
  const q = new URLSearchParams(location.search).get('lang');
  if (q && CODES.includes(q)) return q;
  try {
    const s = localStorage.getItem('farm.lang');
    if (s === 'zh') return 'zh-Hant';  // saved by older versions
    if (s && CODES.includes(s)) return s;
  } catch { /* storage blocked */ }
  return pickLang(navigator.languages?.length ? navigator.languages : [navigator.language]);
}

export async function initI18n() {
  lang = initialLang();
  EN = await load('en');
  DICT = lang === 'en' ? EN : await load(lang).catch(() => { lang = 'en'; return EN; });
  setLang(lang, false);
}

export function getLang() { return lang; }
export const getLocale = () => langInfo(lang)[2];

export async function setLang(l, save = true) {
  if (l !== lang || !Object.keys(DICT).length) {
    DICT = l === 'en' ? EN : await load(l).catch(() => EN);
    lang = DICT === EN ? 'en' : l;
  }
  if (save) { try { localStorage.setItem('farm.lang', lang); } catch { /* ignore */ } }
  const info = langInfo(lang);
  document.documentElement.lang = lang === 'zh-Hant' ? 'zh-Hant' : lang === 'zh-Hans' ? 'zh-Hans' : lang;
  document.documentElement.dir = info[3] ? 'rtl' : 'ltr';
  applyStatic();
}

export function t(key, vars) {
  let s = DICT[key] ?? EN[key] ?? key;
  if (vars && typeof s === 'string') for (const [k, v] of Object.entries(vars)) s = s.replaceAll(`{${k}}`, v);
  return s;
}

// name of an animal (fox, cat…) in the current language
export const animalLabel = (id) => DICT.animals?.[id] ?? EN.animals?.[id] ?? '';

export function applyStatic() {
  document.querySelectorAll('[data-i18n]').forEach((el) => { el.innerHTML = t(el.dataset.i18n); });
  document.querySelectorAll('[data-i18n-title]').forEach((el) => {
    el.title = t(el.dataset.i18nTitle);
    el.setAttribute('aria-label', el.title);
  });
}

export function ago(ms, now = Date.now()) {
  const d = Math.max(0, now - ms);
  if (d < 45e3) return t('just_now');
  if (d < 3600e3) return t('min_ago', { n: Math.round(d / 60e3) });
  if (d < 86400e3) return t('hr_ago', { n: Math.round(d / 3600e3) });
  return t('day_ago', { n: Math.round(d / 86400e3) });
}

export function fmtNum(n) {
  if (!n) return '0';
  if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'k';
  return String(n);
}
