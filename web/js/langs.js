// The 30 supported languages, and how a system language list maps onto them.
// Shared by the web page and the Electron shell (the macOS app repeats the same rules in Swift).
// [code, name in its own language, BCP-47 tag for dates and numbers, right-to-left]
export const LANGS = [
  ['en', 'English', 'en-US'],
  ['zh-Hant', '繁體中文', 'zh-TW'],
  ['zh-Hans', '简体中文', 'zh-CN'],
  ['ja', '日本語', 'ja-JP'],
  ['ko', '한국어', 'ko-KR'],
  ['fr', 'Français', 'fr-FR'],
  ['es', 'Español', 'es-ES'],
  ['de', 'Deutsch', 'de-DE'],
  ['it', 'Italiano', 'it-IT'],
  ['pt', 'Português', 'pt-BR'],
  ['ru', 'Русский', 'ru-RU'],
  ['uk', 'Українська', 'uk-UA'],
  ['pl', 'Polski', 'pl-PL'],
  ['cs', 'Čeština', 'cs-CZ'],
  ['nl', 'Nederlands', 'nl-NL'],
  ['sv', 'Svenska', 'sv-SE'],
  ['da', 'Dansk', 'da-DK'],
  ['nb', 'Norsk bokmål', 'nb-NO'],
  ['fi', 'Suomi', 'fi-FI'],
  ['hu', 'Magyar', 'hu-HU'],
  ['ro', 'Română', 'ro-RO'],
  ['el', 'Ελληνικά', 'el-GR'],
  ['tr', 'Türkçe', 'tr-TR'],
  ['ar', 'العربية', 'ar', true],
  ['he', 'עברית', 'he-IL', true],
  ['hi', 'हिन्दी', 'hi-IN'],
  ['th', 'ไทย', 'th-TH'],
  ['vi', 'Tiếng Việt', 'vi-VN'],
  ['id', 'Bahasa Indonesia', 'id-ID'],
  ['ms', 'Bahasa Melayu', 'ms-MY'],
];

export const CODES = LANGS.map((l) => l[0]);
const ALIAS = { no: 'nb', nn: 'nb', iw: 'he', in: 'id' };

/** One system language tag (zh-TW, pt-PT, no, …) -> a supported code, or null. */
export function matchTag(tag) {
  const parts = String(tag || '').replace(/_/g, '-').toLowerCase().split('-');
  let p = ALIAS[parts[0]] || parts[0];
  if (p === 'zh') return parts.some((x) => ['hant', 'tw', 'hk', 'mo'].includes(x)) ? 'zh-Hant' : 'zh-Hans';
  if (p === 'nb' || p === 'nn') p = 'nb';
  return CODES.find((c) => c.toLowerCase() === p) || null;
}

/** The first supported language in the system's preference order; English when none is. */
export function pickLang(tags) {
  for (const t of tags || []) { const c = matchTag(t); if (c) return c; }
  return 'en';
}

export const langInfo = (code) => LANGS.find((l) => l[0] === code) || LANGS[0];
