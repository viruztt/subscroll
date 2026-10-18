const test = require('node:test');
const assert = require('node:assert');
const http = require('../src/providers/http');
const { parseChoice, humbleWindow, monthPage, fetchPage } = require('../src/providers/humble');

const page = (data) => `<html><body><script id="webpack-monthly-product-data" type="application/json">${JSON.stringify(data)}</script><script type="application/json">{"other":1}</script></body></html>`;

test('Humble Choice: this month\'s games from the page JSON', () => {
  const html = page({ contentChoiceOptions: { title: 'October 2026', contentChoiceData: { game_data: {
    hades2: { title: 'Hades II', image: 'https://hb.imgix.net/hades2.jpg', genres: ['Action'], developers: ['Supergiant Games'], description_text: '<p>Battle beyond the Underworld.</p>' },
    tunic: { title: 'TUNIC', tile_image: 'https://hb.imgix.net/tunic.jpg' },
    broken: { nope: true },
  } } } });
  const now = new Date('2026-10-18T12:00:00Z');
  const games = parseChoice(html, { now });
  assert.deepStrictEqual(games.map((g) => [g.id, g.title, g.image, g.tiers]), [
    ['humble:hadesii', 'Hades II', 'https://hb.imgix.net/hades2.jpg', ['choice']],
    ['humble:tunic', 'TUNIC', 'https://hb.imgix.net/tunic.jpg', ['choice']],
  ]);
  assert.strictEqual(games[0].developer, 'Supergiant Games');
  assert.strictEqual(games[0].description, 'Battle beyond the Underworld.');
  assert.deepStrictEqual([games[0].start, games[0].end], ['2026-10-06T17:00:00.000Z', '2026-11-03T18:00:00.000Z']);
  assert.strictEqual(humbleWindow(new Date('2026-10-06T16:30:00Z')).month, '2026-09');
  assert.strictEqual(parseChoice('<html>no data</html>'), null);
});

test('Humble Choice: the membership page points to this month\'s page', async () => {
  const marketing = '<script id="webpack-choice-marketing-data" type="application/json">{"activeContentMachineName": "october_2026_choice", "tierInfo": {}}</script>';
  assert.strictEqual(monthPage(marketing), 'https://www.humblebundle.com/membership/october-2026');
  const asked = [];
  http.setFetch(async (url) => {
    asked.push(url);
    const body = url.endsWith('/october-2026') ? page({ contentChoiceOptions: { contentChoiceData: { game_data: { tunic: { title: 'TUNIC' } } } } }) : marketing;
    return { ok: true, status: 200, text: async () => body };
  });
  const games = await fetchPage(null);
  assert.deepStrictEqual(asked, ['https://www.humblebundle.com/membership', 'https://www.humblebundle.com/membership/october-2026']);
  assert.deepStrictEqual(games.map((g) => g.title), ['TUNIC']);
});
