const test = require('node:test');
const assert = require('node:assert');
const { cleanWatch, saleAlerts } = require('../src/sales');

test('saleAlerts: once per sale price, again when it drops further', () => {
  const watch = cleanWatch([
    { id: 'psplus:1', title: 'Stray', offers: [{ id: 'psplus:1', service: 'psplus', storeUrl: 'https://x' }] },
    { id: 'gamepass:2', title: 'Full Price', offers: [] },
    { id: 'gamepass:3', title: 'Other Currency', offers: [] },
    { bad: true },
  ]);
  assert.strictEqual(watch.length, 3);
  const prices = {
    'psplus:1': { amount: 24.99, sale: 12.49, currency: 'GBP', saleEnds: '2026-10-27T00:00:00Z' },
    'gamepass:2': { amount: 59.99, currency: 'GBP' },
    'gamepass:3': { amount: 59.99, sale: 10, currency: 'USD' },
  };
  const first = saleAlerts(watch, prices, {}, { currency: 'GBP' });
  assert.deepStrictEqual(first.fresh.map((s) => [s.title, s.off]), [['Stray', 50]]);
  assert.deepStrictEqual(first.alerted, { 'psplus:1': 12.49 });
  assert.deepStrictEqual(saleAlerts(watch, prices, first.alerted, { currency: 'GBP' }).fresh, []);
  const lower = saleAlerts(watch, { ...prices, 'psplus:1': { ...prices['psplus:1'], sale: 9.99 } }, first.alerted, { currency: 'GBP' });
  assert.deepStrictEqual(lower.fresh.map((s) => s.sale), [9.99]);
  // Sale over: forgotten, so the next one is news.
  assert.deepStrictEqual(saleAlerts(watch, { 'psplus:1': { amount: 24.99, currency: 'GBP' } }, first.alerted).alerted, {});
});
