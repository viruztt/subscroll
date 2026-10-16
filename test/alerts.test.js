const test = require('node:test');
const assert = require('node:assert');
const { pickAlerts, messages, listTitles } = require('../src/alerts');

const keys = new Set(['gamepass:ultimate', 'psplus:extra']);
const games = [
  { id: 'gp:1', service: 'gamepass', title: 'Hades', tiers: ['ultimate'] },
  { id: 'gp:2', service: 'gamepass', title: 'Celeste', tiers: ['ultimate'] },
  { id: 'ps:2', service: 'psplus', title: 'Celeste', tiers: ['extra'] }, // already in your PS Plus
  { id: 'gp:3', service: 'gamepass', title: 'Done Game', tiers: ['ultimate'] },
  { id: 'eaplay:4', service: 'eaplay', title: 'Not Mine', tiers: ['eaplay'] },
  { id: 'gp:5', service: 'gamepass', title: 'Old Leaver', tiers: ['ultimate'], leavingSoon: true },
  { id: 'gp:6', service: 'gamepass', title: 'New Leaver', tiers: ['ultimate'], leavingSoon: true },
  { id: 'gp:7', service: 'gamepass', title: 'Ignored Leaver', tiers: ['ultimate'], leavingSoon: true },
];

test('Alerts: new to your plans and newly leaving, once each', () => {
  const picked = pickAlerts({
    games,
    newIds: new Set(['gp:1', 'gp:2', 'gp:3', 'eaplay:4']),
    keys,
    marks: { 'gp:3': 'completed', 'gp:7': 'ignored' },
    alertedLeaving: ['gp:5'],
  });
  assert.deepStrictEqual(picked.added, ['Hades']);
  assert.deepStrictEqual(picked.leaving, ['New Leaver']);
  assert.deepStrictEqual(picked.leavingIds.sort(), ['gp:5', 'gp:6']);
});

test('Alert text', () => {
  assert.strictEqual(listTitles(['A']), 'A');
  assert.strictEqual(listTitles(['A', 'B']), 'A and B');
  assert.strictEqual(listTitles(['A', 'B', 'C', 'D', 'E']), 'A, B, C and 2 more');
  assert.deepStrictEqual(messages({ added: ['Hades'], leaving: ['A', 'B'] }), [
    { view: 'changes', title: 'New in your plans: 1 game', body: 'Hades' },
    { view: 'leaving', title: 'Leaving your plans soon: 2 games', body: 'A and B' },
  ]);
  assert.deepStrictEqual(messages({ added: [], leaving: [] }), []);
});

test('Alerts: a To play game that arrives in your plans is announced as ready', () => {
  const { wishlist, arrived, messages: msgs } = require('../src/alerts');
  const marks = { 'gp:9': 'wishlist', 'ps:8': 'wishlist', 'gp:1': 'wishlist' };
  const before = wishlist([
    { id: 'gp:9', service: 'gamepass', title: 'Coming Game', tiers: ['ultimate'], comingOn: '2026-10-20' },
    { id: 'ps:8', service: 'psplus', title: 'Other Plan Game', tiers: ['premium'] },
    { id: 'gp:1', service: 'gamepass', title: 'Hades', tiers: ['ultimate'] },
  ], { keys, marks, today: '2026-10-16' });
  assert.deepStrictEqual([...before.waiting.values()], ['Coming Game', 'Other Plan Game']);
  const after = wishlist([
    { id: 'gp:9', service: 'gamepass', title: 'Coming Game', tiers: ['ultimate'] },
    { id: 'ps:8', service: 'psplus', title: 'Other Plan Game', tiers: ['premium'] },
    { id: 'gp:1', service: 'gamepass', title: 'Hades', tiers: ['ultimate'] },
  ], { keys, marks, today: '2026-10-20' });
  const ready = arrived(before.waiting, after);
  assert.deepStrictEqual(ready, ['Coming Game']);
  assert.deepStrictEqual(msgs({ added: ['Coming Game'], leaving: [], ready }), [
    { view: 'toplay', title: 'Ready to play from your list: 1 game', body: 'Coming Game' },
  ]);
});
