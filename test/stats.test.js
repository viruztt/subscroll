const test = require('node:test');
const assert = require('node:assert');
const Stats = require('../renderer/stats');
const { compute, OTHER } = Stats;

const games = [
  { id: 'a', mine: ['gamepass', 'eaplay'], mark: 'completed', h: 10, sc: 80, genreTags: ['RPG'] },
  { id: 'b', mine: ['gamepass'], mark: 'completed', h: 20, sc: null, genreTags: ['RPG', 'Shooter'] },
  { id: 'c', mine: ['psplus'], mark: 'played', h: 30, genreTags: [] },
  { id: 'd', mine: ['psplus'], mark: 'ignored' },
  { id: 'e', mine: ['psplus'], mark: 'wishlist', steam: { appid: 1 } },
  { id: 'f', mine: [], mark: 'completed', h: null, sc: 60, genreTags: ['Puzzle'] }, // left the service
  { id: 'g', mine: [], mark: 'none' },
];

const st = compute(games, {
  markOf: (g) => g.mark,
  myServices: (g) => g.mine,
  hours: (g) => g.h ?? null,
  score: (g) => g.sc ?? null,
  subscribed: ['gamepass', 'eaplay', 'psplus'],
});

test('Statistics: totals and your plans by status', () => {
  assert.deepStrictEqual(st.totals, { inPlans: 5, completed: 3, played: 1, ignored: 1 });
  assert.deepStrictEqual(st.plans, { completed: 2, played: 1, wishlist: 1, ignored: 1, untouched: 0 });
  assert.strictEqual(st.finishRate, 3 / 4);
  assert.strictEqual(st.steamOwned, 1);
});

test('Statistics: each completed game in one pie slice, every service in the progress rows', () => {
  assert.deepStrictEqual(st.completedBy, [{ service: 'gamepass', count: 2 }, { service: OTHER, count: 1 }]);
  const row = (s) => st.services.find((r) => r.service === s);
  assert.deepStrictEqual(row('gamepass'), { service: 'gamepass', inPlans: 2, played: 0, completed: 2 });
  assert.deepStrictEqual(row('eaplay'), { service: 'eaplay', inPlans: 1, played: 0, completed: 1 });
  assert.deepStrictEqual(row('psplus'), { service: 'psplus', inPlans: 3, played: 1, completed: 0 });
});

test('Statistics: genres, hours and scores of completed games', () => {
  assert.deepStrictEqual(st.genres, [{ genre: 'RPG', count: 2 }, { genre: 'Puzzle', count: 1 }, { genre: 'Shooter', count: 1 }]);
  assert.deepStrictEqual(st.time, { completed: 30, completedTimed: 2, playing: 30, playingTimed: 1 });
  assert.strictEqual(st.averageScore, 70);
});

test('Stats: platforms group stores\' names, and Switch Online counts as Switch', () => {
  assert.strictEqual(Stats.platformOf('console'), 'xbox');
  assert.strictEqual(Stats.platformOf('PC'), 'pc');
  assert.strictEqual(Stats.platformOf('PS5'), 'playstation');
  assert.strictEqual(Stats.platformOf('Apple devices'), 'mobile');
  assert.strictEqual(Stats.platformOf('Cloud'), 'cloud');
  assert.strictEqual(Stats.platformOf('Amiga'), 'other');
  const merged = { offers: [{ service: 'gamepass', platforms: ['console', 'pc'] }, { service: 'psplus', platforms: ['PS4'] }] };
  assert.deepStrictEqual([...Stats.platformsOf(merged)].sort(), ['pc', 'playstation', 'xbox']);
  assert.deepStrictEqual([...Stats.platformsOf({ service: 'nso', platforms: ['NES'] })], ['switch']);
  const games = [
    { id: 'a', service: 'gamepass', platforms: ['console', 'pc'] },
    { id: 'b', service: 'nso', platforms: ['SNES'] },
    { id: 'c', service: 'psplus', platforms: ['PS5'] },
  ];
  const marks = { a: 'completed', b: 'played' };
  const st = Stats.compute(games, { markOf: (g) => marks[g.id] || 'none', myServices: (g) => (g.service === 'psplus' ? [] : [g.service]), hours: () => null, score: () => null });
  assert.deepStrictEqual(st.platforms.map((r) => [r.platform, r.inPlans, r.completed, r.played]), [['xbox', 1, 1, 0], ['pc', 1, 1, 0], ['playstation', 0, 0, 0], ['switch', 1, 0, 1]]);
});
