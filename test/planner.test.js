const test = require('node:test');
const assert = require('node:assert');
const { plan, forecast } = require('../renderer/planner');

const today = '2026-10-23';
const game = (id, hours, extra = {}) => ({ id, hours, ready: false, plans: new Set(), ...extra });

test('Plan ahead: when the backlog would be done at your pace', () => {
  assert.deepStrictEqual(forecast(30, 1.5, today), { days: 20, date: '2026-11-11' });
  assert.strictEqual(forecast(0, 1.5, today), null);
  assert.strictEqual(forecast(10, 0, today), null);
});

test('Plan ahead: your own plans first, then one plan a month', () => {
  const items = [
    game('own', 10, { ready: true }),
    game('gp1', 20, { plans: new Set(['gamepass:ultimate']) }),
    game('gp2', 15, { plans: new Set(['gamepass:ultimate']) }),
    game('ps1', 25, { plans: new Set(['psplus:extra']) }),
  ];
  const candidates = [{ key: 'gamepass:ultimate', price: { amount: 16.99, months: 1 } }, { key: 'psplus:extra', price: { amount: 11.99, months: 1 } }];
  const r = plan(items, { perDay: 1.5, today, candidates });
  // 45 hours a month: the game you have, then Game Pass's two, shortest first.
  assert.strictEqual(r.months[0].key, 'gamepass:ultimate');
  assert.deepStrictEqual(r.months[0].games.map((g) => g.id), ['own', 'gp2', 'gp1']);
  assert.strictEqual(r.months[1].key, 'psplus:extra');
  assert.strictEqual(r.months[1].start, '2026-11-22');
  assert.strictEqual(r.finishes, r.months[1].lastDay);
  assert.strictEqual(r.hours, 70);
});

test('Plan ahead: a game leaving soon comes first, and one that cannot fit is missed', () => {
  const items = [
    game('long', 40, { plans: new Set(['psplus:extra']) }),
    game('leaving', 10, { plans: new Set(['gamepass:ultimate']), deadline: '2026-11-15' }),
    game('tooBig', 100, { plans: new Set(['gamepass:ultimate']), deadline: '2026-11-01' }),
  ];
  const candidates = [{ key: 'gamepass:ultimate', price: null }, { key: 'psplus:extra', price: null }];
  const r = plan(items, { perDay: 1, today, candidates });
  assert.strictEqual(r.months[0].key, 'gamepass:ultimate');
  const first = r.months[0].games.map((g) => g.id);
  assert.ok(first.indexOf('tooBig') < first.indexOf('leaving'), 'the one leaving first goes first');
  assert.deepStrictEqual(r.missed.map((m) => m.id), ['tooBig']);
  assert.ok(r.months.some((m) => m.key === 'psplus:extra'));
});

test('Plan ahead: a game that is not in any plan is left out; no month bought for a few hours', () => {
  const items = [game('nowhere', 10), game('own', 60, { ready: true }), game('tiny', 1, { plans: new Set(['eaplay:eaplay']) })];
  const r = plan(items, { perDay: 1, today, candidates: [{ key: 'eaplay:eaplay', price: { amount: 5.99, months: 1 } }] });
  assert.deepStrictEqual(r.unreachable, ['nowhere']);
  assert.strictEqual(r.months[0].key, null);
  // A game you started carries on next month.
  assert.ok(r.months[1].games[0].id === 'own');
});

test('Plan ahead: a game arriving later waits for its day', () => {
  const items = [game('later', 5, { plans: new Set(['gamepass:ultimate']), from: '2026-12-10' })];
  const r = plan(items, { perDay: 1, today, candidates: [{ key: 'gamepass:ultimate', price: null }] });
  const month = r.months.find((m) => m.key === 'gamepass:ultimate');
  assert.ok(month && month.start <= '2026-12-10' && month.end >= '2026-12-10');
  assert.strictEqual(r.finishes, '2026-12-14');
});
