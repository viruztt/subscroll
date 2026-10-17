const test = require('node:test');
const assert = require('node:assert');
const { recommend } = require('../renderer/recommend');

const g = (id, service, extra = {}) => ({ id, title: id, service, genreTags: [], ...extra });
const games = [
  g('rpg-great', 'gamepass', { genreTags: ['RPG'], mc: 90, hours: 40 }),
  g('rpg-short', 'psplus', { genreTags: ['RPG'], hours: 8 }),
  g('shooter', 'gamepass', { genreTags: ['Shooter'], mc: 95 }),
  g('rpg-done', 'gamepass', { genreTags: ['RPG'], mark: 'completed' }),
  g('rpg-notmine', 'eaplay', { genreTags: ['RPG'], mine: false }),
  g('rpg-coming', 'gamepass', { genreTags: ['RPG'], coming: true }),
  g('leaving', 'gamepass', { leavingSoon: true }),
];
const helpers = {
  isMine: (x) => x.mine !== false,
  markOf: (x) => x.mark || 'none',
  isComing: (x) => !!x.coming,
  score: (x) => x.mc ?? null,
  hours: (x) => x.hours ?? null,
  genres: (x) => x.genreTags,
};
const ids = (picks) => picks.map((p) => p.game.id);

test('Recommendations: liked genres only, from your plans, not finished or coming', () => {
  const picks = recommend(games, helpers, { tastes: { genres: ['RPG'], length: 'any' }, today: '2026-10-17' });
  assert.deepStrictEqual(ids(picks), ['rpg-great', 'rpg-short']);
  assert.deepStrictEqual(picks[0].reasons.map((r) => r.label), ['RPG', 'Metacritic 90']);
});

test('Recommendations: length preference and no tastes at all', () => {
  assert.deepStrictEqual(ids(recommend(games, helpers, { tastes: { genres: ['RPG'], length: 'short' }, today: '2026-10-17' })), ['rpg-short']);
  const any = ids(recommend(games, helpers, { tastes: { genres: [], length: 'any' }, today: '2026-10-17' }));
  assert.deepStrictEqual(any.slice(0, 3), ['shooter', 'rpg-great', 'leaving']);
  assert.ok(!any.includes('rpg-done') && !any.includes('rpg-coming') && !any.includes('rpg-notmine'));
});

test('Recommendations: no more than a few from one service', () => {
  const many = Array.from({ length: 10 }, (_, i) => g(`gp${i}`, 'gamepass', { mc: 90 }));
  const picks = recommend([...many, g('ps', 'psplus', { mc: 80 })], helpers, { tastes: { genres: [], length: 'any' }, today: '2026-10-17', perService: 3 });
  assert.deepStrictEqual(ids(picks).filter((x) => x.startsWith('gp')).length, 3);
  assert.ok(ids(picks).includes('ps'));
});

test('Recommendations: several liked genres take turns', () => {
  const list = [
    ...Array.from({ length: 4 }, (_, i) => g(`rpg${i}`, 'gamepass', { genreTags: ['RPG'], mc: 95 })),
    g('plat', 'psplus', { genreTags: ['Platformer'], mc: 70 }),
  ];
  const picks = recommend(list, helpers, { tastes: { genres: ['RPG', 'Platformer'], length: 'any' }, today: '2026-10-17' });
  assert.deepStrictEqual(ids(picks).slice(0, 2), ['rpg0', 'plat']);
});
