const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('../src/providers/http');
const gamepass = require('../src/providers/gamepass');
const psplus = require('../src/providers/psplus');
const nintendo = require('../src/providers/nintendo');
const covers = require('../src/providers/covers');
const { Catalog, mergeDuplicates, titleKey, applyHistory } = require('../src/catalog');
const { normalizeSettings } = require('../src/store');
const { unlockedTiers } = require('../src/services');

const fixture = (name) => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8'));
const jsonResponse = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });

test('Game Pass mirror: tiers, PC Game Pass and leaving soon', () => {
  const games = gamepass.normalizeMirror(fixture('catabox-sample.json'));
  const evil = games.find((g) => g.title === 'Evil West');
  assert.ok(evil.leavingSoon);
  const resist = games.find((g) => g.title === '1000xRESIST');
  assert.deepStrictEqual(resist.tiers.sort(), ['pc', 'premium', 'ultimate']);
  assert.match(resist.storeUrl, /xbox\.com\/games\/store\/x\/9NPDN9R45JX4$/);
  assert.match(resist.description, /sci-fi adventure/);
  assert.ok(resist.screenshots.length > 0 && resist.screenshots.length <= 4);
});

test('Game Pass live: lists, leaving soon and product details', async () => {
  http.setFetch(async (url) => {
    const u = new URL(url);
    if (u.host === 'catalog.gamepass.com') {
      const id = u.searchParams.get('id');
      const pc = u.searchParams.get('platformContext') === 'pc';
      if (id === '393f05bf-e596-4ef6-9487-6d4fa0eab987') return jsonResponse([{ siglId: id }, { id: 'B' }]);
      if (id === 'cc7fc951-d00f-410e-9e02-5e4628e04163') return jsonResponse([{ siglId: id }]);
      if (id === '97c6c862-d28a-4907-a3d5-c401f2296a53') return jsonResponse([{ siglId: id }, { id: 'A' }, { id: 'B' }, ...(pc ? [{ id: 'C' }] : [])]);
      if (id === '09a72c0d-c466-426a-9580-b78955d8173a') return jsonResponse([{ siglId: id }, { id: 'A' }]);
      return jsonResponse([{ siglId: id }]);
    }
    if (u.host === 'displaycatalog.mp.microsoft.com') {
      const ids = u.searchParams.get('bigIds').split(',');
      return jsonResponse({
        Products: ids.map((ProductId) => ({
          ProductId,
          LocalizedProperties: [{
            ProductTitle: `Game ${ProductId}`,
            ShortDescription: `About ${ProductId}`,
            DeveloperName: 'Studio X',
            PublisherName: 'Publisher Y',
            Images: [
              { ImagePurpose: 'Poster', Uri: `//img/${ProductId}` },
              { ImagePurpose: 'Screenshot', Uri: `//shot/${ProductId}/1` },
              { ImagePurpose: 'Screenshot', Uri: `//shot/${ProductId}/1` },
              { ImagePurpose: 'Screenshot', Uri: `//shot/${ProductId}/2` },
            ],
          }],
          MarketProperties: [{ OriginalReleaseDate: '2024-03-01T00:00:00Z' }],
          Properties: { Categories: ['Action'] },
        })),
      });
    }
    throw new Error(`unexpected ${url}`);
  });
  const games = await gamepass.fetchLive();
  const byId = Object.fromEntries(games.map((g) => [g.id, g]));
  assert.deepStrictEqual(byId['gamepass:A'].tiers.sort(), ['pc', 'premium', 'ultimate']);
  assert.ok(byId['gamepass:B'].leavingSoon);
  assert.deepStrictEqual(byId['gamepass:C'].platforms, ['pc']);
  assert.strictEqual(byId['gamepass:A'].image, 'https://img/A');
  assert.strictEqual(byId['gamepass:A'].releaseDate, '2024-03-01');
  assert.strictEqual(byId['gamepass:A'].description, 'About A');
  assert.deepStrictEqual([byId['gamepass:A'].developer, byId['gamepass:A'].publisher], ['Studio X', 'Publisher Y']);
  assert.deepStrictEqual(byId['gamepass:A'].screenshots, ['https://shot/A/1?w=960', 'https://shot/A/2?w=960']);
});

test('PS Plus: catalogue and classics merge into tiers', () => {
  const games = psplus.normalize({ extra: fixture('ps-extra.json'), premium: fixture('ps-classics.json'), essential: [] });
  assert.strictEqual(games.length, 5);
  const classic = games.find((g) => g.title.startsWith('Alone in the Dark 2'));
  assert.deepStrictEqual(classic.tiers, ['premium']);
  const hat = games.find((g) => g.title === 'A Hat in Time');
  assert.deepStrictEqual(hat.tiers, ['extra']);
  assert.deepStrictEqual(hat.platforms, ['PS4']);
  // The list says per game whether PS Plus Premium can stream it.
  assert.ok(!hat.stream);
  assert.strictEqual(classic.stream, true);
});

