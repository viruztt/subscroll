const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('../src/providers/http');
const { DetailsCache, fetchDetails, parsePsStorePage, retroScreenshots, psStoreUrl } = require('../src/details');

const jsonResponse = (body, status = 200) => ({ ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) });
const textResponse = (body, status = 200) => ({ ok: status < 400, status, text: async () => body });

const nsoGame = {
  id: 'nso:snes:super-metroid',
  service: 'nso',
  title: 'Super Metroid',
  platforms: ['SNES'],
  image: 'https://raw.githubusercontent.com/libretro-thumbnails/Nintendo_-_Super_Nintendo_Entertainment_System/master/Named_Boxarts/Super%20Metroid%20(Japan%2C%20USA)%20(En%2CJa).png',
};

test('PlayStation Store page: description and screenshots', () => {
  const html = `<html><head>
    <meta name="description" content="Explore a world of &quot;hats&quot; &amp; time.">
    </head><body><script id="__NEXT_DATA__" type="application/json">
    {"media":[{"role":"SCREENSHOT","type":"IMAGE","url":"https://image.api.playstation.com/vulcan/ap/rnd/1/a.jpg"},
    {"role":"SCREENSHOT","type":"IMAGE","url":"https://image.api.playstation.com/vulcan/ap/rnd/1/b.jpg"},
    {"role":"MASTER","type":"IMAGE","url":"https://image.api.playstation.com/vulcan/ap/rnd/1/cover.png"}]}
    </script></body></html>`;
  const d = parsePsStorePage(html);
  assert.strictEqual(d.description, 'Explore a world of "hats" & time.');
  assert.deepStrictEqual(d.screenshots, [
    'https://image.api.playstation.com/vulcan/ap/rnd/1/a.jpg?w=960',
    'https://image.api.playstation.com/vulcan/ap/rnd/1/b.jpg?w=960',
  ]);
});

test('PlayStation Store links follow the chosen locale', () => {
  assert.strictEqual(psStoreUrl('https://store.playstation.com/de-at/concept/228903', 'en-gb'),
    'https://store.playstation.com/en-gb/concept/228903');
});

test('Retro screenshots come from the same libretro file name', () => {
  const shots = retroScreenshots(nsoGame.image);
  assert.strictEqual(shots.length, 2);
  assert.match(shots[0], /\/Named_Titles\/Super%20Metroid/);
  assert.match(shots[1], /\/Named_Snaps\/Super%20Metroid/);
  assert.deepStrictEqual(retroScreenshots(null), []);
});

test('Retro games get a Wikipedia description, cached on disk', async () => {
  let calls = 0;
  http.setFetch(async (url) => {
    calls += 1;
    const u = new URL(url);
    assert.strictEqual(u.host, 'en.wikipedia.org');
    assert.match(u.searchParams.get('gsrsearch'), /^Super Metroid Super NES video game$/);
    return jsonResponse({ query: { pages: [{ title: 'Super Metroid', extract: 'Super Metroid is a 1994 action-adventure game. ' }] } });
  });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'details-'));
  const cache = new DetailsCache(dir);
  const d = await cache.get(nsoGame, {});
  assert.strictEqual(d.description, 'Super Metroid is a 1994 action-adventure game.');
  assert.strictEqual(d.descriptionSource, 'https://en.wikipedia.org/wiki/Super_Metroid');
  assert.strictEqual(d.screenshots.length, 2);
  await new Promise((r) => setTimeout(r, 50)); // cache write is async
  const again = await new DetailsCache(dir).get(nsoGame, {});
  assert.strictEqual(again.description, d.description);
  assert.strictEqual(calls, 1);
});

test('Wikipedia descriptions only from the game\'s own article', async () => {
  http.setFetch(async (url) => {
    const u = new URL(url);
    if (u.searchParams.get('titles')) return jsonResponse({ query: { pages: [{ title: 'Metroid Fusion', extract: 'Metroid Fusion is a 2002 game.' }] } });
    return jsonResponse({ query: { pages: [{ title: 'Metroid (video game)', index: 1, extract: 'Metroid is a 1986 game.' }] } });
  });
  const fusion = { id: 'nso:gba:metroid-fusion', service: 'nso', title: 'Metroid Fusion', platforms: ['Game Boy Advance'], image: null };
  assert.strictEqual((await fetchDetails(fusion, {})).description, null);
  const known = await fetchDetails({ ...fusion, wikiPage: 'https://en.wikipedia.org/wiki/Metroid_Fusion' }, {});
  assert.strictEqual(known.description, 'Metroid Fusion is a 2002 game.');
});

test('PS Plus falls back to Wikipedia when the store page fails', async () => {
  http.setFetch(async (url) => {
    if (url.includes('store.playstation.com')) return textResponse('blocked', 403);
    return jsonResponse({ query: { pages: [{ title: 'A Hat in Time', extract: 'A Hat in Time is a platform game.' }] } });
  });
  const d = await fetchDetails({ id: 'psplus:228903', service: 'psplus', title: 'A Hat in Time', platforms: ['PS4'], storeUrl: 'https://store.playstation.com/de-at/concept/228903' }, { psLocale: 'en-us' });
  assert.strictEqual(d.description, 'A Hat in Time is a platform game.');
  assert.deepStrictEqual(d.screenshots, []);
});

test('Game Pass details come from the catalogue without any request', async () => {
  http.setFetch(async () => { throw new Error('should not fetch'); });
  const d = await fetchDetails({ id: 'gamepass:X', service: 'gamepass', title: 'X', description: 'Short.', screenshots: ['a', 'a', 'b', 'c', 'd', 'e'] });
  assert.strictEqual(d.description, 'Short.');
  assert.deepStrictEqual(d.screenshots, ['a', 'b', 'c', 'd']);
});

test('Game Pass games cached without details look them up once', async () => {
  let calls = 0;
  http.setFetch(async (url) => {
    calls += 1;
    assert.match(url, /displaycatalog\.mp\.microsoft\.com\/v7\.0\/products\?bigIds=9ABC&market=GB/);
    return jsonResponse({ Products: [{ ProductId: '9ABC', LocalizedProperties: [{ ProductTitle: 'Old', ShortDescription: 'Fetched.', Images: [{ ImagePurpose: 'Screenshot', Uri: '//s/1' }] }] }] });
  });
  const cache = new DetailsCache(fs.mkdtempSync(path.join(os.tmpdir(), 'details-')));
  const game = { id: 'gamepass:9ABC', service: 'gamepass', title: 'Old' };
  const d = await cache.get(game, { market: 'GB', language: 'en-gb' });
  assert.strictEqual(d.description, 'Fetched.');
  assert.deepStrictEqual(d.screenshots, ['https://s/1?w=960']);
  await cache.get(game, { market: 'GB' });
  assert.strictEqual(calls, 1);
});
