// Translations. The English text is the key: t('Hide completed') looks the
// sentence up in the chosen language's dictionary (renderer/locales/<id>.js)
// and falls back to the English. Dynamic parts are named placeholders:
//   t('Leaves {date}', { date })
//   tn(count, '{n} game', '{n} games')      plurals, by the language's rules
//   tEl('See {link} for more.', { link: node })   for text around elements
// The window and the main process (tray menu, notifications) share it.
(function (root) {
  const LANGS = [
    { id: 'en', name: 'English' },
    { id: 'fr', name: 'Français' },
    { id: 'de', name: 'Deutsch' },
    { id: 'it', name: 'Italiano' },
    { id: 'pt-BR', name: 'Português (Brasil)' },
    { id: 'ja', name: '日本語' },
    { id: 'ko', name: '한국어' },
  ];
  // Filled by the locale files: dictionaries[id] = { 'English': 'Translated', ... }.
  const dictionaries = root.SubscrollLocales || (root.SubscrollLocales = {});
  let lang = 'en';
  let dict = {};
  let rules = new Intl.PluralRules('en');

  // 'fr-CA' -> 'fr', 'pt-PT' -> 'pt-BR' (the only Portuguese), unknown -> 'en'.
  function pick(wanted) {
    const w = String(wanted || '').trim();
    if (!w || w === 'auto') return null;
    const exact = LANGS.find((l) => l.id.toLowerCase() === w.toLowerCase());
    if (exact) return exact.id;
    const base = w.toLowerCase().split(/[-_]/)[0];
    const same = LANGS.find((l) => l.id.toLowerCase().split('-')[0] === base);
    return same ? same.id : 'en';
  }

  // setting: a language id, or 'auto' to follow the system (systemLangs: navigator.languages or app.getPreferredSystemLanguages()).
  function setLanguage(setting, systemLangs = []) {
    lang = pick(setting) || systemLangs.map(pick).find((x) => x && x !== 'en') || 'en';
    dict = dictionaries[lang] || {};
    try {
      rules = new Intl.PluralRules(lang);
    } catch {
      rules = new Intl.PluralRules('en');
    }
    return lang;
  }

  const fill = (text, params) => (params ? String(text).replace(/\{(\w+)\}/g, (m, k) => (k in params ? String(params[k]) : m)) : String(text));

  function t(text, params) {
    const found = dict[text];
    return fill(typeof found === 'string' && found ? found : text, params);
  }

  // Plurals: the dictionary holds { one, other, few, many, ... } under "one|other".
  function tn(n, one, other, params = {}) {
    const all = { n, ...params };
    const found = dict[`${one}|${other}`];
    if (typeof found === 'string' && found) return fill(found, all);
    if (found && typeof found === 'object') {
      const form = found[rules.select(n)] || found.other;
      if (form) return fill(form, all);
    }
    return fill(n === 1 ? one : other, all);
  }

  // Text with elements in it: an array of strings and nodes for el().
  function tEl(text, params = {}) {
    const out = [];
    const s = t(text);
    let last = 0;
    for (const m of s.matchAll(/\{(\w+)\}/g)) {
      if (!(m[1] in params)) continue;
      if (m.index > last) out.push(s.slice(last, m.index));
      out.push(params[m[1]]);
      last = m.index + m[0].length;
    }
    if (last < s.length) out.push(s.slice(last));
    return out;
  }

  // Marks a string as a key without translating it, for lists defined before
  // the language is known; translate it with t() where it's shown.
  const tk = (text) => text;

  // Static text in index.html: data-i18n (the element's text), data-i18n-title,
  // data-i18n-placeholder and data-i18n-aria-label (those attributes). The
  // English is kept on the element, so switching language again works.
  function translatePage(doc) {
    for (const node of doc.querySelectorAll('[data-i18n]')) {
      if (!node.dataset.i18nKey) node.dataset.i18nKey = node.textContent.trim();
      node.textContent = t(node.dataset.i18nKey);
    }
    for (const attr of ['title', 'placeholder', 'aria-label']) {
      for (const node of doc.querySelectorAll(`[data-i18n-${attr}]`)) {
        const key = `i18nKey${attr.replace(/(^|-)(\w)/g, (m, d, c) => c.toUpperCase())}`;
        if (!node.dataset[key]) node.dataset[key] = node.getAttribute(attr) || '';
        node.setAttribute(attr, t(node.dataset[key]));
      }
    }
  }

  const api = { LANGS, setLanguage, t, tn, tEl, tk, translatePage, pick, language: () => lang, locale: () => lang, dictionaries };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.I18n = api;
})(typeof window !== 'undefined' ? window : globalThis);
