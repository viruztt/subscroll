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

// The shape of Wikipedia's parse output for the Antstream article.
const WIKI = `
<div class="mw-heading mw-heading2"><h2 id="Games">Games</h2></div>
<div class="mw-heading mw-heading3"><h3 id="Super_NES">Super NES / Super Famicom</h3></div>
<table class="wikitable sortable"><tbody>
<tr><th>Title</th><th>Publisher</th><th>Original release</th><th>Release date</th></tr>
<tr><td><i><a href="/wiki/Air_Cavalry">Air Cavalry</a></i></td><td>Synergistic Software</td><td>1995</td><td>April 13, 2023</td></tr>
<tr><td><i>B.O.B.</i><sup>[1]</sup></td><td>Gray Matter</td><td>1993</td><td>August 2024</td></tr>
</tbody></table>
<div class="mw-heading mw-heading3"><h3 id="ZX">ZX Spectrum</h3></div>
<table class="wikitable"><tbody>
<tr><th>Title</th><th>Publisher</th><th>Original release</th><th>Release date</th></tr>
<tr><td>Manic Miner</td><td>Bug-Byte</td><td>1983</td><td>December 3, 2026</td></tr>
</tbody></table>
<div class="mw-heading mw-heading2"><h2 id="Reception">Reception</h2></div>
<table class="wikitable"><tbody><tr><th>Publication</th><th>Score</th></tr><tr><td>IGN</td><td>8/10</td></tr></tbody></table>`;

test('Antstream: a game per table row, with its system and dates', () => {
  const games = antstream.parseWikipedia(WIKI, '2026-10-19');
  assert.deepStrictEqual(games.map((g) => g.title), ['Air Cavalry', 'B.O.B.', 'Manic Miner']);
  const air = games[0];
  assert.strictEqual(air.id, 'antstream:super-nes-super-famicom:air-cavalry');
  assert.strictEqual(air.system, 'Super NES / Super Famicom');
  assert.strictEqual(air.addedOn, '2023-04-13');
  assert.strictEqual(air.releaseYear, 1995);
  assert.strictEqual(air.publisher, 'Synergistic Software');
  assert.strictEqual(games[1].addedOn, '2024-08-01');
  // Announced for later: coming, not added.
  assert.strictEqual(games[2].comingOn, '2026-12-03');
  assert.strictEqual(games[2].addedOn, null);
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
