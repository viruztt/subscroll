// "Can I finish it in time?" for games leaving a service: How Long To Beat's
// time against the days left and how much you play.
//   pace:    hours a day you play, from your own setting, your Steam playtime
//            over the last two weeks, or the games you've completed lately.
//   verdict: { hours, days, perDay, estimated, status: 'ok' | 'tight' | 'unlikely' }
(function (root) {
  const DAY = 86400000;
  const utc = (iso) => Date.parse(`${String(iso).slice(0, 10)}T00:00:00Z`);
  const daysBetween = (from, to) => Math.round((utc(to) - utc(from)) / DAY);
  const iso = (ms) => new Date(ms).toISOString().slice(0, 10);

  // Hours a day when nothing else says: an hour.
  const DEFAULT_PER_DAY = 1;
  // How far back completed games count, and the shortest stretch they're
  // spread over, so finishing one long game this week isn't "10 hours a day".
  const FINISH_WINDOW = 90;
  const FINISH_MIN_SPAN = 30;
  // Steam's two-week figure is ignored once the last import is older than this.
  const STEAM_STALE_DAYS = 21;

  // Xbox flags games as leaving without a date and usually removes them on
  // the 15th or the last day of a month, so the next of those is the guess.
  function guessLeaveDate(today) {
    const d = new Date(utc(today));
    const y = d.getUTCFullYear();
    const m = d.getUTCMonth();
    const mid = Date.UTC(y, m, 15);
    const end = Date.UTC(y, m + 1, 0);
    return iso(d.getTime() <= mid ? mid : end);
  }

  // settings.playHoursWeek: a number to use instead of working it out.
  // steam: { recentMinutes, importedAt } from the Steam import.
  // finished: [{ date, hours }] completed games (hours: How Long To Beat).
  function pace({ hoursWeek, steam, finished = [], today }) {
    const set = Number(hoursWeek);
    if (set > 0) return { perDay: set / 7, source: 'setting' };
    const found = [];
    const steamFresh = !!(steam && steam.importedAt && daysBetween(steam.importedAt, today) <= STEAM_STALE_DAYS);
    if (steamFresh && steam.recentMinutes > 0) {
      found.push({ perDay: steam.recentMinutes / 60 / 14, source: 'steam' });
    }
    const from = iso(utc(today) - FINISH_WINDOW * DAY);
    const recent = finished.filter((f) => f.date && f.date > from && f.date <= today && Number(f.hours) > 0);
    if (recent.length) {
      const first = recent.map((f) => f.date).sort()[0];
      const span = Math.min(FINISH_WINDOW, Math.max(FINISH_MIN_SPAN, daysBetween(first, today) + 1));
      found.push({ perDay: recent.reduce((t, f) => t + Number(f.hours), 0) / span, source: 'finished', games: recent.length });
    }
    // Each only sees part of your playing (Steam misses consoles, finishes
    // miss games you play without finishing), so the larger one is closer.
    if (found.length) return found.sort((a, b) => b.perDay - a.perDay)[0];
    // Say why there's no figure when Steam is set up: not read yet, or no play lately.
    const why = !steamFresh ? null : steam.recentMinutes === undefined ? 'steam-pending' : 'steam-idle';
    return why ? { perDay: DEFAULT_PER_DAY, source: 'default', why } : { perDay: DEFAULT_PER_DAY, source: 'default' };
  }

  // beat: How Long To Beat hours. played: hours you've already put in, if known.
  // leave: { date } or { date: null } for a flag without a date.
  function verdict({ beat, played = 0, leave, today, perDay }) {
    if (!(beat > 0) || !leave) return null;
    const estimated = !leave.date;
    const date = leave.date || guessLeaveDate(today);
    const days = daysBetween(today, date);
    if (days < 0) return null;
    // Some time is always left: HLTB is an average, and played-on-Steam may be another run.
    const hours = Math.max(beat * 0.1, beat - (Number(played) || 0));
    const span = Math.max(1, days);
    const needed = hours / span;
    const status = needed <= perDay ? 'ok' : needed <= perDay * 1.5 ? 'tight' : 'unlikely';
    return { hours, played: Number(played) || 0, days, date, perDay: needed, estimated, status };
  }

  // Days you can still wait before starting at your pace (below 0: too late
  // at your pace). Sorting by this puts what to start now first.
  const startWithin = (v, pacePerDay) => v.days - v.hours / pacePerDay;

  const api = { pace, verdict, guessLeaveDate, startWithin, DEFAULT_PER_DAY };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Deadline = api;
})(this);
