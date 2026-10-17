const test = require('node:test');
const assert = require('node:assert');
const { monthGrid, shiftMonth, events } = require('../renderer/calendar');

test('monthGrid: Monday-first weeks covering the month', () => {
  const grid = monthGrid('2026-10');
  assert.strictEqual(grid.length, 35);
  assert.deepStrictEqual(grid[0], { iso: '2026-09-28', inMonth: false }); // 1 Oct 2026 is a Thursday
  assert.deepStrictEqual(grid[3], { iso: '2026-10-01', inMonth: true });
  assert.deepStrictEqual(grid[33], { iso: '2026-10-31', inMonth: true });
  assert.strictEqual(monthGrid('2026-02').length, 35);
  assert.strictEqual(shiftMonth('2026-12', 1), '2027-01');
  assert.strictEqual(shiftMonth('2026-01', -1), '2025-12');
});

test('events: arrivals, join dates, departures and giveaways by day', () => {
  const games = [
    { id: 'a', title: 'Gears of War: E-Day', added: '2026-10-06' },
    { id: 'b', title: 'Coming Game', coming: '2026-10-21' },
    { id: 'c', title: 'Old Game', added: '2019-09-05' },
    { id: 'd', title: 'No Date' },
  ];
  const departed = [
    { id: 'x', title: 'Gone', leftOn: '2026-10-15' },
    { id: 'x2', title: 'Gone', leftOn: '2026-10-15' },
    { id: 'y', title: 'Left Earlier', leftOn: '2026-09-30' },
    { id: 'z', title: 'Arcade gone', leftOn: null },
  ];
  const free = [
    { id: 'f1', title: 'Out of Sight', start: '2026-10-16T15:00:00Z', end: '2026-10-23T15:00:00Z', upcoming: false },
    { id: 'f2', title: 'Next Week', start: '2026-10-23T15:00:00Z', end: '2026-10-30T15:00:00Z', upcoming: true },
  ];
  const days = events({
    games, departed, free, from: '2026-09-28', to: '2026-11-01',
    comingOn: (g) => g.coming || null, addedOn: (g) => g.added || null,
  });
  const at = (d) => (days.get(d) || []).map((e) => `${e.kind}:${e.item.title}`);
  assert.deepStrictEqual(at('2026-10-06'), ['added:Gears of War: E-Day']);
  assert.deepStrictEqual(at('2026-10-21'), ['coming:Coming Game']);
  assert.deepStrictEqual(at('2026-10-15'), ['left:Gone']);
  assert.deepStrictEqual(at('2026-09-30'), ['left:Left Earlier']);
  assert.deepStrictEqual(at('2026-10-23'), ['free-start:Next Week', 'free-end:Out of Sight']);
  assert.deepStrictEqual(at('2026-10-30'), ['free-end:Next Week']);
  assert.ok(![...days.values()].flat().some((e) => e.item.title === 'Old Game'));
});
