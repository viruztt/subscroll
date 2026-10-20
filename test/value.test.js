const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('../src/providers/http');
const { Prices, microsoftPrice, playstationPrice, steamPrice } = require('../src/prices');
const { compute, monthsSince, periodsOf } = require('../renderer/value');

const json = (body, status = 200) => ({ ok: status < 400, status, json: async () => body, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });

test('Prices: Microsoft list price, PlayStation base price, Steam exact title', () => {
  assert.deepStrictEqual(microsoftPrice({ DisplaySkuAvailabilities: [{ Availabilities: [
    { Actions: ['Details'], OrderManagementData: { Price: { MSRP: 10, CurrencyCode: 'GBP' } } },
    { Actions: ['Purchase'], OrderManagementData: { Price: { ListPrice: 0, MSRP: 59.99, CurrencyCode: 'GBP' } } },
  ] }] }), { amount: 59.99, currency: 'GBP' });
  assert.deepStrictEqual(playstationPrice('{"basePriceValue":6999,"currencyCode":"GBP"}…{"basePriceValue":7999}…{"basePriceValue":0}'), { amount: 69.99, currency: 'GBP' });
  assert.strictEqual(playstationPrice('<html>no data</html>'), null);
  const items = [{ id: 1, name: 'Hades II', price: { initial: 2499, currency: 'GBP' } }, { id: 2, name: 'Hades', price: { initial: 1999, currency: 'GBP' } }];
  assert.deepStrictEqual(steamPrice(items, 'Hades'), { amount: 19.99, currency: 'GBP', source: 'Steam', url: 'https://store.steampowered.com/app/2/' });
  assert.strictEqual(steamPrice(items, 'Celeste'), null);
});

test('Prices: sales from each store, with end dates where given', () => {
  assert.deepStrictEqual(microsoftPrice({ DisplaySkuAvailabilities: [{ Availabilities: [
    { Actions: ['Purchase'], Conditions: { EndDate: '9998-12-30T00:00:00.0000000Z' }, OrderManagementData: { Price: { ListPrice: 59.99, MSRP: 59.99, CurrencyCode: 'GBP' } } },
    { Actions: ['Purchase'], Conditions: { EndDate: '2026-10-27T07:00:00.0000000Z' }, OrderManagementData: { Price: { ListPrice: 23.99, MSRP: 59.99, CurrencyCode: 'GBP' } } },
  ] }] }), { amount: 59.99, currency: 'GBP', sale: 23.99, saleEnds: '2026-10-27T07:00:00.0000000Z' });
  assert.deepStrictEqual(playstationPrice('{"basePriceValue":6999,"discountedValue":2099,"endTime":"1793000000000","currencyCode":"GBP"}{"basePriceValue":7999,"discountedValue":7999}'),
    { amount: 69.99, currency: 'GBP', sale: 20.99, saleEnds: new Date(1793000000000).toISOString() });
  assert.deepStrictEqual(steamPrice([{ id: 3, name: 'Celeste', price: { initial: 1599, final: 399, currency: 'GBP' } }], 'Celeste'),
    { amount: 15.99, currency: 'GBP', sale: 3.99, source: 'Steam', url: 'https://store.steampowered.com/app/3/' });
});

test('Prices: own store first, Steam after, cached per country', async () => {
  const asked = [];
  http.setFetch(async (url) => {
    const u = new URL(url);
    asked.push(u.host);
    if (u.host === 'displaycatalog.mp.microsoft.com') return json({ Products: [{ DisplaySkuAvailabilities: [] }] });
    if (u.host === 'store.steampowered.com') return json({ items: [{ id: 9, name: 'DOOM Eternal', price: { initial: 3999, currency: 'GBP' } }] });
    throw new Error(url);
  });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prices-'));
  const updates = [];
  const prices = new Prices(dir, { pauseMs: 0, onUpdate: (u) => updates.push(u) });
  const games = [
    { id: 'gamepass:1', title: 'DOOM Eternal', offers: [{ id: 'gamepass:1', service: 'gamepass' }] },
    { id: 'nso:2', title: 'Tetris', offers: [{ id: 'nso:2', service: 'nso' }] },
  ];
  const settings = { market: 'GB', language: 'en-gb', currency: 'GBP' };
  await prices.lookup(games, settings);
  assert.strictEqual(prices.all()['gamepass:1'].amount, 39.99);
  assert.strictEqual(prices.all()['gamepass:1'].source, 'Steam');
  assert.strictEqual(prices.all()['nso:2'].amount, null);
  assert.deepStrictEqual(asked, ['displaycatalog.mp.microsoft.com', 'store.steampowered.com']);
  // Cached: nothing asked again; a new country asks again.
  await prices.lookup(games, settings);
  assert.strictEqual(asked.length, 2);
  await prices.lookup(games, { ...settings, market: 'US', currency: 'USD' });
  assert.strictEqual(prices.all()['gamepass:1'].amount, null); // GBP price for a US store doesn't count
  assert.strictEqual(new Prices(dir).all()['nso:2'].market, 'US');
});

