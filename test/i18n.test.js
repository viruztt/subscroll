const test = require('node:test');
const assert = require('node:assert');
const I18n = require('../renderer/i18n');
const dictionaries = require('../renderer/locales');
const { collect } = require('../scripts/i18n-keys');

test('i18n: languages, plurals, placeholders and fallbacks', () => {
  I18n.dictionaries.xx = { Hello: 'Bonjour', '{n} game|{n} games': { one: '{n} jeu', other: '{n} jeux' }, 'See {link}.': 'Voir {link}.' };
  I18n.LANGS.push({ id: 'xx', name: 'Test' });
  assert.strictEqual(I18n.setLanguage('xx'), 'xx');
  assert.strictEqual(I18n.t('Hello'), 'Bonjour');
  assert.strictEqual(I18n.t('Not translated {x}', { x: 1 }), 'Not translated 1');
  assert.strictEqual(I18n.tn(2, '{n} game', '{n} games'), '2 jeux');
  assert.deepStrictEqual(I18n.tEl('See {link}.', { link: 42 }), ['Voir ', 42, '.']);
  I18n.LANGS.pop();
  delete I18n.dictionaries.xx;
  assert.strictEqual(I18n.setLanguage('auto', ['de-AT', 'en']), 'de');
  assert.strictEqual(I18n.setLanguage('auto', ['sv-SE']), 'en');
  assert.strictEqual(I18n.setLanguage('pt-PT'), 'pt-BR');
  assert.strictEqual(I18n.setLanguage('en'), 'en');
  assert.strictEqual(I18n.tn(1, '{n} game', '{n} games'), '1 game');
});

test('i18n: every translation keeps the placeholders of its English', () => {
  const { keys, problems } = collect();
  assert.deepStrictEqual(problems, []);
  const holes = (s) => (String(s).match(/\{\w+\}/g) || []).sort().join(' ');
  for (const [id, dict] of Object.entries(dictionaries)) {
    for (const [key, value] of Object.entries(dict)) {
      if (!keys.includes(key)) continue; // an old key the app no longer uses
      if (key.includes('|')) {
        const [one, other] = key.split('|');
        // Any form may drop {n} (a language that writes "one game" in words), but no new placeholders.
        const allowed = new Set([...holes(one).split(' '), ...holes(other).split(' '), '{n}'].filter(Boolean));
        for (const form of typeof value === 'string' ? [value] : Object.values(value)) for (const h of holes(form).split(' ').filter(Boolean)) assert.ok(allowed.has(h), `${id}: "${key}" has ${h}`);
      } else {
        assert.strictEqual(holes(value), holes(key), `${id}: "${key}" -> "${value}"`);
      }
    }
  }
});
