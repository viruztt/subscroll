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
  assert.deepStrictEqual(st.totals, { inPlans: 5, completed: 3, playing: 0, played: 1, dropped: 0, ignored: 1 });
  assert.deepStrictEqual(st.plans, { completed: 2, playing: 0, played: 1, dropped: 0, wishlist: 1, ignored: 1, untouched: 0 });
  assert.strictEqual(st.finishRate, 3 / 4);
  assert.strictEqual(st.steamOwned, 1);
});

test('Statistics: each completed game in one pie slice, every service in the progress rows', () => {
  const ids = (list) => list.map((g) => g.id);
  assert.deepStrictEqual(st.completedBy.map((x) => [x.service, x.count, ids(x.games)]), [['gamepass', 2, ['a', 'b']], [OTHER, 1, ['f']]]);
  // The games behind each slice, for listing them.
  assert.deepStrictEqual(ids(st.planGames.played), ['c']);
  assert.deepStrictEqual(ids(st.planGames.untouched), []);
  // The tiles: every completed or played game, in your plans or not, and the Steam ones.
  assert.deepStrictEqual(ids(st.marked.completed), ['a', 'b', 'f']);
  assert.deepStrictEqual(ids(st.marked.played), ['c']);
  assert.deepStrictEqual(ids(st.steamGames), ['e']);
  const row = (s) => st.services.find((r) => r.service === s);
  assert.deepStrictEqual(row('gamepass'), { service: 'gamepass', inPlans: 2, played: 0, completed: 2 });
  assert.deepStrictEqual(row('eaplay'), { service: 'eaplay', inPlans: 1, played: 0, completed: 1 });
  assert.deepStrictEqual(row('psplus'), { service: 'psplus', inPlans: 3, played: 1, completed: 0 });
});

test('Statistics: genres, hours and scores of completed games', () => {
  assert.deepStrictEqual(st.genres.map((x) => [x.genre, x.count, x.games.map((g) => g.id)]), [['RPG', 2, ['a', 'b']], ['Puzzle', 1, ['f']], ['Shooter', 1, ['b']]]);
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
  const marks = { a: 'completed', b: 'played', c: 'completed' };
  const st = Stats.compute(games, { markOf: (g) => marks[g.id] || 'none', myServices: (g) => (g.service === 'psplus' ? [] : [g.service]), hours: () => null, score: () => null });
  // A game outside your plans doesn't fill the plan bar (it would run past 100%), but still shows the platform.
  assert.deepStrictEqual(st.platforms.map((r) => [r.platform, r.inPlans, r.completed, r.played, r.marked]), [['xbox', 1, 1, 0, 1], ['pc', 1, 1, 0, 1], ['playstation', 0, 0, 0, 1], ['switch', 1, 0, 1, 1]]);
});

test('Statistics: now playing and dropped count as started', () => {
  const games = [
    { id: 'p', service: 'gamepass', tiers: ['pc'], platforms: ['pc'] },
    { id: 'd', service: 'gamepass', tiers: ['pc'], platforms: ['pc'] },
    { id: 'c', service: 'gamepass', tiers: ['pc'], platforms: ['pc'] },
  ];
  const marks = { p: 'playing', d: 'dropped', c: 'completed' };
  const r = Stats.compute(games, { markOf: (g) => marks[g.id] || 'none', myServices: () => ['gamepass'], hours: () => 10, score: () => null, subscribed: ['gamepass'] });
  assert.deepStrictEqual([r.totals.playing, r.totals.dropped, r.plans.playing, r.plans.dropped], [1, 1, 1, 1]);
  assert.deepStrictEqual(r.services[0], { service: 'gamepass', inPlans: 3, played: 2, completed: 1 });
  assert.strictEqual(r.finishRate, 1 / 3);
  assert.deepStrictEqual(r.marked.dropped.map((g) => g.id), ['d']);
  assert.strictEqual(r.time.playing, 10); // now playing counts toward the hours still ahead
});

test('Statistics: completed games played through a subscription', () => {
  const r = compute(games, {
    markOf: (g) => g.mark,
    myServices: (g) => g.mine,
    hours: () => null,
    score: () => null,
    viaSub: (g) => g.mine.length > 0 && g.id !== 'b',
  });
  assert.deepStrictEqual(r.completedViaSub.map((g) => g.id), ['a']);
  // Without the helper the list is just empty.
  assert.deepStrictEqual(st.completedViaSub, []);
});
