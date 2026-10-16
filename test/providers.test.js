const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('../src/providers/http');
const gamepass = require('../src/providers/gamepass');
const psplus = require('../src/providers/psplus');
const nintendo = require('../src/providers/nintendo');
const { Catalog, mergeDuplicates, titleKey } = require('../src/catalog');
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
          LocalizedProperties: [{ ProductTitle: `Game ${ProductId}`, Images: [{ ImagePurpose: 'Poster', Uri: `//img/${ProductId}` }] }],
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
});

test('PS Plus: catalogue and classics merge into tiers', () => {
  const games = psplus.normalize({ extra: fixture('ps-extra.json'), premium: fixture('ps-classics.json'), essential: [] });
  assert.strictEqual(games.length, 5);
  const classic = games.find((g) => g.title.startsWith('Alone in the Dark 2'));
  assert.deepStrictEqual(classic.tiers, ['premium']);
  const hat = games.find((g) => g.title === 'A Hat in Time');
  assert.deepStrictEqual(hat.tiers, ['extra']);
  assert.deepStrictEqual(hat.platforms, ['PS4']);
});

test('Nintendo source parses sections and tiers', () => {
  const games = nintendo.parseSource('### NES | base\nMetroid\n\n### N64 | expansion\n# comment\nSuper Mario 64\n');
  assert.deepStrictEqual(games.map((g) => [g.title, g.tiers[0], g.platforms[0]]), [['Metroid', 'base', 'NES'], ['Super Mario 64', 'expansion', 'N64']]);
  assert.ok(nintendo.load().length > 300);
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
