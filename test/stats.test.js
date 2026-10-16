const test = require('node:test');
const assert = require('node:assert');
const { compute, OTHER } = require('../renderer/stats');

const games = [
  { id: 'a', mine: ['gamepass', 'eaplay'], mark: 'completed', h: 10, sc: 80, genreTags: ['RPG'] },
  { id: 'b', mine: ['gamepass'], mark: 'completed', h: 20, sc: null, genreTags: ['RPG', 'Shooter'] },
  { id: 'c', mine: ['psplus'], mark: 'played', h: 30, genreTags: [] },
  { id: 'd', mine: ['psplus'], mark: 'ignored' },
  { id: 'e', mine: ['psplus'], mark: 'none', steam: { appid: 1 } },
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
  assert.deepStrictEqual(st.plans, { completed: 2, played: 1, ignored: 1, untouched: 1 });
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
