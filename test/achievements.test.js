const test = require('node:test');
const assert = require('node:assert');
const http = require('../src/providers/http');
const { parseXbox, parsePsn, titleIndex, achievementMarks, importAchievements, cleanTitle } = require('../src/achievements');

const xboxFeed = { xuid: '1', titles: [
  { name: 'Halo Infinite', type: 'Game', achievement: { currentAchievements: 119, totalAchievements: 119, progressPercentage: 100 }, titleHistory: { lastTimePlayed: '2026-03-14T20:11:00Z' } },
  { name: 'Hades', type: 'Game', achievement: { currentAchievements: 12, totalAchievements: 49, progressPercentage: 24 } },
  { name: 'Starfield', type: 'Game', achievement: { currentAchievements: 0, totalAchievements: 50, progressPercentage: 0 } },
  { name: 'Netflix', type: 'App', achievement: { currentAchievements: 0, totalAchievements: 0 } },
] };

test('parseXbox: games only, played when something is earned, completed at 100%', () => {
  const t = parseXbox(xboxFeed);
  assert.deepStrictEqual(t.map((x) => [x.name, x.played, x.completed, x.progress]), [
    ['Halo Infinite', true, true, 100],
    ['Hades', true, false, 24],
    ['Starfield', false, false, 0],
  ]);
});

test('parsePsn: trophy suffixes dropped, platinum or 100% is completed', () => {
  const t = parsePsn([
    { trophyTitleName: "Marvel's Spider-Man 2 Trophies", progress: 64, earnedTrophies: { bronze: 30, silver: 5, gold: 2, platinum: 1 } },
    { trophyTitleName: 'Stray', progress: 100, earnedTrophies: { bronze: 20, silver: 4, gold: 0, platinum: 0 } },
    { trophyTitleName: 'Returnal (PS5)', progress: 3, earnedTrophies: { bronze: 1 } },
    { trophyTitleName: 'Untouched', progress: 0, earnedTrophies: {} },
  ]);
  assert.deepStrictEqual(t.map((x) => [x.name, x.earned, x.played, x.completed]), [
    ["Marvel's Spider-Man 2", 38, true, true],
    ['Stray', 24, true, true],
    ['Returnal', 1, true, false],
    ['Untouched', 0, false, false],
  ]);
  assert.strictEqual(cleanTitle('Ghost of Tsushima Trophies'), 'Ghost of Tsushima');
});

test('titleIndex: the furthest of two trophy lists for one game wins', () => {
  const idx = titleIndex([
    { name: 'Stray', earned: 5, progress: 20, played: true, completed: false },
    { name: 'Stray', earned: 24, progress: 100, played: true, completed: true },
  ]);
  assert.strictEqual(Object.values(idx).length, 1);
  assert.strictEqual(Object.values(idx)[0].completed, true);
});

const catalogue = [
  { id: 'gamepass:halo', service: 'gamepass', title: 'Halo Infinite', tiers: ['ultimate'], platforms: ['console'] },
  { id: 'gamepass:hades', service: 'gamepass', title: 'Hades', tiers: ['ultimate'], platforms: ['console'] },
  { id: 'psplus:hades', service: 'psplus', title: 'Hades', tiers: ['extra'], platforms: ['ps5'] },
  { id: 'gamepass:starfield', service: 'gamepass', title: 'Starfield', tiers: ['ultimate'], platforms: ['console'] },
  { id: 'gamepass:ignored', service: 'gamepass', title: 'Ignored Game', tiers: ['ultimate'], platforms: ['console'] },
  { id: 'nso:halo', service: 'nso', title: 'Halo Infinite', tiers: ['nso'], platforms: ['NES'] },
];

test('achievementMarks: played and completed, once each, never over ignored or completed', () => {
  const idx = titleIndex([...parseXbox(xboxFeed), { name: 'Ignored Game', earned: 3, progress: 100, played: true, completed: true }]);
  const marks = { 'psplus:hades': 'wishlist', 'gamepass:ignored': 'ignored' };
  const r = achievementMarks(catalogue, idx, marks);
  assert.strictEqual(r.found, 4);
  assert.strictEqual(r.add['gamepass:halo'], 'completed');
  // Dated by when it was last played, for goals.
  assert.strictEqual(r.finished['gamepass:halo'], '2026-03-14');
  assert.ok(!Object.keys(r.finished).some((id) => id.includes('hades')));
  // One card for Hades on two services: one mark, the To play mark on the other offer cleared.
  const hades = Object.entries(r.add).filter(([id]) => id.includes('hades'));
  assert.deepStrictEqual(hades.map(([, m]) => m), ['played']);
  assert.ok(r.clear.includes('psplus:hades') || hades[0][0] === 'psplus:hades');
  assert.ok(!('gamepass:starfield' in r.add));
  assert.ok(!('gamepass:ignored' in r.add));
  assert.ok(!('nso:halo' in r.add));
  // Marked before: a removed mark stays removed.
  const again = achievementMarks(catalogue, idx, { 'gamepass:ignored': 'ignored' }, r.keys);
  assert.deepStrictEqual(again.add, {});
});

test('importAchievements: Xbox via OpenXBL, with the key sent in the header', async () => {
  const seen = [];
  http.setFetch(async (url, opts) => {
    seen.push([url, opts.headers['X-Authorization']]);
    if (opts.headers['X-Authorization'] !== 'GOOD') return { ok: false, status: 401, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => xboxFeed };
  });
  const r = await importAchievements('xbox', 'GOOD', catalogue, {}, {});
  assert.strictEqual(seen[0][0], 'https://xbl.io/api/v2/achievements');
  assert.deepStrictEqual(r.summary, { titles: 3, inCatalogue: 3, played: 1, completed: 1 });
  assert.strictEqual(r.account.key, 'GOOD');
  assert.strictEqual(r.account.count, 3);
  await assert.rejects(importAchievements('xbox', 'BAD', catalogue), /didn't accept the API key/);
  await assert.rejects(importAchievements('psn', '', catalogue), /NPSSO/);
});
