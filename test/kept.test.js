const test = require('node:test');
const assert = require('node:assert');
const Kept = require('../src/kept');

const catalogs = [
  { service: 'gamepass', games: [{ id: 'gamepass:A', service: 'gamepass', title: 'Still here', image: 'https://img/a', platforms: ['pc'], tiers: ['pc'], leavingSoon: true, screenshots: [] }], history: { departed: [{ id: 'gamepass:B', service: 'gamepass', title: 'Left', leftOn: '2026-09-15', platforms: ['console'], tiers: ['ultimate'] }] } },
  { service: 'psplus', games: [{ id: 'psplus:C', service: 'psplus', title: 'On PS Plus', platforms: ['PS5'], tiers: ['extra'] }], history: { departed: [] } },
];

test('copies marked games from lists and departed lists, without what changes daily', () => {
  const details = { 'psplus:C': { description: 'From the store page.', screenshots: ['https://s/1'] } };
  const { kept, changed, missing } = Kept.update({}, new Set(['gamepass:A', 'gamepass:B', 'psplus:C', 'gamepass:Z']), catalogs, details);
  assert.ok(changed);
  assert.deepStrictEqual(missing, ['gamepass:Z']);
  assert.strictEqual(kept['gamepass:A'].title, 'Still here');
  assert.ok(!('leavingSoon' in kept['gamepass:A']) && !('screenshots' in kept['gamepass:A']));
  assert.strictEqual(kept['gamepass:B'].leftOn, '2026-09-15');
  assert.strictEqual(kept['psplus:C'].description, 'From the store page.');
});

test('a copy stays when its game is found nowhere, and goes when unmarked', () => {
  const first = Kept.update({}, new Set(['gamepass:B', 'psplus:C']), catalogs).kept;
  const later = Kept.update(first, new Set(['gamepass:B']), []);
  assert.ok(later.changed);
  assert.deepStrictEqual(Object.keys(later.kept), ['gamepass:B']);
  assert.strictEqual(later.kept['gamepass:B'].title, 'Left');
  assert.deepStrictEqual(later.missing, []);
  const same = Kept.update(later.kept, new Set(['gamepass:B']), []);
  assert.strictEqual(same.changed, false);
});

test('a lost Game Pass game is rebuilt from its store product', () => {
  const card = Kept.fromProduct('gamepass:9XYZ', { title: 'Quantum Break', image: 'https://img/q', genres: ['Shooter'], description: 'Time.', screenshots: ['https://s/q'], releaseDate: '2016-04-05' });
  assert.strictEqual(card.title, 'Quantum Break');
  assert.strictEqual(card.departed, true);
  assert.strictEqual(card.service, 'gamepass');
  assert.match(card.storeUrl, /9XYZ$/);
});
