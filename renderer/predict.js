// Predictions for games that could leave a service soon, from when they
// joined and who publishes them. Deals usually run a set number of months
// from the day a game joins, and services remove games on set days:
//   - most games sign for 12 months, renewed a year at a time;
//   - big publishers' games (Ubisoft, Warner Bros., Square Enix...) often 24;
//   - Rockstar and 2K games come for 3 to 6 months;
//   - the service's own studios' games stay.
// PS Plus removes games on the third Tuesday of the month, Game Pass on the
// 15th or the last day of the month.
//   predict(offer, { today, horizon }) -> { date, months, joined, likely, kind } | null
(function (root) {
  const DAY = 86400000;
  const utc = (iso) => Date.parse(`${String(iso).slice(0, 10)}T00:00:00Z`);
  const iso = (ms) => new Date(ms).toISOString().slice(0, 10);

  // Publishers that own the service, or have a deal that keeps their games on it.
  const OWN = {
    psplus: /sony interactive|playstation (studios|publishing)/i,
    gamepass: /xbox game studios|microsoft|bethesda|zenimax|activision|blizzard|mojang|electronic arts|^ea\b/i,
    eaplay: /electronic arts|^ea\b/i,
    ubisoftplus: /ubisoft/i,
    netflix: /netflix/i,
  };
  // Services whose whole catalogue is kept (classics libraries), or that
  // rotate on their own schedule (monthly games), aren't predicted.
  const SKIP = new Set(['nso', 'antstream', 'humble']);
  // Xbox flags games about two weeks before they leave, so a Game Pass
  // date closer than this without a flag means the deal was renewed.
  const FLAGGED_AHEAD = { gamepass: 14 };
  const SHORT = /rockstar|take-two|\b2k\b|^2k/i;
  const BIG = /ubisoft|warner bros|square enix|capcom|bandai namco|\bsega\b|konami|activision|electronic arts|bethesda|cd projekt|embracer|plaion|deep silver/i;

  // Months after joining when a deal could end; the first of `likely` is
  // the usual length, the rest are renewals.
  const TERMS = {
    short: { label: 'short', likely: [3, 6], then: 6 },
    big: { label: 'big', likely: [24], before: [12], then: 12 },
    standard: { label: 'standard', likely: [12], before: [6], then: 12 },
  };

  function kindOf(offer) {
    const who = [offer.publisher, offer.developer].filter(Boolean).join(' · ');
    if (OWN[offer.service] && OWN[offer.service].test(offer.publisher || '')) return 'own';
    if (SHORT.test(who)) return 'short';
    if (BIG.test(offer.publisher || '')) return 'big';
    return 'standard';
  }

  function addMonths(isoDate, n) {
    const d = new Date(utc(isoDate));
    const y = d.getUTCFullYear();
    const m = d.getUTCMonth() + n;
    const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
    return iso(Date.UTC(y, m, Math.min(d.getUTCDate(), last)));
  }

  function thirdTuesday(y, m) {
    const first = new Date(Date.UTC(y, m, 1)).getUTCDay();
    return Date.UTC(y, m, 1 + ((2 - first + 7) % 7) + 14);
  }

  // The day the service would remove a game whose deal ends on `end`.
  function leaveDay(service, end) {
    const d = new Date(utc(end));
    const y = d.getUTCFullYear();
    const m = d.getUTCMonth();
    if (service === 'psplus') return iso(thirdTuesday(y, m));
    // The last removal day on or just before the deal ends.
    const days = service === 'gamepass' || service === 'eaplay' || service === 'ubisoftplus'
      ? [Date.UTC(y, m, 0), Date.UTC(y, m, 15), Date.UTC(y, m + 1, 0)]
      : [Date.UTC(y, m, 0), Date.UTC(y, m + 1, 0)];
    const limit = utc(end) + 2 * DAY;
    return iso(Math.max(...days.filter((t) => t <= limit)));
  }

  // Candidate end points in months, each marked likely or not, up to `max` months.
  function candidates(kind, max) {
    const term = TERMS[kind];
    const out = [];
    for (const n of term.before || []) out.push({ months: n, likely: false });
    for (const n of term.likely) out.push({ months: n, likely: true });
    for (let n = term.likely[term.likely.length - 1] + term.then; n <= max; n += term.then) out.push({ months: n, likely: false });
    return out;
  }

  // offer: { service, joined (YYYY-MM-DD), publisher, developer, tiers }
  function predict(offer, { today, horizon = 45 } = {}) {
    if (!offer || !offer.joined || SKIP.has(offer.service)) return null;
    // PS Plus Essential's monthly games rotate every month on their own.
    if (offer.service === 'psplus' && (offer.tiers || []).every((t) => t === 'essential')) return null;
    const kind = kindOf(offer);
    if (kind === 'own') return null;
    const now = utc(today);
    const age = (now - utc(offer.joined)) / (30.44 * DAY);
    if (age < 0) return null;
    for (const c of candidates(kind, age + 13)) {
      const end = addMonths(offer.joined, c.months);
      const date = leaveDay(offer.service, end);
      const t = utc(date);
      if (t < now) continue;
      if (FLAGGED_AHEAD[offer.service] && t - now < FLAGGED_AHEAD[offer.service] * DAY) continue;
      if (t > now + horizon * DAY) return null;
      return { date, months: c.months, joined: offer.joined, likely: c.likely, kind };
    }
    return null;
  }

  const api = { predict, kindOf, leaveDay, addMonths, thirdTuesday };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Predict = api;
})(this);
