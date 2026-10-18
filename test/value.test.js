const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('../src/providers/http');
const { Prices, microsoftPrice, playstationPrice, steamPrice } = require('../src/prices');
const { compute, monthsSince } = require('../renderer/value');

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
