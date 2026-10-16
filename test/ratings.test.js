const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('../src/providers/http');
const { Ratings, HowLongToBeat, metacritic, cleanTitle, pickMatch, lookupKey } = require('../src/ratings');

const jsonResponse = (body, status = 200) => ({ ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) });
const textResponse = (body, status = 200) => ({ ok: status < 400, status, text: async () => body });

test('Store titles are cleaned for searching', () => {
  assert.strictEqual(cleanTitle('A Plague Tale: Requiem™'), 'A Plague Tale: Requiem');
  assert.strictEqual(cleanTitle('STAR WARS: Bounty Hunter (Classic, 2002)'), 'STAR WARS: Bounty Hunter');
  assert.strictEqual(cleanTitle('A Little to the Left PS4 & PS5'), 'A Little to the Left');
  assert.strictEqual(cleanTitle('Forza Horizon 5 - Windows'), 'Forza Horizon 5');
  assert.strictEqual(cleanTitle('Adventures of Lolo (NA)'), 'Adventures of Lolo');
  assert.strictEqual(cleanTitle('Metroid SP (Ridley battle)'), 'Metroid');
});

test('Search results match exactly, then without the edition, closest year first', () => {
  const items = [
    { name: 'Halo Wars', year: 2009 },
    { name: 'Halo Wars 2', year: 2017 },
    { name: 'Resident Evil 2', year: 1998 },
    { name: 'Resident Evil 2', year: 2019 },
    { name: 'Age of Empires II', year: 1999 },
  ];
  assert.strictEqual(pickMatch(items, 'Halo Wars 2', null).year, 2017);
  assert.strictEqual(pickMatch(items, 'RESIDENT EVIL 2', 2019).year, 2019);
  assert.strictEqual(pickMatch(items, 'Age of Empires II: Definitive Edition', 2019).name, 'Age of Empires II');
  assert.strictEqual(pickMatch(items, 'Halo', null), null);
});

test('Metacritic: game results only, score and page link', async () => {
  http.setFetch(async (url) => {
    assert.match(url, /^https:\/\/backend\.metacritic\.com\/finder\/metacritic\/search\/(Hades|9%20Kings)\/web\?apiKey=/);
    return jsonResponse({ data: { items: [
      { type: 'person', title: 'Hades' },
      { type: 'game-title', title: 'Hades II', slug: 'hades-ii', releaseDate: '2025-09-25', criticScoreSummary: { score: 95 } },
      { type: 'game-title', title: 'Hades', slug: 'hades', releaseDate: '2020-09-17', criticScoreSummary: { score: 93 } },
      { type: 'game-title', title: '9 Kings', slug: '9-kings', criticScoreSummary: { score: 0 } },
    ] } });
  });
  assert.deepStrictEqual(await metacritic('Hades', 2020), { score: 93, url: 'https://www.metacritic.com/game/hades/' });
  // Not enough reviews yet: no score rather than 0.
  assert.deepStrictEqual(await metacritic('9 Kings', null), { score: null, url: 'https://www.metacritic.com/game/9-kings/' });
});

test('How Long To Beat: finds the search endpoint and token, then searches', async () => {
  const calls = [];
  http.setFetch(async (url, opts = {}) => {
    calls.push(url);
    if (url === 'https://howlongtobeat.com/') return textResponse('<script src="/_next/static/chunks/pages/_app-abc.js"></script>');
    if (url.endsWith('_app-abc.js')) return textResponse('x=fetch("/api/seek/".concat(k),{method:"POST",headers:h})');
    if (url.startsWith('https://howlongtobeat.com/api/seek/init?t=')) return jsonResponse({ token: 'tok', hpKey: 'abc', hpVal: 'xyz' });
    if (url === 'https://howlongtobeat.com/api/seek') {
      assert.strictEqual(opts.method, 'POST');
      assert.strictEqual(opts.headers['x-auth-token'], 'tok');
      assert.strictEqual(opts.headers['x-hp-key'], 'abc');
      const body = JSON.parse(opts.body);
      assert.deepStrictEqual(body.searchTerms, ['Celeste']);
      assert.strictEqual(body.abc, 'xyz');
      return jsonResponse({ data: [
        { game_id: 2, game_name: 'Celeste Classic', comp_main: 1800 },
        { game_id: 42, game_name: 'Celeste', release_world: 2018, comp_main: 28800, comp_plus: 54000, comp_100: 136800 },
      ] });
    }
    throw new Error(`unexpected ${url}`);
  });
  const hltb = new HowLongToBeat();
  assert.deepStrictEqual(await hltb.search('Celeste', 2018), { main: 8, plus: 15, all: 38, url: 'https://howlongtobeat.com/game/42' });
  await hltb.search('Celeste', 2018);
  assert.strictEqual(calls.filter((u) => u.includes('/init')).length, 1); // session reused
});

test('Background lookups: shared titles once, retro systems apart, cached on disk', async () => {
  let searches = 0;
  http.setFetch(async (url, opts = {}) => {
    if (url.includes('metacritic')) {
      searches += 1;
      const q = decodeURIComponent(url.split('/search/')[1].split('/web')[0]);
      return jsonResponse({ data: { items: [{ type: 'game-title', title: q, slug: 'x', criticScoreSummary: { score: 80 } }] } });
    }
    if (url === 'https://howlongtobeat.com/') return textResponse('');
    if (url.includes('/init')) return jsonResponse({ token: 't' });
    if (opts.method === 'POST') {
      const q = JSON.parse(opts.body).searchTerms.join(' ');
      return jsonResponse({ data: [{ game_id: 1, game_name: q, comp_main: 3600 }] });
    }
    throw new Error(`unexpected ${url}`);
  });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ratings-'));
  const games = [
    { id: 'gamepass:A', service: 'gamepass', title: 'Hades', platforms: ['pc'], tiers: ['ultimate'] },
    { id: 'psplus:1', service: 'psplus', title: 'Hades™', platforms: ['PS5'], tiers: ['extra'] },
    { id: 'nso:nes:dr-mario', service: 'nso', title: 'Dr. Mario', platforms: ['NES'], tiers: ['base'] },
    { id: 'nso:game-boy:dr-mario', service: 'nso', title: 'Dr. Mario', platforms: ['Game Boy'], tiers: ['base'] },
  ];
  assert.notStrictEqual(lookupKey(games[2]), lookupKey(games[3]));
  const updates = {};
  const r = new Ratings(dir, { onUpdate: (u) => Object.assign(updates, u) });
  await r.start(games);
  assert.strictEqual(searches, 3);
  assert.deepStrictEqual(Object.keys(updates).sort(), games.map((g) => g.id).sort());
  assert.strictEqual(updates['psplus:1'].mc, 80);
  assert.deepStrictEqual(updates['psplus:1'].hltb, { main: 1, plus: null, all: null });
  const again = new Ratings(dir);
  await again.start(games);
  assert.strictEqual(searches, 3); // nothing re-fetched
  assert.strictEqual(again.forGames(games)['gamepass:A'].mc, 80);
});

test('Background lookups stop when both sites are unreachable', async () => {
  http.setFetch(async () => { throw new Error('offline'); });
  const games = Array.from({ length: 40 }, (_, i) => ({ id: `gamepass:${i}`, service: 'gamepass', title: `Game ${i}`, platforms: ['pc'], tiers: [] }));
  let last = null;
  const r = new Ratings(fs.mkdtempSync(path.join(os.tmpdir(), 'ratings-')), { onProgress: (p) => { last = p; } });
  await r.start(games);
  assert.ok(last.finished && last.failed);
  assert.deepStrictEqual(r.forGames(games), {});
});
