const test = require('node:test');
const assert = require('node:assert');
const Deadline = require('../renderer/deadline');

const today = '2026-10-19';

test('pace: your own setting wins, then the larger of Steam and recent finishes', () => {
  assert.deepStrictEqual(Deadline.pace({ hoursWeek: 14, steam: { recentMinutes: 6000, importedAt: today }, today }), { perDay: 2, source: 'setting' });
  // 28 hours on Steam in two weeks: 2 hours a day.
  const steam = { recentMinutes: 28 * 60, importedAt: '2026-10-18T09:00:00Z' };
  assert.deepStrictEqual(Deadline.pace({ steam, today }), { perDay: 2, source: 'steam' });
  // Recent finishes: 60 hours over 60 days is an hour a day, less than Steam's 2.
  const finished = [{ date: '2026-08-21', hours: 30 }, { date: '2026-10-01', hours: 30 }, { date: '2025-01-01', hours: 500 }, { date: '2026-10-02', hours: null }];
  assert.strictEqual(Deadline.pace({ steam, finished, today }).source, 'steam');
  const p = Deadline.pace({ finished, today });
  assert.strictEqual(p.source, 'finished');
  assert.strictEqual(p.games, 2);
  assert.strictEqual(Math.round(p.perDay * 100) / 100, 1);
  // One game finished yesterday is spread over at least 30 days.
  assert.strictEqual(Deadline.pace({ finished: [{ date: '2026-10-18', hours: 15 }], today }).perDay, 0.5);
  // An old Steam import doesn't count; nothing at all means an hour a day.
  assert.deepStrictEqual(Deadline.pace({ steam: { recentMinutes: 600, importedAt: '2026-08-01T00:00:00Z' }, today }), { perDay: 1, source: 'default' });
});

test('verdict: hours to beat against the days left', () => {
  const v = Deadline.verdict({ beat: 12, leave: { date: '2026-10-28' }, today, perDay: 2 });
  assert.deepStrictEqual({ ...v, perDay: Math.round(v.perDay * 100) / 100 }, { hours: 12, played: 0, days: 9, date: '2026-10-28', perDay: 1.33, estimated: false, status: 'ok' });
  assert.strictEqual(Deadline.verdict({ beat: 12, leave: { date: '2026-10-28' }, today, perDay: 1 }).status, 'tight');
  assert.strictEqual(Deadline.verdict({ beat: 40, leave: { date: '2026-10-28' }, today, perDay: 1 }).status, 'unlikely');
  // Time you've already played comes off, but never all of it.
  assert.strictEqual(Deadline.verdict({ beat: 12, played: 9, leave: { date: '2026-10-28' }, today, perDay: 1 }).hours, 3);
  assert.strictEqual(Deadline.verdict({ beat: 10, played: 50, leave: { date: '2026-10-28' }, today, perDay: 1 }).hours, 1);
  // Leaving today counts as one day; gone or no time means no verdict.
  assert.strictEqual(Deadline.verdict({ beat: 2, leave: { date: today }, today, perDay: 1 }).perDay, 2);
  assert.strictEqual(Deadline.verdict({ beat: 2, leave: { date: '2026-10-01' }, today, perDay: 1 }), null);
  assert.strictEqual(Deadline.verdict({ beat: null, leave: { date: '2026-10-28' }, today, perDay: 1 }), null);
});

test('a leaving flag without a date is guessed as the next 15th or month end', () => {
  assert.strictEqual(Deadline.guessLeaveDate('2026-10-03'), '2026-10-15');
  assert.strictEqual(Deadline.guessLeaveDate('2026-10-15'), '2026-10-15');
  assert.strictEqual(Deadline.guessLeaveDate('2026-10-19'), '2026-10-31');
  assert.strictEqual(Deadline.guessLeaveDate('2027-02-20'), '2027-02-28');
  const v = Deadline.verdict({ beat: 6, leave: { date: null }, today, perDay: 1 });
  assert.deepStrictEqual([v.estimated, v.days, v.date], [true, 12, '2026-10-31']);
});

test('what to start first: the least time to spare', () => {
  const a = Deadline.verdict({ beat: 20, leave: { date: '2026-10-31' }, today, perDay: 2 });
  const b = Deadline.verdict({ beat: 4, leave: { date: '2026-10-25' }, today, perDay: 2 });
  assert.strictEqual(Deadline.startWithin(a, 2), 2);
  assert.strictEqual(Deadline.startWithin(b, 2), 4);
});
