const test = require('node:test');
const assert = require('node:assert');
const S = require('../renderer/scorecard');

const p = (id, date, extra = {}) => ({ id, title: id, service: 'psplus', kind: 'standard', months: 12, likely: true, date, ...extra });

test('Scorecard: a prediction is saved once, when first made, and old ones are dropped', () => {
  let r = S.record({}, [p('a', '2026-11-17')], '2026-10-23');
  assert.strictEqual(r.added, 1);
  r = S.record(r.log, [p('a', '2026-11-17', { likely: false }), p('b', '2026-12-15')], '2026-10-30');
  assert.strictEqual(r.added, 1);
  assert.strictEqual(r.log['a|2026-11-17'].madeOn, '2026-10-23');
  assert.strictEqual(r.log['a|2026-11-17'].likely, true);
  const old = S.record({ 'x|2025-01-01': { ...p('x', '2025-01-01'), madeOn: '2024-12-01' } }, [], '2026-10-23');
  assert.deepStrictEqual(old.log, {});
});

test('Scorecard: right, another day, stayed or not known yet', () => {
  const e = { ...p('a', '2026-11-17'), madeOn: '2026-10-23' };
  const today = '2026-11-25';
  assert.strictEqual(S.judge(e, { leftOn: '2026-11-18', today }), 'right');
  assert.strictEqual(S.judge(e, { leftOn: '2026-10-25', today }), 'other-day');
  assert.strictEqual(S.judge(e, { present: true, refreshedOn: '2026-11-24', today }), 'stayed');
  // Not refreshed since the day: can't tell yet.
  assert.strictEqual(S.judge(e, { present: true, refreshedOn: '2026-11-16', today }), 'pending');
  assert.strictEqual(S.judge(e, { present: true, refreshedOn: '2026-11-16', today: '2026-11-10' }), 'pending');
  // Made the day before: doesn't count.
  assert.strictEqual(S.judge({ ...e, madeOn: '2026-11-16' }, { leftOn: '2026-11-17', today }), 'late');
});

test('Scorecard: tallies by likely and by rule, and demotes a rule that keeps missing', () => {
  const judged = [
    ...Array.from({ length: 5 }, (_, i) => ({ ...p(`s${i}`, '2026-11-17', { kind: 'big' }), outcome: i === 0 ? 'right' : 'stayed' })),
    { ...p('r', '2026-11-17'), outcome: 'right' },
    { ...p('q', '2026-11-17', { likely: false }), outcome: 'stayed' },
    { ...p('z', '2026-11-17'), outcome: 'pending' },
  ];
  const s = S.stats(judged);
  assert.deepStrictEqual(s.likely, { right: 2, total: 6 });
  assert.deepStrictEqual(s.possible, { right: 0, total: 1 });
  assert.strictEqual(S.demoted(s, 'psplus', 'big'), true);
  assert.strictEqual(S.demoted(s, 'psplus', 'standard'), false);
  assert.deepStrictEqual(S.ruleStats(s, 'psplus', 'standard', true), { right: 1, total: 1 });
});
