const test = require('node:test');
const assert = require('node:assert');
const Goals = require('../renderer/goals');

test('Goals: periods start on Monday, the 1st, or 1 January', () => {
  assert.strictEqual(Goals.periodStart('2026-10-18', 'week'), '2026-10-12'); // a Sunday
  assert.strictEqual(Goals.periodStart('2026-10-12', 'week'), '2026-10-12');
  assert.strictEqual(Goals.periodStart('2026-10-18', 'month'), '2026-10-01');
  assert.strictEqual(Goals.nextStart('2026-12-01', 'month'), '2027-01-01');
  assert.strictEqual(Goals.periodStart('2026-10-18', 'year'), '2026-01-01');
});

test('Goals: finish dates follow completed marks', () => {
  const out = Goals.stampFinished({ old: '2026-01-02', gone: '2026-02-03' }, { old: 'completed', gone: 'completed', a: 'played' }, { old: 'completed', gone: 'played', a: 'completed', b: 'wishlist' }, '2026-10-18');
  assert.deepStrictEqual(out, { old: '2026-01-02', a: '2026-10-18' });
});

test('Goals: progress, streaks and the best streak', () => {
  const goal = { id: 'g', count: 2, unit: 'games', per: 'month', since: '2026-10-01' };
  const finished = [
    { id: 'a', date: '2026-06-03' }, { id: 'b', date: '2026-06-20' }, // June met
    { id: 'c', date: '2026-07-01' }, // July missed
    { id: 'd', date: '2026-08-05' }, { id: 'e', date: '2026-08-06' }, // August met
    { id: 'f', date: '2026-09-09' }, { id: 'g', date: '2026-09-30' }, // September met
    { id: 'h', date: '2026-10-02' }, // October so far: 1 of 2
    { id: 'x', date: null },
  ];
  const p = Goals.progress(goal, finished, '2026-10-18');
  assert.strictEqual(p.history[0].start, '2026-06-01'); // from the first dated finish
  assert.deepStrictEqual([p.current.done, p.current.met, p.current.left], [1, false, 14]);
  assert.strictEqual(p.streak, 2); // August and September; October isn't over
  assert.strictEqual(p.best, 2);
  const met = Goals.progress(goal, [...finished, { id: 'i', date: '2026-10-10' }], '2026-10-18');
  assert.deepStrictEqual([met.current.met, met.streak, met.best], [true, 3, 3]);
  // Hours: How Long To Beat times add up.
  const hours = Goals.progress({ ...goal, count: 20, unit: 'hours', per: 'week' }, [{ id: 'a', date: '2026-10-13', hours: 12 }, { id: 'b', date: '2026-10-15', hours: 9.5 }], '2026-10-18');
  assert.deepStrictEqual([hours.current.done, hours.current.met, hours.streak], [21.5, true, 1]);
  // Nothing finished yet: one empty period from the goal's start.
  const fresh = Goals.progress(goal, [], '2026-10-18');
  assert.deepStrictEqual([fresh.history.length, fresh.streak, fresh.best], [1, 0, 0]);
});
