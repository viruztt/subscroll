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

// Shapes the help-centre article might take: a heading per system with a
// list, bold paragraph headings with <br> lines, or a table.
const HELP_LISTS = `
<p>Here is every game on Antstream Arcade.</p>
<h2>Commodore 64</h2>
<ul><li>Boulder Dash</li><li>Uridium</li></ul>
<p><strong>ZX Spectrum</strong></p>
<p>Manic Miner<br>Jet Set Willy<br>Visit https://antstream.com for more.</p>
<p>Pac-Man (Arcade)</p>`;
const HELP_TABLE = `
<table><tbody>
<tr><th>Game</th><th>Platform</th><th>Publisher</th><th>Year</th><th>Date added</th></tr>
<tr><td>Air Cavalry</td><td>Super Nintendo</td><td>Synergistic</td><td>1995</td><td>April 13, 2023</td></tr>
<tr><td>Mr. Do!</td><td>Arcade</td><td>Universal</td><td>1982</td><td>December 3, 2026</td></tr>
</tbody></table>`;

test('Antstream help centre: lists under system headings', () => {
  const games = antstream.parseList(HELP_LISTS, '2026-10-19');
  assert.deepStrictEqual(games.map((g) => [g.title, g.system]), [
    ['Boulder Dash', 'Commodore 64'], ['Uridium', 'Commodore 64'],
    ['Manic Miner', 'ZX Spectrum'], ['Jet Set Willy', 'ZX Spectrum'],
    ['Pac-Man', 'Arcade'],
  ]);
  assert.strictEqual(games[0].id, 'antstream:commodore-64:boulder-dash');
  assert.deepStrictEqual(games[0].platforms, ['PC', 'console', 'Mobile']);
});

test('Antstream help centre: a table with system, publisher and dates', () => {
  const games = antstream.parseList(HELP_TABLE, '2026-10-19');
  assert.deepStrictEqual(games.map((g) => [g.title, g.system, g.publisher, g.releaseYear, g.addedOn, g.comingOn]), [
    ['Air Cavalry', 'Super Nintendo', 'Synergistic', 1995, '2023-04-13', undefined],
    ['Mr. Do!', 'Arcade', 'Universal', 1982, null, '2026-12-03'],
  ]);
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
  ], '2026-10-19');
  assert.deepStrictEqual(out.map((g) => [g.title, g.system, g.image]), [
    ['Boulder Dash', 'Commodore 64', 'https://api.example/img/bd.png'],
    ['Uridium', 'Commodore 64', 'https://api.example/img/u.png'],
    ['Pac-Man', 'Arcade', 'https://cdn.example/pm.jpg'],
  ]);
});

test('Antstream: tries the site when the help centre falls short, and says what it tried', async () => {
  const http = require('../src/providers/http');
  const many = Array.from({ length: 320 }, (_, i) => ({ title: `Game ${i}`, platform: { name: 'Amiga' } }));
  http.setFetch(async () => ({ ok: true, json: async () => ({ article: { body: '<p>See antstream.com</p>' } }) }));
  try {
    const games = await antstream.fetchLive({}, null, { capture: async () => ({ responses: [{ url: 'https://x/api', body: JSON.stringify(many) }], text: '' }) });
    assert.strictEqual(games.length, 320);
    assert.strictEqual(games[0].system, 'Amiga');
    await assert.rejects(antstream.fetchLive({}, null, { capture: async () => ({ responses: [], text: '' }) }), /help centre: 1 games; antstream\.com: 0 games/);
  } finally {
    http.setFetch((...a) => globalThis.fetch(...a));
  }
});

test('Antstream systems map to libretro box art collections', () => {
  assert.strictEqual(covers.systemName('Super NES / Super Famicom'), 'SNES');
  assert.strictEqual(covers.systemName('NES / Famicom'), 'NES');
  assert.strictEqual(covers.systemName('MSX and MSX2'), 'MSX');
  assert.strictEqual(covers.systemName('MS-DOS'), 'DOS');
  assert.strictEqual(covers.systemName('Commodore 64'), 'Commodore 64');
  assert.strictEqual(covers.systemName('Game Boy and Game Boy Color'), 'Game Boy');
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
