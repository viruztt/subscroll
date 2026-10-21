const test = require('node:test');
const assert = require('node:assert');
const { predict, kindOf, leaveDay, thirdTuesday, addMonths, windowEnd } = require('../renderer/predict');

const today = '2026-10-21';

test('Predictions: removal days per service', () => {
  // Third Tuesday of November 2026 is the 17th.
  assert.strictEqual(new Date(thirdTuesday(2026, 10)).toISOString().slice(0, 10), '2026-11-17');
  assert.strictEqual(leaveDay('psplus', '2026-11-04'), '2026-11-17');
  // Game Pass: the last 15th or month end on or just before the deal ends.
  assert.strictEqual(leaveDay('gamepass', '2026-11-05'), '2026-10-31');
  assert.strictEqual(leaveDay('gamepass', '2026-11-20'), '2026-11-15');
  assert.strictEqual(leaveDay('gamepass', '2026-11-01'), '2026-10-31');
  assert.strictEqual(leaveDay('netflix', '2026-11-20'), '2026-10-31');
  assert.strictEqual(addMonths('2025-08-31', 6), '2026-02-28');
});

test('Predictions: who publishes it decides the deal length', () => {
  assert.strictEqual(kindOf({ service: 'psplus', publisher: 'Sony Interactive Entertainment' }), 'own');
  assert.strictEqual(kindOf({ service: 'gamepass', publisher: 'Xbox Game Studios' }), 'own');
  assert.strictEqual(kindOf({ service: 'psplus', publisher: 'Rockstar Games' }), 'short');
  assert.strictEqual(kindOf({ service: 'psplus', publisher: 'Ubisoft' }), 'big');
  assert.strictEqual(kindOf({ service: 'ubisoftplus', publisher: 'Ubisoft' }), 'own');
  assert.strictEqual(kindOf({ service: 'gamepass', publisher: 'Raw Fury' }), 'standard');
});

test('Predictions: anniversaries of the join date, within the horizon', () => {
  // Joined a year ago: 12 months, likely.
  assert.deepStrictEqual(predict({ service: 'gamepass', joined: '2025-11-05', publisher: 'Reuben Games' }, { today: '2026-10-15' }),
    { date: '2026-10-31', months: 12, joined: '2025-11-05', likely: true, kind: 'standard' });
  // Three years in: a renewal, less likely.
  assert.strictEqual(predict({ service: 'gamepass', joined: '2023-11-30', publisher: 'Shiro Games' }, { today }).likely, false);
  // Six months in, for a standard game: possible.
  assert.strictEqual(predict({ service: 'gamepass', joined: '2026-05-20', publisher: 'Dreamhaven' }, { today }).months, 6);
  // Rockstar on PS Plus: three months.
  assert.deepStrictEqual(predict({ service: 'psplus', tiers: ['extra'], joined: '2026-08-18', publisher: 'Rockstar Games' }, { today }),
    { date: '2026-11-17', months: 3, joined: '2026-08-18', likely: true, kind: 'short' });
  // A big publisher's game a year in: possible; at two years: likely.
  assert.strictEqual(predict({ service: 'psplus', tiers: ['extra'], joined: '2025-11-18', publisher: 'Ubisoft' }, { today }).likely, false);
  assert.strictEqual(predict({ service: 'psplus', tiers: ['extra'], joined: '2024-11-19', publisher: 'Ubisoft' }, { today }).likely, true);
  // Nothing due soon, the service's own game, unknown join date, monthly games.
  assert.strictEqual(predict({ service: 'gamepass', joined: '2026-03-01', publisher: 'Raw Fury' }, { today }), null);
  assert.strictEqual(predict({ service: 'psplus', tiers: ['extra'], joined: '2025-11-18', publisher: 'Sony Interactive Entertainment' }, { today }), null);
  assert.strictEqual(predict({ service: 'gamepass', joined: null }, { today }), null);
  assert.strictEqual(predict({ service: 'psplus', tiers: ['essential'], joined: '2025-11-04' }, { today }), null);
  assert.strictEqual(predict({ service: 'nso', joined: '2025-11-04' }, { today }), null);
});

test('Predictions: Game Pass dates close by without an Xbox flag are skipped', () => {
  // Due 31 October, six days away: Xbox would have flagged it by now.
  assert.strictEqual(predict({ service: 'gamepass', joined: '2025-11-05' }, { today: '2026-10-25' }), null);
  // Apple Arcade has no flag, so the date stays.
  assert.strictEqual(predict({ service: 'applearcade', joined: '2025-11-05' }, { today: '2026-10-25' }).date, '2026-10-31');
});

test('Predictions: PS Plus looks ahead to the removal day after next', () => {
  // 21 October: November's day (17th) is announced, so December's (15th) is in reach too.
  assert.strictEqual(new Date(windowEnd('psplus', '2026-10-21')).toISOString().slice(0, 10), '2026-12-15');
  assert.deepStrictEqual(predict({ service: 'psplus', tiers: ['extra'], joined: '2024-12-17', publisher: 'Ubisoft' }, { today: '2026-10-21' }),
    { date: '2026-12-15', months: 24, joined: '2024-12-17', likely: true, kind: 'big' });
  assert.strictEqual(predict({ service: 'psplus', tiers: ['extra'], joined: '2025-12-16', publisher: 'Team17' }, { today: '2026-10-21' }).date, '2026-12-15');
  // On a removal day the window moves on to the next two.
  assert.strictEqual(new Date(windowEnd('psplus', '2026-11-17')).toISOString().slice(0, 10), '2027-01-19');
  // Game Pass keeps the plain 45 days.
  assert.strictEqual(predict({ service: 'gamepass', joined: '2025-12-15', publisher: 'Raw Fury' }, { today: '2026-10-21' }), null);
});