test('Bundled Switch Online snapshot has every system and most covers', () => {
  const { games } = fixture('../../data/snapshot/nso.json');
  assert.ok(games.length > 300);
  assert.strictEqual(new Set(games.map((g) => g.platforms[0])).size, 8);
  assert.ok(games.filter((g) => g.image).length / games.length > 0.95);
});

test('Wikipedia Nintendo Classics tables: systems, shared dates, two-row headers, removed games skipped, regions kept', () => {
  const html = fs.readFileSync(path.join(__dirname, 'fixtures', 'wikipedia-classics.html'), 'utf8');
  const games = nintendo.parseWikipedia(html);
  assert.deepStrictEqual(games.slice(2, 4).map((g) => g.publisher), ['Tecmo', 'Jaleco']);
  assert.deepStrictEqual(games.map((g) => [g.platforms[0], g.title, g.tiers[0], g.addedOn, g.regions.join('+')]), [
    ['NES', 'Balloon Fight', 'base', '2018-09-19', 'west+jp'],
    ['NES', 'Dr. Mario', 'base', '2018-09-19', 'west+jp'],
    ['NES', "Fire 'n Ice", 'base', '2018-09-19', 'west'],
    ['NES', 'Ninja JaJaMaru-kun', 'base', '2018-10-10', 'jp'],
    ['Game Boy', 'Dr. Mario', 'base', '2023-02-08', 'west+jp'],
    ['Game Boy', 'Game & Watch Gallery 3', 'base', '2023-03-16', 'west+jp'],
    ['N64', 'Super Mario 64', 'expansion', '2021-10-25', 'west+jp'],
    ['N64', 'Japan Only 64', 'expansion', '2021-10-25', 'jp'],
    ['N64', 'Super Mario 64 SP', 'expansion', '2021-10-25', 'west+jp'],
  ]);
  // Same ids as the bundled list, so marks survive switching sources.
  assert.strictEqual(games[0].id, 'nso:nes:balloon-fight');
});

test('Wikipedia result that looks broken is rejected', async () => {
  http.setFetch(async () => jsonResponse({ parse: { text: '<p>nothing here</p>' } }));
  await assert.rejects(nintendo.fetchLive(), /incomplete/);
});

test('Covers: No-Intro names, region preference, aliases and GitHub listing', async () => {
  const listings = {
    'Nintendo_-_Super_Nintendo_Entertainment_System': [
      'Legend of Zelda, The - A Link to the Past (Europe).png',
      'Legend of Zelda, The - A Link to the Past (USA).png',
      'Legend of Zelda, The - A Link to the Past (USA) (Beta).png',
      'Mario to Wario (Japan) (En).png',
      "Donkey Kong Country 2 - Diddy's Kong Quest (USA) (En,Fr).png",
    ],
  };
  const index = covers.buildIndex(listings);
  assert.match(covers.match(index, 'SNES', 'The Legend of Zelda: A Link to the Past'), /A%20Link%20to%20the%20Past%20\(USA\)\.png$/);
  assert.match(covers.match(index, 'SNES', 'Mario & Wario'), /Mario%20to%20Wario/);
  assert.strictEqual(covers.match(index, 'SNES', 'Unknown Game'), null);
  // Special editions, regional copies and shortened titles use the base game's art.
  assert.match(covers.match(index, 'SNES', 'The Legend of Zelda: A Link to the Past SP (Ganon battle)'), /\(USA\)\.png$/);
  assert.match(covers.match(index, 'SNES', 'The Legend of Zelda: A Link to the Past (JP)'), /\(USA\)\.png$/);
  assert.match(covers.match(index, 'SNES', 'Donkey Kong Country 2'), /Diddy's%20Kong%20Quest/);

  const calls = [];
  http.setFetch(async (url) => {
    calls.push(url);
    if (url.endsWith('/git/trees/master')) return jsonResponse({ tree: [{ path: 'Named_Boxarts', type: 'tree', sha: 'abc' }] });
    if (url.endsWith('/git/trees/abc')) return jsonResponse({ tree: [{ path: 'Super Metroid (Japan, USA) (En).png', type: 'blob' }] });
    throw new Error('offline');
  });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'covers-'));
  const game = { id: 'nso:snes:super-metroid', service: 'nso', title: 'Super Metroid', platforms: ['SNES'], image: null };
  const [withCover] = await covers.apply([game], dir);
  assert.match(withCover.image, /^https:\/\/raw\.githubusercontent\.com\/libretro-thumbnails\/.*Super%20Metroid/);
  // Listings are cached, so a second run makes no requests.
  const before = calls.length;
  await covers.apply([game], dir);
  assert.strictEqual(calls.length, before);
});

test('Covers fall back to the bundled map when GitHub is unreachable', async () => {
  http.setFetch(async () => { throw new Error('offline'); });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'covers-'));
  const [g] = await covers.apply([{ id: 'nso:n64:super-mario-64', service: 'nso', title: 'Super Mario 64', platforms: ['N64'], image: null }], dir);
  assert.match(g.image, /Super%20Mario%2064/);
});

