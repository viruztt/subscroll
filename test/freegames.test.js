const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('../src/providers/http');
const { FreeGames, parseEpic, parseGamerPower, cleanGiveawayTitle, freeAlerts } = require('../src/freegames');

const now = new Date('2026-10-17T12:00:00Z');
const offer = (start, end, pct = 0) => [{ promotionalOffers: [{ startDate: start, endDate: end, discountSetting: { discountType: 'PERCENTAGE', discountPercentage: pct } }] }];
const epicFeed = { data: { Catalog: { searchStore: { elements: [
  {
    title: 'Out of Sight', id: 'o1', namespace: 'ns1', productSlug: null,
    catalogNs: { mappings: [{ pageSlug: 'out-of-sight-5b1c', pageType: 'productHome' }] },
    keyImages: [{ type: 'OfferImageWide', url: 'https://cdn/wide.jpg' }, { type: 'OfferImageTall', url: 'https://cdn/tall.jpg' }],
    price: { totalPrice: { discountPrice: 0, originalPrice: 1599, fmtPrice: { originalPrice: '£15.99' } } },
    promotions: { promotionalOffers: offer('2026-10-16T15:00:00.000Z', '2026-10-23T15:00:00.000Z'), upcomingPromotionalOffers: [] },
  },
  {
    title: 'Next Week Game', id: 'n1', namespace: 'ns2', offerMappings: [{ pageSlug: 'next-week-game', pageType: 'productHome' }],
    keyImages: [{ type: 'Thumbnail', url: 'https://cdn/thumb.jpg' }],
    price: { totalPrice: { discountPrice: 1999, originalPrice: 1999, fmtPrice: { originalPrice: '£19.99' } } },
    promotions: { promotionalOffers: [], upcomingPromotionalOffers: offer('2026-10-23T15:00:00.000Z', '2026-10-30T15:00:00.000Z') },
  },
  {
    title: 'Half Price Deal', id: 'h1', namespace: 'ns3', productSlug: 'half',
    price: { totalPrice: { discountPrice: 999, originalPrice: 1999 } },
    promotions: { promotionalOffers: offer('2026-10-16T15:00:00.000Z', '2026-10-23T15:00:00.000Z', 50) },
  },
  { title: 'Always Free', id: 'a1', namespace: 'ns4', promotions: null },
  {
    title: 'Ended', id: 'e1', namespace: 'ns5', productSlug: 'ended',
    promotions: { promotionalOffers: offer('2026-10-09T15:00:00.000Z', '2026-10-16T15:00:00.000Z') },
  },
] } } } };

test('parseEpic: free now and next week, not deals or ended ones', () => {
  const games = parseEpic(epicFeed, { now, locale: 'en-US' });
  assert.deepStrictEqual(games.map((g) => [g.title, g.upcoming]), [['Out of Sight', false], ['Next Week Game', true]]);
  const [now1, next] = games;
  assert.strictEqual(now1.url, 'https://store.epicgames.com/en-US/p/out-of-sight-5b1c');
  assert.strictEqual(now1.image, 'https://cdn/tall.jpg');
  assert.strictEqual(now1.end, '2026-10-23T15:00:00.000Z');
  assert.strictEqual(now1.worth, '£15.99');
  assert.strictEqual(next.url, 'https://store.epicgames.com/en-US/p/next-week-game');
  assert.strictEqual(next.start, '2026-10-23T15:00:00.000Z');
});

const gp = (id, title, platforms, extra = {}) => ({ id, title, platforms, type: 'Game', status: 'Active', worth: '$9.99', image: `https://gp/${id}.jpg`, open_giveaway_url: `https://gp/open/${id}`, published_date: '2026-10-15 10:00:00', end_date: '2026-10-20 23:59:00', description: '', ...extra });

