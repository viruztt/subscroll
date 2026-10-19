const test = require('node:test');
const assert = require('node:assert');
const http = require('../src/providers/http');
const steam = require('../src/steam');

const jsonResponse = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });

test('Steam profile links, IDs and custom names are understood', () => {
  assert.deepStrictEqual(steam.parseProfile('https://steamcommunity.com/profiles/76561197960287930/'), { steamId: '76561197960287930' });
  assert.deepStrictEqual(steam.parseProfile(' 76561197960287930 '), { steamId: '76561197960287930' });
  assert.deepStrictEqual(steam.parseProfile('steamcommunity.com/id/gabelogannewell/games'), { vanity: 'gabelogannewell' });
  assert.deepStrictEqual(steam.parseProfile('gabelogannewell'), { vanity: 'gabelogannewell' });
  assert.strictEqual(steam.parseProfile('not a profile at all'), null);
});

const catalogue = [
  { id: 'gamepass:1', service: 'gamepass', title: 'DOOM Eternal (PC)', tiers: ['pc'], platforms: ['pc'] },
  { id: 'eaplay:2', service: 'eaplay', title: 'DOOM Eternal', tiers: ['eaplay'], platforms: ['pc'] },
  { id: 'gamepass:3', service: 'gamepass', title: 'Hades', tiers: ['pc'], platforms: ['pc'] },
  { id: 'gamepass:4', service: 'gamepass', title: 'Celeste', tiers: ['pc'], platforms: ['pc'] },
  { id: 'gamepass:5', service: 'gamepass', title: 'Tetris Effect: Connected', tiers: ['pc'], platforms: ['pc'] },
  { id: 'nso:6', service: 'nso', title: 'Tetris', tiers: ['nso'], platforms: ['NES'] },
];

function fakeSteam(games, { vanity = {} } = {}) {
  const calls = [];
  http.setFetch(async (url) => {
    const u = new URL(url);
    calls.push(u.pathname);
    if (u.searchParams.get('key') !== 'KEY') return jsonResponse({}, 403);
    if (u.pathname.includes('ResolveVanityURL')) {
      const id = vanity[u.searchParams.get('vanityurl')];
      return jsonResponse({ response: id ? { success: 1, steamid: id } : { success: 42 } });
    }
    if (u.pathname.includes('GetOwnedGames')) return jsonResponse({ response: games });
    throw new Error(`unexpected ${url}`);
  });
  return calls;
}

const library = {
  game_count: 4,
  games: [
    { appid: 782330, name: 'DOOM Eternal', playtime_forever: 600, playtime_2weeks: 240 },
    { appid: 1145360, name: 'Hades', playtime_forever: 10 },
    { appid: 504230, name: 'Celeste', playtime_forever: 0 },
    { appid: 1003590, name: 'Tetris®', playtime_forever: 900, playtime_2weeks: 60 },
  ],
};

test('Steam import: owned games found across services, played ones marked once', async () => {
  fakeSteam(library, { vanity: { me: '76561190000000001' } });
  const r = await steam.importLibrary({ profile: 'https://steamcommunity.com/id/me', key: 'KEY' }, catalogue, {}, { 'gamepass:4': 'completed' });
  assert.strictEqual(r.steam.steamId, '76561190000000001');
  assert.deepStrictEqual(r.summary, { owned: 4, inCatalogue: 3, marked: 1 });
  // DOOM's merged card (led by Game Pass) is marked; Hades has only 10 minutes;
  // Celeste already had a mark; Steam's Tetris isn't the Switch Online one.
  assert.deepStrictEqual(r.marks, { 'gamepass:1': 'played' });
  assert.strictEqual(r.steam.owned.doometernal.appid, 782330);
  // Every game's last two weeks, for the playing pace.
  assert.strictEqual(r.steam.recentMinutes, 300);

  // Unmarked by the user afterwards: the next import leaves it alone.
  const again = await steam.importLibrary({ profile: 'me', key: 'KEY' }, catalogue, r.steam, { 'gamepass:4': 'completed' });
  assert.deepStrictEqual(again.marks, {});
});

test('Steam import explains a private profile, a bad key and an unknown name', async () => {
  fakeSteam({});
  await assert.rejects(steam.importLibrary({ profile: '76561190000000001', key: 'KEY' }, catalogue), /Game details to Public/);
  await assert.rejects(steam.importLibrary({ profile: '76561190000000001', key: 'WRONG' }, catalogue), /didn't accept the API key/);
  await assert.rejects(steam.importLibrary({ profile: 'nobody', key: 'KEY' }, catalogue), /no profile called "nobody"/);
  await assert.rejects(steam.importLibrary({ profile: 'me', key: '' }, catalogue), /API key/);
});

test('Steam import moves a To play game you have played on to played', async () => {
  fakeSteam(library);
  const r = await steam.importLibrary({ profile: '76561190000000001', key: 'KEY' }, catalogue, {}, { 'eaplay:2': 'wishlist' });
  assert.deepStrictEqual(r.marks, { 'gamepass:1': 'played' });
  assert.deepStrictEqual(r.clear, ['eaplay:2']);
});

test('An empty Steam library is fine', async () => {
  fakeSteam({ game_count: 0 });
  const r = await steam.importLibrary({ profile: '76561190000000001', key: 'KEY' }, catalogue);
  assert.deepStrictEqual(r.summary, { owned: 0, inCatalogue: 0, marked: 0 });
});
