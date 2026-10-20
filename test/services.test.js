const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('../src/providers/http');
const gamepass = require('../src/providers/gamepass');
const msextras = require('../src/providers/msextras');
const netflix = require('../src/providers/netflix');
const arcade = require('../src/providers/applearcade');
const nintendo = require('../src/providers/nintendo');
const { unlockedTiers, offerOpen } = require('../src/services');

const jsonResponse = (body, status = 200) => ({ ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) });

const product = (ProductId, kind = 'Game') => ({
  ProductId,
  ProductKind: kind,
  LocalizedProperties: [{ ProductTitle: `Game ${ProductId}`, ShortDescription: `About ${ProductId}`, Images: [{ ImagePurpose: 'Poster', Uri: `//img/${ProductId}` }] }],
  MarketProperties: [{ OriginalReleaseDate: '2020-01-01T00:00:00Z' }],
  Properties: { Categories: ['Action'] },
});

function microsoftCatalogue(lists) {
  return async (url) => {
    const u = new URL(url);
    if (u.host === 'catalog.gamepass.com' && u.pathname === '/subscriptions') return jsonResponse(lists);
    if (u.host === 'displaycatalog.mp.microsoft.com') {
      const ids = u.searchParams.get('bigIds').split(',');
      return jsonResponse({ Products: ids.map((id) => product(id, id.startsWith('DLC') ? 'Durable' : 'Game')) });
    }
    throw new Error(`unexpected ${url}`);
  };
}

test('EA Play: games from Microsoft\'s list, add-ons left out', async () => {
  http.setFetch(microsoftCatalogue({ eaaccess: ['A', 'B', 'DLC1'], ubisoftplus: ['C'] }));
  const games = await msextras.fetchEaPlay({ market: 'GB', language: 'en-gb' });
  assert.deepStrictEqual(games.map((g) => g.id).sort(), ['eaplay:A', 'eaplay:B']);
  assert.deepStrictEqual(games[0].tiers, ['eaplay']);
  assert.strictEqual(games[0].description, 'About A');
});

test('Ubisoft+: Classics on console and PC, Premium adds its own games', async () => {
  http.setFetch(microsoftCatalogue({ nakuconsole: ['A'], nakupc: ['A', 'B'], ubisoftplus: ['A', 'C'] }));
  const byId = Object.fromEntries((await msextras.fetchUbisoftPlus({})).map((g) => [g.id, g]));
  assert.deepStrictEqual(byId['ubisoftplus:A'].tiers.sort(), ['classics', 'premium']);
  assert.deepStrictEqual(byId['ubisoftplus:A'].platforms.sort(), ['console', 'pc']);
  assert.deepStrictEqual(byId['ubisoftplus:B'].platforms, ['pc']);
  assert.deepStrictEqual(byId['ubisoftplus:C'].tiers, ['premium']);
});

