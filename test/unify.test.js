const test = require('node:test');
const assert = require('node:assert');
const { unify, matchKey } = require('../renderer/unify');

const game = (service, id, title, extra = {}) => ({ id: `${service}:${id}`, service, title, platforms: [], tiers: ['x'], image: null, ...extra });

test('The same game in several services becomes one entry', () => {
  const list = unify([
    game('eaplay', 'B', 'A Way Out', { image: 'ea.jpg', platforms: ['console'] }),
    game('psplus', '1', 'A Way Out™', { image: 'ps.jpg', platforms: ['PS4'], leavingSoon: true }),
    game('gamepass', 'A', 'A Way Out', { image: 'gp.jpg', platforms: ['console', 'pc'], firstSeen: '2026-01-01' }),
    game('gamepass', 'C', 'Hades'),
  ], '2026-10-16');
  assert.strictEqual(list.length, 2);
  const way = list.find((g) => g.title === 'A Way Out');
  assert.strictEqual(way.id, 'gamepass:A'); // Game Pass leads
  assert.strictEqual(way.image, 'gp.jpg');
  assert.deepStrictEqual(way.offers.map((o) => o.service), ['gamepass', 'psplus', 'eaplay']);
  assert.deepStrictEqual(way.platforms.sort(), ['PS4', 'console', 'pc']);
  assert.ok(way.leavingSoon);
  assert.deepStrictEqual(list.find((g) => g.title === 'Hades').offers.length, 1);
});

test('Switch Online and custom games are never merged', () => {
  const list = unify([
    game('nso', 'nes:tetris', 'Tetris'),
    game('psplus', '9', 'Tetris'),
    game('mine', 'x', 'Tetris', { custom: true }),
  ]);
  assert.strictEqual(list.length, 3);
});

test('Titles match across platform suffixes and editions, not different games', () => {
  assert.strictEqual(matchKey('Gears 5 Game of the Year Edition'), matchKey('Gears 5'));
  assert.strictEqual(matchKey('Hades (Windows)'), matchKey('Hades'));
  assert.strictEqual(matchKey('Stray PS4 & PS5'), matchKey('Stray'));
  assert.notStrictEqual(matchKey('Hades II'), matchKey('Hades'));
  assert.notStrictEqual(matchKey('Halo 3'), matchKey('Halo 3: ODST'));
});

test('A game already playable somewhere is not "coming"', () => {
  const [g] = unify([
    game('gamepass', 'A', 'Star Game', { comingOn: '2026-11-01' }),
    game('eaplay', 'A', 'Star Game', { firstSeen: '2026-03-01' }),
  ], '2026-10-16');
  assert.strictEqual(g.comingOn, null);
  assert.strictEqual(g.firstSeen, '2026-03-01');
  const [soon] = unify([game('gamepass', 'A', 'Later', { comingOn: '2026-12-01' }), game('psplus', '1', 'Later', { comingOn: '2026-11-05' })], '2026-10-16');
  assert.strictEqual(soon.comingOn, '2026-11-05');
});
