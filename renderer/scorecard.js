// How past predictions did. Each prediction is saved the first time it's
// made (state.predictionLog), and once its day has passed it's checked
// against what happened: the game left around that day (right), left on
// another day, or was still there after a refresh past the day (stayed).
//
//   record(log, predictions, today) -> { log, added }
//   judge(entry, { leftOn, present, refreshedOn, today }) -> outcome
//   stats(judged) -> { likely, possible, rules }
//   demoted(stats, service, kind) -> true when a rule's "likely" calls are
//     mostly wrong, so they're shown as less likely.
(function (root) {
  const DAY = 86400000;
  const utc = (iso) => Date.parse(`${String(iso).slice(0, 10)}T00:00:00Z`);
  const days = (a, b) => Math.round((utc(b) - utc(a)) / DAY);
  // Kept for a bit over a year.
  const KEEP_DAYS = 400;
  // Services remove games on the day, but Subscroll only notices at its next refresh.
  const EARLY = 7;
  const LATE = 14;
  // A prediction made only days before (after the service announced it, say) doesn't count.
  const AHEAD = 3;
  const MIN_CHECKED = 5;
  const POOR = 0.25;

  const keyOf = (p) => `${p.id}|${p.date}`;
  const ruleOf = (p) => `${p.service}:${p.kind}`;

  function record(log = {}, predictions = [], today) {
    const next = {};
    for (const [k, v] of Object.entries(log)) if (days(v.date, today) <= KEEP_DAYS) next[k] = v;
    let added = 0;
    for (const p of predictions) {
      const k = keyOf(p);
      if (next[k]) {
        // A prediction that became likely later stays as first made.
        continue;
      }
      next[k] = { id: p.id, title: p.title, service: p.service, kind: p.kind, months: p.months, likely: !!p.likely, date: p.date, madeOn: today };
      added += 1;
    }
    return { log: next, added };
  }

  function judge(entry, { leftOn = null, present = false, refreshedOn = null, today }) {
    if (days(entry.madeOn, entry.date) < AHEAD) return 'late';
    if (leftOn) {
      const off = days(entry.date, leftOn);
      return off >= -EARLY && off <= LATE ? 'right' : 'other-day';
    }
    if (entry.date >= today) return 'pending';
    if (present && refreshedOn && days(entry.date, refreshedOn) > 2) return 'stayed';
    // Gone without Subscroll seeing it leave, or not refreshed since the day.
    return 'pending';
  }

  const tally = () => ({ right: 0, total: 0 });
  function stats(judged) {
    const out = { likely: tally(), possible: tally(), rules: {} };
    for (const j of judged) {
      if (!['right', 'other-day', 'stayed'].includes(j.outcome)) continue;
      const bucket = j.likely ? out.likely : out.possible;
      const rule = (out.rules[`${ruleOf(j)}:${j.likely ? 'likely' : 'possible'}`] ||= tally());
      for (const t of [bucket, rule]) {
        t.total += 1;
        if (j.outcome === 'right') t.right += 1;
      }
    }
    return out;
  }

  function demoted(s, service, kind) {
    const r = s && s.rules[`${service}:${kind}:likely`];
    return !!r && r.total >= MIN_CHECKED && r.right / r.total < POOR;
  }

  const ruleStats = (s, service, kind, likely) => (s && s.rules[`${service}:${kind}:${likely ? 'likely' : 'possible'}`]) || null;

  const api = { record, judge, stats, demoted, ruleStats, MIN_CHECKED };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Scorecard = api;
})(this);