test('Retro games with the same title on two systems stay separate', () => {
  const games = [nintendo.makeGame('NES', 'base', 'Dr. Mario'), nintendo.makeGame('Game Boy', 'base', 'Dr. Mario')];
  assert.strictEqual(mergeDuplicates(games).length, 2);
});

test('Windows duplicates fold into one game', () => {
  assert.strictEqual(titleKey('Evil West (Windows)'), titleKey('Evil West'));
  assert.strictEqual(titleKey('A Plague Tale: Requiem - Windows'), 'a plague tale requiem');
  const merged = mergeDuplicates([
    { id: 'gamepass:W', service: 'gamepass', title: 'Evil West (Windows)', platforms: ['pc'], tiers: ['pc'], leavingSoon: true, image: null },
    { id: 'gamepass:X', service: 'gamepass', title: 'Evil West', platforms: ['console'], tiers: ['premium'], leavingSoon: false, image: 'x' },
  ]);
  assert.strictEqual(merged.length, 1);
  assert.strictEqual(merged[0].id, 'gamepass:X');
  assert.ok(merged[0].leavingSoon);
  assert.deepStrictEqual(merged[0].platforms.sort(), ['console', 'pc']);
});

test('Refresh falls back to mirror and records added/departed games', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'subcat-'));
  const catalog = new Catalog(dir);
  let mirrorGames = [{ id: 'P1', title: 'One' }, { id: 'P2', title: 'Two' }];
  http.setFetch(async (url) => {
    if (url.includes('playstation.com')) throw new Error('offline');
    const list = url.endsWith('plus-games-list.json')
      ? [{ games: mirrorGames.map((g) => ({ conceptId: g.id, name: g.title, device: ['PS5'] })) }]
      : [];
    return jsonResponse(list);
  });
  const first = await catalog.refresh('psplus', {});
  assert.strictEqual(first.source, 'mirror');
  assert.deepStrictEqual(first.added, []); // first refresh after the bundled list is a baseline

  mirrorGames = [{ id: 'P2', title: 'Two' }, { id: 'P3', title: 'Three' }];
  const second = await catalog.refresh('psplus', {});
  assert.deepStrictEqual(second.added, ['Three']);
  assert.deepStrictEqual(second.removed, ['One']);
  const saved = new Catalog(dir).load('psplus');
  assert.ok(saved.history.firstSeen['psplus:P3']);
  assert.strictEqual(saved.history.departed[0].title, 'One');
});

test('Switching source or region starts a new baseline instead of fake departures', () => {
  const prev = { source: 'live', origin: 'live:GB', games: [{ id: 'a', title: 'A' }, { id: 'b', title: 'B' }], history: { firstSeen: {}, departed: [] } };
  const fromMirror = applyHistory(prev, [{ id: 'a', title: 'A' }], 'mirror');
  assert.deepStrictEqual(fromMirror.removed, []);
  assert.strictEqual(fromMirror.history.departed.length, 0);
  const otherRegion = applyHistory(prev, [{ id: 'a', title: 'A' }], 'live:US');
  assert.deepStrictEqual(otherRegion.removed, []);
  const same = applyHistory(prev, [{ id: 'a', title: 'A' }], 'live:GB');
  assert.deepStrictEqual(same.removed, ['B']);
});

test('UK region codes become the GB codes Microsoft and Sony use', () => {
  assert.deepStrictEqual(normalizeSettings({ market: 'uk', language: 'en-UK', psLocale: 'en_uk' }), { region: 'GB', market: 'GB', language: 'en-gb', psLocale: 'en-gb' });
  assert.strictEqual(normalizeSettings({ market: 'us' }).market, 'US');
  // Picking a country sets every store code.
  assert.deepStrictEqual(normalizeSettings({ region: 'DE', market: 'US', language: 'en-us', psLocale: 'en-us' }), { region: 'DE', market: 'DE', language: 'en-gb', psLocale: 'de-de' });
});

test('Refresh keeps the previous list when every source fails', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'subcat-'));
  const catalog = new Catalog(dir);
  const before = catalog.load('gamepass').games.length;
  http.setFetch(async () => { throw new Error('offline'); });
  const result = await catalog.refresh('gamepass', {});
  assert.strictEqual(result.ok, false);
  assert.strictEqual(catalog.load('gamepass').games.length, before);
  assert.ok(before > 500);
});

test('Higher tiers unlock the games of lower ones', () => {
  const keys = unlockedTiers({ gamepass: 'ultimate', psplus: 'extra', nso: 'base' });
  for (const k of ['gamepass:essential', 'gamepass:pc', 'psplus:extra', 'psplus:essential', 'nso:base']) assert.ok(keys.has(k), k);
  assert.ok(!keys.has('psplus:premium'));
  assert.ok(!keys.has('nso:expansion'));
});
