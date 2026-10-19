const test = require('node:test');
const assert = require('node:assert');
const { ways } = require('../renderer/cheapest');
const PlanPrices = require('../renderer/planprices');
const { SERVICES } = require('../src/services');

const planOptions = (s) => PlanPrices.options(s, 'GBP', { tierName: (t) => s.tiers.find((x) => x.id === t)?.name || t });
const base = { services: SERVICES, planOptions, today: '2026-10-18' };
const game = (offers, extra = {}) => ({ id: 'x', title: 'X', offers, ...extra });

test('Cheapest way: in your plans, or owned on Steam, costs nothing', () => {
  const g = game([{ service: 'gamepass', tiers: ['premium'] }]);
  assert.deepStrictEqual(ways(g, { ...base, subscriptions: { gamepass: 'ultimate' } }).map((w) => w.kind), ['included']);
  assert.deepStrictEqual(ways(g, { ...base, subscriptions: {}, owned: true })[0].kind, 'owned');
});

test('Cheapest way: the cheapest plan of each service, against buying it', () => {
  // EA Play's PC games are also in PC Game Pass and Ultimate; EA Play itself is cheapest.
  const g = game([{ service: 'eaplay', tiers: ['eaplay'], platforms: ['pc'] }]);
  const list = ways(g, { ...base, subscriptions: {}, price: { amount: 29.99, sale: 7.49, source: 'Steam' } });
  assert.deepStrictEqual(list.map((w) => [w.kind, w.cost]), [['plan', 5.99], ['buy', 7.49], ['plan', 10.99]]);
  assert.strictEqual(list[0].service, 'eaplay');
  assert.strictEqual(list[0].length, 'a month');
  assert.strictEqual(list[1].off, 75);
  assert.strictEqual(list[2].service, 'gamepass');
  assert.strictEqual(list[2].tier, 'pc');
  // An EA Play console game isn't in PC Game Pass: Ultimate is the Game Pass way.
  const xbox = ways(game([{ service: 'eaplay', tiers: ['eaplay'], platforms: ['console'] }]), { ...base, subscriptions: {} });
  assert.strictEqual(xbox.find((w) => w.service === 'gamepass').tier, 'ultimate');
  assert.deepStrictEqual(ways(game([{ service: 'eaplay', tiers: ['eaplay'], platforms: ['console'] }]), { ...base, subscriptions: { gamepass: 'pc' } })[0].kind, 'plan');
});

test('Cheapest way: upgrades, yearly-only plans, priced plans mapped to tiers', () => {
  const nso = game([{ service: 'nso', tiers: ['expansion'] }]);
  const [w] = ways(nso, { ...base, subscriptions: { nso: 'base' } });
  assert.deepStrictEqual([w.kind, w.cost, w.length, w.upgrade, w.tier], ['plan', 34.99, 'a year', true, 'expansion']);
  // Netflix games come with any Netflix plan; the plan with adverts is cheapest.
  const [n] = ways(game([{ service: 'netflix', tiers: ['any'] }]), { ...base, subscriptions: {} });
  assert.deepStrictEqual([n.plan, n.cost], ['ads', 7.99]);
  // Luna Standard comes with Prime.
  const [l] = ways(game([{ service: 'luna', tiers: ['standard'] }]), { ...base, subscriptions: {} });
  assert.deepStrictEqual([l.plan, l.tier], ['prime', 'standard']);
});

test('Cheapest way: waiting for a game that is coming to your plans', () => {
  const g = game([{ service: 'gamepass', tiers: ['ultimate', 'pc'] }]);
  const list = ways(g, { ...base, subscriptions: { gamepass: 'ultimate' }, comingOn: '2026-10-28', price: { amount: 59.99 } });
  assert.deepStrictEqual(list.map((w) => w.kind), ['wait', 'buy']);
  assert.strictEqual(list[0].days, 10);
  // Not coming to your plans: a plan from the day it arrives.
  const other = ways(g, { ...base, subscriptions: {}, comingOn: '2026-10-28' });
  assert.deepStrictEqual(other.map((w) => [w.kind, w.tier, w.on]), [['plan', 'pc', '2026-10-28']]);
});