test('Value: months paid, counted games and savings', () => {
  assert.strictEqual(monthsSince('2025-11', '2026-10-16'), 12);
  assert.strictEqual(monthsSince('2026-10', '2026-10-16'), 1);
  assert.strictEqual(monthsSince('', '2026-10-16'), 0);
  const games = [
    { id: 'a', title: 'A', mark: 'completed', mine: ['gamepass'], price: 60, via: true },
    { id: 'b', title: 'B', mark: 'completed', mine: ['gamepass'], price: 20, via: false }, // bought it
    { id: 'c', title: 'C', mark: 'completed', mine: ['psplus'], price: null, via: true },
    { id: 'd', title: 'D', mark: 'played', mine: ['psplus'], price: 30, via: true },
  ];
  const opts = {
    markOf: (g) => g.mark,
    myServices: (g) => g.mine,
    price: (g) => (g.price ? { amount: g.price } : null),
    viaSub: (g) => g.via,
    costs: { gamepass: { monthly: 10, since: '2026-08' }, psplus: { monthly: 5 } },
    today: '2026-10-16',
  };
  const v = compute(games, opts);
  assert.deepStrictEqual([v.worth, v.paid, v.saved, v.games, v.priced, v.perGame], [60, 30, 30, 2, 1, 15]);
  const gp = v.services.find((r) => r.service === 'gamepass');
  assert.deepStrictEqual([gp.months, gp.paid, gp.value, gp.games], [3, 30, 60, 1]);
  assert.deepStrictEqual(v.list.map((x) => x.game.id), ['a', 'c']);
  const withPlayed = compute(games, { ...opts, includePlayed: true });
  assert.strictEqual(withPlayed.worth, 90);
});

test('Value: paid periods with gaps and price changes', () => {
  const costs = { gamepass: { periods: [
    { from: '2025-01', to: '2025-03', monthly: 14.99, plan: 'ultimate' }, // 3 months, then quit
    { from: '2026-09', to: null, monthly: 22.99 }, // back from September: Sep and Oct
  ] }, nso: { periods: [{ from: '2026-01', to: '2026-12', monthly: 2.92 }] } };
  const v = compute([], { markOf: () => null, myServices: () => [], price: () => null, viaSub: () => true, costs, today: '2026-10-18' });
  const gp = v.services.find((r) => r.service === 'gamepass');
  assert.strictEqual(gp.months, 5);
  assert.strictEqual(Number(gp.paid.toFixed(2)), Number((3 * 14.99 + 2 * 22.99).toFixed(2)));
  assert.strictEqual(gp.since, '2025-01');
  assert.strictEqual(gp.active, true);
  // A period ending in the future only counts up to now.
  assert.strictEqual(v.services.find((r) => r.service === 'nso').months, 10);
  // Older saves read as one open period.
  assert.deepStrictEqual(periodsOf({ monthly: 10, since: '2026-08' }), [{ from: '2026-08', to: null, monthly: 10 }]);
  assert.deepStrictEqual(periodsOf({}), []);
});

test('Value: cost per hour, per service and per game', () => {
  const games = [
    { id: 'a', title: 'A', svc: 'gamepass', price: 60, h: 30 },
    { id: 'b', title: 'B', svc: 'gamepass', price: 20, h: 10 },
    { id: 'c', title: 'C', svc: 'gamepass', price: null, h: null }, // no time: counted at the average (20 h)
    { id: 'd', title: 'D', svc: 'psplus', price: 15, h: 5 },
  ];
  const v = compute(games, {
    markOf: () => 'completed',
    myServices: (g) => [g.svc],
    price: (g) => (g.price ? { amount: g.price } : null),
    viaSub: () => true,
    hours: (g) => g.h,
    costs: { gamepass: { periods: [{ from: '2026-01', to: '2026-06', monthly: 10 }] }, psplus: { periods: [{ from: '2026-10', to: null, monthly: 10 }] } },
    today: '2026-10-18',
  });
  assert.deepStrictEqual([v.hours, v.timed, v.hoursEst], [45, 3, 60]);
  assert.strictEqual(v.perHour, 70 / 60);
  assert.strictEqual(v.boughtPerHour, 95 / 45);
  const gp = v.services.find((r) => r.service === 'gamepass');
  assert.deepStrictEqual([gp.hours, gp.hoursEst, gp.perHour], [40, 60, 1]);
  assert.strictEqual(v.list.find((x) => x.game.id === 'a').perHour, 2);
  assert.strictEqual(v.list.find((x) => x.game.id === 'c').perHour, null);
  // Without the helper, nothing about hours.
  const plain = compute(games, { markOf: () => 'completed', myServices: (g) => [g.svc], price: () => null, viaSub: () => true, today: '2026-10-18' });
  assert.deepStrictEqual([plain.hours, plain.perHour, plain.boughtPerHour], [0, null, null]);
});

test('Value: dropped games count for their share, now playing only with played ones', () => {
  const games = [
    { id: 'a', title: 'A', offers: [{ id: 'a', service: 'gamepass' }] },
    { id: 'b', title: 'B', offers: [{ id: 'b', service: 'gamepass' }] },
    { id: 'c', title: 'C', offers: [{ id: 'c', service: 'gamepass' }] },
  ];
  const marks = { a: 'completed', b: 'dropped', c: 'playing' };
  const opts = {
    markOf: (g) => marks[g.id],
    myServices: () => ['gamepass'],
    price: () => ({ amount: 40 }),
    viaSub: () => true,
    share: (g) => (g.id === 'b' ? 0.25 : 1),
    today: '2026-10-20',
  };
  const v = compute(games, opts);
  assert.strictEqual(v.games, 2);
  assert.strictEqual(v.worth, 50);
  const b = v.list.find((x) => x.game.id === 'b');
  assert.deepStrictEqual([b.price.amount, b.price.fullAmount, b.price.share], [10, 40, 0.25]);
  assert.strictEqual(compute(games, { ...opts, includePlayed: true }).worth, 90);
});
