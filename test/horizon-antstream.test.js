const test = require('node:test');
const assert = require('node:assert');
const horizon = require('../src/providers/horizonplus');
const antstream = require('../src/providers/antstream');
const covers = require('../src/providers/covers');

// Quest+ History's catalog.json: months out of order, adds and removals.
const CATALOG = {
  2023: {
    10: [{ title: 'Beat Saber', url: 'https://www.meta.com/experiences/2448060205267927/', event: '+' }],
    '07': [{ title: 'Moss', url: 'https://www.meta.com/experiences/moss/1654565391314903/', event: '+' }, { title: 'Alvo', url: 'https://www.meta.com/experiences/2167788253330299/', event: '+' }],
  },
  2026: {
    10: [{ title: 'Alvo', url: 'https://www.meta.com/experiences/2167788253330299/', event: '-' }, { title: 'Deadly Delivery', url: 'https://www.meta.com/experiences/5555555555555/', event: '+' }],
    '03': [{ title: 'Moss', url: 'https://www.meta.com/experiences/moss/1654565391314903/', event: '-' }],
    '05': [{ title: 'Moss', url: 'https://www.meta.com/experiences/moss/1654565391314903/', event: '+' }],
  },
};

test('Horizon+ catalog: games whose last change was an addition', () => {
  const games = horizon.parseCatalog(CATALOG);
  assert.deepStrictEqual(games.map((g) => g.title).sort(), ['Beat Saber', 'Deadly Delivery', 'Moss']);
  const moss = games.find((g) => g.title === 'Moss');
  assert.strictEqual(moss.id, 'horizonplus:1654565391314903');
  assert.strictEqual(moss.addedOn, '2026-05-01');
  assert.deepStrictEqual(moss.tiers, ['catalog']);
  assert.deepStrictEqual(moss.platforms, ['Meta Quest']);
  assert.strictEqual(moss.storeUrl, 'https://www.meta.com/experiences/moss/1654565391314903/');
});

test('Horizon+ monthly games: this month only, until the month ends', () => {
  const monthly = { 2026: { '09': [{ title: 'Prison Boss VR', url: 'https://www.meta.com/experiences/111111111/' }], 10: [{ title: 'SWARM 2', url: 'https://www.meta.com/experiences/222222222/' }] } };
  const games = horizon.parseMonthly(monthly, '2026-10-19');
  assert.deepStrictEqual(games.map((g) => [g.title, g.tiers[0], g.leavesOn]), [['SWARM 2', 'monthly', '2026-10-31']]);
  assert.deepStrictEqual(horizon.parseMonthly(monthly, '2026-11-02'), []);
});

// Cards of the games page as the app reads them: text pieces in page order.
const CARDS = [
  { texts: ['SPECTRUM', 'Manic Miner', 'Platform', 'Manic Miner', 'VIEW'], img: 'https://cdn.example/mm.png', alt: 'Manic Miner', href: 'https://www.antstream.com/game/manic-miner' },
  { texts: ['AMIGA', '5 CHALLENGES', 'The Chaos Engine', 'Shooting', 'The Chaos Engine', 'VIEW'], img: null, alt: '', href: null },
  { texts: ['Megadrive', 'Stack N Attract', 'Puzzle', 'VIEW'], img: 'https://cdn.example/sna.jpg', alt: 'Stack N Attract' },
  { texts: ['INTELLIVISION', 'B-17 Bomber', 'Arcade Adventure', 'B-17 Bomber', 'VIEW'] },
  { texts: ['VIEW'] },
];

test('Antstream games page: title, system, genre, picture and link from each card', () => {
  const games = antstream.parseCards(CARDS);
  assert.deepStrictEqual(games.map((g) => [g.title, g.system, g.genres[0], g.image]), [
    ['Manic Miner', 'ZX Spectrum', 'Platform', 'https://cdn.example/mm.png'],
    ['The Chaos Engine', 'Amiga', 'Shooting', null],
    ['Stack N Attract', 'Sega Genesis', 'Puzzle', 'https://cdn.example/sna.jpg'],
    ['B-17 Bomber', 'Intellivision', 'Arcade Adventure', null],
  ]);
  assert.strictEqual(games[0].id, 'antstream:zx-spectrum:manic-miner');
  assert.strictEqual(games[0].storeUrl, 'https://www.antstream.com/game/manic-miner');
  assert.strictEqual(games[1].storeUrl, antstream.SITE_LIST);
  assert.deepStrictEqual(games[0].platforms, ['PC', 'console', 'Mobile']);
});

test('Antstream page JSON: challenges are skipped, bare picture names find their folder', () => {
  const challenges = [{ _id: 'a1', tier: 5, type: 'time_attack', title: 'Squashing The Enemy', img_src: 'Desert%20War/c.png', gameId: 'a', challengeId: 'a1' }];
  const trending = [
    { _id: 'a', title: 'PAC-MAN', platform: 'Arcade', studio: 'Namco', image_uri: 'pac-man_namco_arcade_game-image.png' },
    { _id: 'b', title: "Mr. Do's Castle", platform: 'Arcade', studio: 'Universal Entertainment', image_uri: 'mr-dos-castle.jpg' },
  ];
  const out = antstream.parseCaptured([
    { url: 'https://www.antstream.com/assets/challenges/Challenges.json', body: JSON.stringify(challenges) },
    { url: 'https://cms.example/api/allgames-trending.json', body: JSON.stringify(trending) },
  ], ['https://img.example/games/pac-man_namco_arcade_game-image.png']);
  assert.deepStrictEqual(out.map((g) => [g.title, g.system, g.publisher, g.image]), [
    ['PAC-MAN', 'Arcade', 'Namco', 'https://img.example/games/pac-man_namco_arcade_game-image.png'],
    ["Mr. Do's Castle", 'Arcade', 'Universal Entertainment', 'https://img.example/games/mr-dos-castle.jpg'],
  ]);
});