test('Microsoft\'s store: a refused batch is retried; no answer at all keeps the last list', async () => {
  let refusals = 1;
  const store = microsoftCatalogue({ nakupc: ['A', 'B'] });
  http.setFetch(async (url) => {
    if (url.includes('displaycatalog') && refusals-- > 0) throw new Error('HTTP 429');
    return store(url);
  });
  assert.strictEqual((await msextras.fetchUbisoftPlus({ retryMs: 1 })).length, 2);
  http.setFetch(async (url) => {
    if (url.includes('displaycatalog')) throw new Error('HTTP 503');
    return store(url);
  });
  await assert.rejects(msextras.fetchUbisoftPlus({ retryMs: 1 }), /store didn't answer for the 2 games/);
});

test('A renamed Microsoft list fails with the names that do exist', async () => {
  http.setFetch(microsoftCatalogue({ gamepass: ['A'], somethingNew: ['B'] }));
  await assert.rejects(msextras.fetchEaPlay({}), /lists: gamepass, somethingNew/);
});

test('Netflix: games from its App Store account, names cleaned', () => {
  const games = netflix.normalize({
    results: [
      { wrapperType: 'artist', artistName: 'Netflix, Inc.' },
      { wrapperType: 'software', trackId: 1, trackName: 'Netflix', primaryGenreName: 'Entertainment', genres: ['Entertainment'] },
      {
        wrapperType: 'software', trackId: 2, trackName: 'Hades NETFLIX', primaryGenreName: 'Games', genres: ['Games', 'Action'],
        artworkUrl512: 'https://icon/2', releaseDate: '2025-03-20T07:00:00Z', trackViewUrl: 'https://apps.apple.com/gb/app/hades/id2?uo=4',
        description: 'Netflix membership required.\n\nDefy the god of the dead as you hack and slash out of the Underworld in this rogue-like dungeon crawler.\n\nMore.',
        screenshotUrls: ['s1', 's2'], ipadScreenshotUrls: ['s3', 's4', 's5'],
      },
    ],
  });
  assert.strictEqual(games.length, 1);
  const [hades] = games;
  assert.strictEqual(hades.title, 'Hades');
  assert.strictEqual(hades.id, 'netflix:2');
  assert.match(hades.description, /^Defy the god/);
  assert.deepStrictEqual(hades.screenshots, ['s1', 's2', 's3', 's4']);
  assert.strictEqual(hades.storeUrl, 'https://apps.apple.com/gb/app/hades/id2');
  assert.deepStrictEqual(hades.genres, ['Action']);
});

const ARCADE_HTML = `
<table class="wikitable sortable"><tbody>
<tr><th>Title</th><th>Developer(s)</th><th>Publisher(s)</th><th>Release date</th></tr>
<tr><td><i><a href="/wiki/Sneaky_Sasquatch">Sneaky Sasquatch</a></i></td><td>RAC7</td><td>RAC7</td><td>September 19, 2019</td></tr>
<tr><td><i>Future Game</i></td><td>Studio</td><td>Studio</td><td>March 5, 2099</td></tr>
<tr><td><i>Sneaky Sasquatch</i></td><td>RAC7</td><td>RAC7</td><td>September 19, 2019</td></tr>
</tbody></table>
<table class="wikitable"><tr><th>Award</th><th>Result</th></tr><tr><td>Best</td><td>Won</td></tr></table>
<table class="wikitable"><tr><th>Title</th><th>Developer</th><th>Release date</th><th>Removed</th><th>Notes</th></tr>
<tr><td><s>Struck Game</s></td><td>A</td><td>September 19, 2019</td><td></td><td></td></tr>
<tr><td>Gone Game</td><td>B</td><td>September 19, 2019</td><td>June 1, 2023</td><td></td></tr>
<tr><td>Noted Game</td><td>C</td><td>September 19, 2019</td><td></td><td>Removed from the service</td></tr>
<tr><td>Leaving Game</td><td>D</td><td>September 19, 2019</td><td>January 1, 2099</td><td></td></tr>
</table>
<h2>Removed games</h2>
<table class="wikitable"><tr><th>Title</th><th>Developer</th></tr><tr><td>Old Game</td><td>E</td></tr></table>`;

test('Apple Arcade: Wikipedia list with announced games marked as coming, removed games left out', () => {
  const games = arcade.parseWikipedia(ARCADE_HTML, '2026-10-16');
  assert.deepStrictEqual(games.map((g) => [g.id, g.addedOn, g.comingOn]), [
    ['applearcade:sneaky-sasquatch', '2019-09-19', null],
    ['applearcade:future-game', null, '2099-03-05'],
    ['applearcade:struck-game', '2019-09-19', null],
    ['applearcade:gone-game', '2019-09-19', null],
    ['applearcade:noted-game', '2019-09-19', null],
    ['applearcade:leaving-game', '2019-09-19', null],
    ['applearcade:old-game', null, null],
  ]);
  const by = Object.fromEntries(games.map((g) => [g.title, g]));
  assert.ok(by['Leaving Game'].leavingSoon && !by['Leaving Game'].gone);
  assert.deepStrictEqual(['Struck Game', 'Gone Game', 'Noted Game', 'Old Game'].map((t) => [by[t].gone, by[t].leftOn]),
    [[true, null], [true, '2023-06-01'], [true, null], [true, null]]);
  assert.ok(!by['Sneaky Sasquatch'].gone);
  assert.strictEqual(games[0].developer, 'RAC7');
});

test('Apple Arcade: App Store details looked up once, then reused', async () => {
  let searches = 0;
  http.setFetch(async (url) => {
    searches += 1;
    const term = new URL(url).searchParams.get('term');
    if (term === 'Unknown Game') return jsonResponse({ results: [] });
    return jsonResponse({ results: [
      { trackName: 'Sneaky Sasquatch Party', artworkUrl512: 'https://wrong' },
      { trackName: 'Sneaky Sasquatch', artworkUrl512: 'https://icon', trackViewUrl: 'https://apps.apple.com/app/id1?uo=4', description: 'Short.\n\nLive the life of a sasquatch, sneaking through campsites for picnic food.', screenshotUrls: ['a'], genres: ['Games', 'Adventure'] },
    ] });
  });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arcade-'));
  const games = [{ id: 'applearcade:sneaky-sasquatch', title: 'Sneaky Sasquatch', genres: [] }, { id: 'applearcade:unknown', title: 'Unknown Game', genres: [] }];
  assert.strictEqual(await arcade.lookupMissing(games, dir, 'gb', { delayMs: 0 }), 1);
  const [sneaky, unknown] = arcade.applyCached(games, dir);
  assert.strictEqual(sneaky.image, 'https://icon');
  assert.strictEqual(sneaky.storeUrl, 'https://apps.apple.com/app/id1');
  assert.match(sneaky.description, /^Live the life/);
  assert.deepStrictEqual(sneaky.genres, ['Adventure']);
  assert.strictEqual(unknown.image, undefined);
  // On neither App Store: left the service. Found there: still in it.
  assert.deepStrictEqual([unknown.gone, sneaky.gone], [true, undefined]);
  await arcade.lookupMissing(games, dir, 'gb', { delayMs: 0 });
  assert.strictEqual(searches, 4); // a miss asks the US store and Steam too, then is cached
});

test('Games a source lists as gone join the departed list with their date', () => {
  const { applyHistory } = require('../src/catalog');
  const prev = { source: 'live', origin: 'live', games: [{ id: 'a', title: 'A' }, { id: 'b', title: 'B' }], history: { firstSeen: {}, departed: [] } };
  const { history, removed } = applyHistory(prev, [{ id: 'a', title: 'A' }], 'live', [{ id: 'b', title: 'B', gone: true, leftOn: '2023-06-01' }, { id: 'c', title: 'C', gone: true, leftOn: null }]);
  assert.deepStrictEqual(removed, ['B']);
  assert.deepStrictEqual(history.departed.map((g) => [g.id, g.leftOn, !!g.gone]), [['b', '2023-06-01', false], ['c', null, false]]);
});

test('Apple Arcade: an app by the same developer without the subtitle counts', () => {
  const items = [
    { name: 'Hexaflip', r: { artistName: 'Rogue Games, Inc.' } },
    { name: 'Hexagon Flip', r: { artistName: 'Someone Else' } },
  ];
  assert.strictEqual(arcade.pickApp(items, 'Hexaflip: The Action Puzzler', 'Rogue Games').name, 'Hexaflip');
  assert.strictEqual(arcade.pickApp(items, 'Hexaflip: The Action Puzzler', 'Other Studio'), null);
  assert.strictEqual(arcade.pickApp(items, 'Hexaflip: The Action Puzzler', null), null);
});

test('Apple Arcade: a game gone from the App Store gets its Steam cover', async () => {
  http.setFetch(async (url) => {
    const u = new URL(url);
    if (u.host === 'itunes.apple.com') return jsonResponse({ results: [] });
    return jsonResponse({ items: [
      { type: 'app', id: 7, name: 'Overland 2', tiny_image: 'https://x/apps/7/capsule_231x87.jpg' },
      { type: 'app', id: 8, name: 'Overland', tiny_image: 'https://x/apps/8/capsule_231x87.jpg?t=1' },
    ] });
  });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arcade-'));
  const games = [{ id: 'applearcade:overland', title: 'Overland', genres: ['Strategy'] }];
  assert.strictEqual(await arcade.lookupMissing(games, dir, 'gb', { delayMs: 0 }), 1);
  const [overland] = arcade.applyCached(games, dir);
  assert.match(overland.image, /\/apps\/8\/library_600x900\.jpg$/);
  assert.strictEqual(overland.imageFallback, 'https://x/apps/8/header.jpg?t=1');
  assert.deepStrictEqual(overland.genres, ['Strategy']);
  assert.ok(overland.gone); // only on Steam now
  const { Catalog } = require('../src/catalog');
  const cat = new Catalog(path.dirname(dir));
  cat.appStoreDir = () => dir;
  cat.cache.applearcade = { service: 'applearcade', source: 'live', origin: 'live', games: [...games, { id: 'applearcade:x', title: 'Coming', comingOn: '2099-01-01', genres: [] }], history: { firstSeen: {}, departed: [] } };
  const next = cat.reapplyArcade();
  assert.deepStrictEqual(next.games.map((g) => g.id), ['applearcade:x']);
  assert.deepStrictEqual(next.history.departed.map((g) => [g.id, g.leftOn, g.departed]), [['applearcade:overland', null, true]]);
});

test('Apple Arcade lookups stop at the first refusal', async () => {
  let searches = 0;
  http.setFetch(async () => { searches += 1; return jsonResponse({}, 403); });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arcade-'));
  const games = Array.from({ length: 5 }, (_, i) => ({ id: `applearcade:${i}`, title: `Game ${i}` }));
  assert.strictEqual(await arcade.lookupMissing(games, dir, 'us', { delayMs: 0 }), 0);
  assert.strictEqual(searches, 1);
});

test('Game Pass join dates for games already in it', () => {
  const now = Date.parse('2026-10-17T00:00:00Z');
  const joined = gamepass.joinDates({
    EDAY: { ultimateSubMetadata: { EntranceDate: '2026-10-06T00:00:00Z' }, pcSubMetadata: { EntranceDate: '2026-10-07T00:00:00Z' } },
    SOON: { ultimateSubMetadata: { EntranceDate: '2026-10-28T00:00:00Z' } },
  }, now);
  assert.deepStrictEqual([...joined], [['EDAY', '2026-10-06']]);
});

test('Game Pass upcoming: future join dates per plan, unknown far-future dates skipped', () => {
  const now = Date.parse('2026-10-16T00:00:00Z');
  const soon = gamepass.comingSoon({
    A: { pcSubMetadata: { EntranceDate: '2026-10-28T00:00:00Z' }, ultimateSubMetadata: { EntranceDate: '2026-10-28T00:00:00Z' } },
    B: { standardSubMetadata: { EntranceDate: '2026-11-04T00:00:00Z' } },
    C: { ultimateSubMetadata: { EntranceDate: '2026-01-01T00:00:00Z' } }, // already in
    D: { ultimateSubMetadata: { EntranceDate: '9998-12-31T00:00:00Z' } }, // no date yet
  }, now);
  assert.deepStrictEqual([...soon.keys()].sort(), ['A', 'B']);
  assert.strictEqual(soon.get('A').date, '2026-10-28');
  assert.deepStrictEqual([...soon.get('A').tiers].sort(), ['pc', 'ultimate']);
  assert.deepStrictEqual([...soon.get('A').platforms].sort(), ['console', 'pc']);
  assert.deepStrictEqual([...soon.get('B').tiers], ['premium']);
});

test('Switch Online: games listed ahead of their date are coming', () => {
  const html = fs.readFileSync(path.join(__dirname, 'fixtures', 'wikipedia-classics.html'), 'utf8');
  const games = nintendo.parseWikipedia(html, '2020-01-01');
  const mario = games.find((g) => g.title === 'Super Mario 64');
  assert.strictEqual(mario.comingOn, '2021-10-25');
  assert.strictEqual(games.find((g) => g.title === 'Balloon Fight').comingOn, undefined);
});

test('Game Pass Ultimate unlocks EA Play and Ubisoft+ Classics', () => {
  const keys = unlockedTiers({ gamepass: 'ultimate' });
  assert.ok(keys.has('eaplay:eaplay'));
  assert.ok(keys.has('ubisoftplus:classics'));
  assert.ok(!keys.has('ubisoftplus:premium'));
  const pc = unlockedTiers({ gamepass: 'pc' });
  assert.ok(!pc.has('ubisoftplus:classics'));
  // PC Game Pass has EA Play on PC only.
  const ea = (platforms) => ({ service: 'eaplay', tiers: ['eaplay'], platforms });
  assert.ok(offerOpen(pc, ea(['pc'])));
  assert.ok(!offerOpen(pc, ea(['console'])));
  assert.ok(offerOpen(keys, ea(['console'])));
});