test('parseGamerPower: Steam, GOG, Epic and Prime giveaways, games only', () => {
  const games = parseGamerPower([
    gp(1, 'Pony Island (Steam) Giveaway', 'PC, Steam'),
    gp(2, 'Framed Collection (GOG) Giveaway', 'PC, DRM-Free, GOG'),
    gp(3, 'Terrascape (Epic Games) Giveaway', 'PC, Epic Games Store', { end_date: 'N/A' }),
    gp(4, 'In Sound Mind (Prime Gaming) Giveaway', 'PC, Amazon Games'),
    gp(5, 'Spooky Cats Steam Key Giveaway', 'PC, Steam'),
    gp(6, 'Meltdown Playtest (Steam) Key Giveaway', 'PC, Steam'),
    gp(7, 'Some Itch Game (itch.io) Giveaway', 'PC, Itch.io'),
    gp(8, 'Skin Pack', 'PC, Steam', { type: 'DLC' }),
    gp(9, 'Old (Steam) Giveaway', 'PC, Steam', { end_date: '2026-10-16 23:59:00' }),
  ], { now });
  assert.deepStrictEqual(games.map((g) => [g.title, g.store, !!g.limited]), [
    ['Pony Island', 'steam', false],
    ['Framed Collection', 'gog', false],
    ['Terrascape', 'epic', false],
    ['In Sound Mind', 'prime', false],
    ['Spooky Cats', 'steam', true],
  ]);
  assert.strictEqual(games[2].end, null);
  assert.strictEqual(games[0].end, '2026-10-20T23:59:00.000Z');
  assert.strictEqual(cleanGiveawayTitle('LONESTAR (Epic Games) Giveaway'), 'LONESTAR');
});

test('FreeGames: Epic feed wins over GamerPower copy; a failed source keeps its last list', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'free-'));
  let gpDown = false;
  const asked = [];
  http.setFetch(async (url) => {
    const u = new URL(url);
    asked.push(u.host + u.search);
    if (u.host.includes('epicgames')) return { ok: true, status: 200, json: async () => epicFeed };
    if (gpDown) return { ok: false, status: 503, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => [gp(10, 'Out of Sight (Epic Games) Giveaway', 'PC, Epic Games Store'), gp(1, 'Pony Island (Steam) Giveaway', 'PC, Steam')] };
  });
  const fg = new FreeGames(dir);
  assert.ok(fg.due());
  const r = await fg.refresh({ country: 'GB', locale: 'en-US' });
  assert.ok(asked[0].includes('country=GB'));
  assert.deepStrictEqual(r.games.map((g) => `${g.store}:${g.title}`), ['steam:Pony Island', 'epic:Out of Sight', 'epic:Next Week Game']);
  assert.ok(!fg.due());
  gpDown = true;
  const again = await new FreeGames(dir).refresh({ country: 'GB' });
  assert.ok(again.errors.gamerpower);
  assert.deepStrictEqual(again.games.map((g) => g.title), ['Pony Island', 'Out of Sight', 'Next Week Game']);
  // Past its end date, a giveaway drops off the list.
  assert.deepStrictEqual(new FreeGames(dir).list(new Date('2026-10-21T00:00:00Z')).games.map((g) => g.title), ['Out of Sight', 'Next Week Game']);
});

test('freeAlerts: new giveaways after the first check, last-day reminders once, not for claimed', () => {
  const games = [
    { id: 'epic:a', title: 'A', end: '2026-10-18T10:00:00Z' },
    { id: 'epic:b', title: 'B', end: '2026-10-25T10:00:00Z' },
    { id: 'epic:c', title: 'C', end: '2026-10-18T09:00:00Z' },
    { id: 'epic:u', title: 'U', end: '2026-10-30T10:00:00Z', upcoming: true },
    // A source checked for the first time is a baseline too.
    { id: 'fpd:2026-10-15:X', title: 'X', end: '2026-10-18T09:00:00Z', kind: 'try' },
  ];
  assert.deepStrictEqual(freeAlerts(games, { now }).added, []);
  const r = freeAlerts(games, { known: ['epic:a'], reminded: [], marks: { 'epic:c': 'claimed' }, now });
  assert.deepStrictEqual(r.added.map((g) => g.id), ['epic:b']);
  assert.deepStrictEqual(r.ending.map((g) => g.id), ['epic:a']);
  assert.deepStrictEqual(freeAlerts(games, { known: ['epic:a', 'epic:b'], reminded: ['epic:a'], now }).ending.map((g) => g.id), ['epic:c']);
  // Free Play Days: news once the source is known, but no last-day reminder.
  const f = freeAlerts([...games, { id: 'fpd:2026-10-15:Y', title: 'Y', end: '2026-10-18T09:00:00Z', kind: 'try' }], { known: ['epic:a', 'epic:b', 'epic:c', 'fpd:2026-10-15:X'], reminded: ['epic:a', 'epic:c'], now });
  assert.deepStrictEqual(f.added.map((g) => g.id), ['fpd:2026-10-15:Y']);
  assert.deepStrictEqual(f.ending, []);
});