test('Antstream: cards and page JSON fill in each other', () => {
  const cards = [{ texts: ['ARCADE', "MR. DO'S CASTLE", 'Maze', "MR. DO'S CASTLE", 'VIEW'] }];
  const json = antstream.parseCaptured([{ url: 'https://x/a.json', body: JSON.stringify([{ title: "Mr. Do's Castle", platform: 'Arcade', image: 'https://i/d.jpg' }]) }]);
  const [g] = antstream.combine(antstream.parseCards(cards), json);
  assert.deepStrictEqual([g.title, g.image, g.genres], ["Mr. Do's Castle", 'https://i/d.jpg', ['Maze']]);
});

test('Antstream site: the biggest group of game-like objects in the page JSON', () => {
  const games = [
    { name: 'Commodore 64', games: [{ id: 1, title: 'Boulder Dash', image: '/img/bd.png' }, { id: 2, title: 'Uridium', image: '/img/u.png' }] },
    { name: 'Arcade', games: [{ id: 3, title: 'Pac-Man', image: 'https://cdn.example/pm.jpg' }] },
  ];
  const menu = [{ title: 'Home', href: '/' }, { title: 'Games', href: '/games' }];
  const out = antstream.parseCaptured([
    { url: 'https://api.example/menu', body: JSON.stringify(menu) },
    { url: 'https://api.example/v1/games', body: JSON.stringify({ systems: games }) },
    { url: 'https://api.example/broken', body: 'not json' },
  ]);
  assert.deepStrictEqual(out.map((g) => [g.title, g.system, g.image]), [
    ['Boulder Dash', 'Commodore 64', 'https://api.example/img/bd.png'],
    ['Uridium', 'Commodore 64', 'https://api.example/img/u.png'],
    ['Pac-Man', 'Arcade', 'https://cdn.example/pm.jpg'],
  ]);
});

test('Antstream: reads the games page, and says what it found when it falls short', async () => {
  const many = Array.from({ length: 320 }, (_, i) => ({ texts: ['AMIGA', `Game ${i}`, 'Action', `Game ${i}`, 'VIEW'] }));
  const games = await antstream.fetchLive({}, null, { capture: async () => ({ responses: [], cards: many, presses: 13, text: '' }) });
  assert.strictEqual(games.length, 320);
  assert.strictEqual(games[0].system, 'Amiga');
  await assert.rejects(antstream.fetchLive({}, null, { capture: async () => ({ responses: [], cards: many.slice(0, 24), presses: 0, text: '' }) }), /pressed Load More 0 times, 24 game cards/);
  await assert.rejects(antstream.fetchLive({}, null, { capture: async () => null }), /needs the app window/);
});

test('Antstream systems map to libretro box art collections', () => {
  assert.strictEqual(covers.systemName('Super NES / Super Famicom'), 'SNES');
  assert.strictEqual(covers.systemName('NES / Famicom'), 'NES');
  assert.strictEqual(covers.systemName('MSX and MSX2'), 'MSX');
  assert.strictEqual(covers.systemName('MS-DOS'), 'DOS');
  assert.strictEqual(covers.systemName('Commodore 64'), 'Commodore 64');
  assert.strictEqual(covers.systemName('Game Boy and Game Boy Color'), 'Game Boy');
  assert.strictEqual(covers.systemName('Megadrive'), 'Sega Genesis');
  assert.strictEqual(covers.systemName('Atari 5200'), 'Atari 5200');
  assert.strictEqual(covers.systemName('Something else'), null);
  const index = covers.buildIndex({ 'Commodore_-_64': ['Boulder Dash (USA, Europe).png'] }, ['Commodore 64']);
  assert.ok(index['Commodore 64'] instanceof Map);
});

test('Antstream box art: matched within its own system', () => {
  const index = covers.buildIndex({ 'Commodore_-_64': ['Boulder Dash (USA, Europe).png'] }, ['Commodore 64']);
  assert.match(covers.match(index, 'Commodore 64', 'Boulder Dash'), /Commodore_-_64\/master\/Named_Boxarts\/Boulder%20Dash/);
  assert.strictEqual(covers.match(index, null, 'Boulder Dash'), null);
});

test('Horizon+ covers: Meta art first, Steam art as its fallback or instead', () => {
  const games = [
    { id: 'horizonplus:1', title: 'Moss', genres: [], image: null },
    { id: 'horizonplus:2', title: 'Pistol Whip', genres: [], image: null },
    { id: 'horizonplus:3', title: 'Unknown', genres: [], image: null },
  ];
  const out = horizon.withCovers(games, { 'horizonplus:1': { image: 'https://meta/moss.webp', genres: ['Adventure'] } }, { 'horizonplus:1': 'https://steam/moss.jpg', 'horizonplus:2': 'https://steam/pw.jpg' });
  assert.deepStrictEqual(out.map((g) => [g.image, g.imageFallback]), [['https://meta/moss.webp', 'https://steam/moss.jpg'], ['https://steam/pw.jpg', null], [null, null]]);
  assert.deepStrictEqual(out[0].genres, ['Adventure']);
});
