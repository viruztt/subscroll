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

test('Regional versions of a Switch Online game share one entry', () => {
  const nso = (id, title, platform = 'NES') => ({ id: `nso:${id}`, service: 'nso', title, platforms: [platform], tiers: ['base'], image: `${id}.png` });
  const list = unify([
    nso('lolo-jp', 'Adventures of Lolo (JP)'),
    nso('lolo-na', 'Adventures of Lolo (NA)'),
    nso('gb-lolo', 'Adventures of Lolo', 'Game Boy'),
    nso('metroid-sp', 'Super Metroid SP (Ridley battle)', 'SNES'),
    nso('metroid', 'Super Metroid', 'SNES'),
  ]);
  assert.strictEqual(list.length, 4);
  const lolo = list.find((g) => g.platforms[0] === 'NES');
  assert.strictEqual(lolo.title, 'Adventures of Lolo');
  assert.strictEqual(lolo.id, 'nso:lolo-na'); // the western version leads
  assert.deepStrictEqual(lolo.versions, ['NA', 'JP']);
  assert.strictEqual(lolo.offers.length, 2);
});

test('Antstream: each system\'s version keeps its own card, apart from modern releases', () => {
  const list = unify([
    { id: 'antstream:arcade:bubble-bobble', service: 'antstream', title: 'Bubble Bobble', system: 'Arcade', tiers: ['any'], platforms: ['PC'] },
    { id: 'antstream:commodore-64:bubble-bobble', service: 'antstream', title: 'Bubble Bobble', system: 'Commodore 64', tiers: ['any'], platforms: ['PC'] },
    { id: 'gamepass:X', service: 'gamepass', title: 'Bubble Bobble', tiers: ['pc'], platforms: ['pc'] },
  ]);
  assert.strictEqual(list.length, 3);
  const { mergeDuplicates } = require('../src/catalog');
  assert.strictEqual(mergeDuplicates([
    { id: 'antstream:arcade:bubble-bobble', service: 'antstream', title: 'Bubble Bobble', platforms: ['PC'], tiers: ['any'] },
    { id: 'antstream:amiga:bubble-bobble', service: 'antstream', title: 'Bubble Bobble', platforms: ['PC'], tiers: ['any'] },
  ]).length, 2);
});
