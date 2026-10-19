const path = require('path');
const { readJson, writeJson } = require('./store');
const gamepass = require('./providers/gamepass');
const psplus = require('./providers/psplus');
const nintendo = require('./providers/nintendo');
const covers = require('./providers/covers');
const msextras = require('./providers/msextras');
const netflix = require('./providers/netflix');
const arcade = require('./providers/applearcade');
const crunchyroll = require('./providers/crunchyroll');
const humble = require('./providers/humble');
const playpass = require('./providers/playpass');
const luna = require('./providers/luna');
const horizonplus = require('./providers/horizonplus');
const antstream = require('./providers/antstream');

const SNAPSHOT_DIR = path.join(__dirname, '..', 'data', 'snapshot');
const MAX_DEPARTED = 300;

const PROVIDERS = {
  gamepass: { live: gamepass.fetchLive, mirror: gamepass.fetchMirror },
  psplus: { live: psplus.fetchLive, mirror: psplus.fetchMirror },
  nso: { live: nintendo.fetchLive },
  eaplay: { live: msextras.fetchEaPlay },
  ubisoftplus: { live: msextras.fetchUbisoftPlus },
  netflix: { live: netflix.fetchLive },
  applearcade: { live: arcade.fetchLive },
  crunchyroll: { live: crunchyroll.fetchLive },
  humble: { live: humble.fetchLive },
  playpass: { live: playpass.fetchLive },
  luna: { live: luna.fetchLive },
  horizonplus: { live: horizonplus.fetchLive },
  antstream: { live: antstream.fetchLive },
};
const SERVICES = Object.keys(PROVIDERS);

// Xbox lists console and Windows versions as separate products. Fold them
// into one entry per game so a title shows (and gets marked) once. Retro
// games share titles across systems (Dr. Mario on NES and Game Boy), so the
// Switch Online library is left alone.
const plainKey = (title) => title.toLowerCase().replace(/[™®©]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
const WINDOWS_SUFFIX = /\s*[-–:(]?\s*(for )?(windows( 10| 11)?( edition)?|pc)\)?\s*$/i;

function titleKey(title) {
  return plainKey(title.replace(/[™®©]/g, '').replace(WINDOWS_SUFFIX, ''));
}

const isWindowsVariant = (g) => titleKey(g.title) !== plainKey(g.title);

function mergeDuplicates(games) {
  const byKey = new Map();
  for (const g of games) {
    const key = g.service === 'nso' ? g.id : `${g.service}:${titleKey(g.title)}`;
    const prev = byKey.get(key);
    if (!prev) {
      byKey.set(key, { ...g, altIds: [] });
      continue;
    }
    // Keep the version without a "Windows" suffix as the visible entry.
    const [primary, other] = isWindowsVariant(prev) && !isWindowsVariant(g) ? [g, prev] : [prev, g];
    byKey.set(key, {
      ...primary,
      image: primary.image || other.image,
      description: primary.description || other.description,
      screenshots: primary.screenshots && primary.screenshots.length ? primary.screenshots : other.screenshots,
      platforms: [...new Set([...primary.platforms, ...other.platforms])],
      tiers: [...new Set([...primary.tiers, ...other.tiers])],
      leavingSoon: primary.leavingSoon || other.leavingSoon,
      altIds: [...prev.altIds, other.id],
    });
  }
  return [...byKey.values()];
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

// Compare a fresh list with the previous one: stamp newly seen games and
// remember the ones that disappeared, so the app can show "new" and "left".
// Where a list came from: the official source for a given region, or a
// mirror (which always uses its own region).
function originOf(service, source, settings = {}) {
  if (source !== 'live') return source;
  const region = {
    gamepass: settings.market, psplus: settings.psLocale, eaplay: settings.market,
    ubisoftplus: settings.market, netflix: settings.region || settings.market, crunchyroll: settings.region || settings.market,
    playpass: settings.region || settings.market,
  }[service];
  return region ? `live:${region}` : 'live';
}

// `left`: games the source itself lists as gone, with the date when known.
function applyHistory(prev, games, origin, left = []) {
  const history = { firstSeen: {}, departed: [], ...(prev && prev.history) };
  // Lists from different sources or regions differ by a few hundred games,
  // so switching between them would look like a wave of arrivals and
  // departures. The first list from a new origin becomes the baseline.
  const prevOrigin = prev && (prev.origin || prev.source);
  const comparable = prev && prev.source !== 'bundled' && (origin === undefined || prevOrigin === origin ||
    (!prev.origin && prevOrigin === 'live' && origin.startsWith('live')));
  const ids = new Set(games.map((g) => g.id));
  const added = [];
  const removed = [];
  if (comparable) {
    const prevIds = new Set(prev.games.map((g) => g.id));
    for (const g of games) {
      if (!prevIds.has(g.id)) {
        history.firstSeen[g.id] = today();
        added.push(g.title);
      }
    }
    for (const g of prev.games) {
      if (!ids.has(g.id)) {
        history.departed.unshift({ ...g, leftOn: today() });
        removed.push(g.title);
      }
    }
  }
  for (const g of left) {
    if (ids.has(g.id)) continue;
    const { gone, ...game } = g;
    const known = history.departed.find((d) => d.id === g.id);
    if (!known) history.departed.push({ ...game, leftOn: g.leftOn || null, departed: true });
    else if (g.leftOn) known.leftOn = g.leftOn; // the real date rather than the day it was noticed
  }
  history.departed = history.departed.filter((g) => !ids.has(g.id))
    .sort((a, b) => (b.leftOn || '').localeCompare(a.leftOn || ''))
    .slice(0, MAX_DEPARTED);
  return { history, added, removed };
}

// Stores fill unknown release dates with placeholders, such as Microsoft's
// 9998-12-30 for games without a date yet. Those count as no date.
function realDate(d) {
  if (!d || !/^\d{4}-\d{2}-\d{2}/.test(d)) return d || null;
  const year = Number(d.slice(0, 4));
  return year < 1950 || year > new Date().getFullYear() + 15 ? null : d;
}
const cleanDates = (games = []) => games.map((g) => (g.releaseDate && realDate(g.releaseDate) !== g.releaseDate ? { ...g, releaseDate: null } : g));
function withRealDates(entry) {
  const history = entry.history && { ...entry.history, departed: cleanDates(entry.history.departed) };
  return { ...entry, games: cleanDates(entry.games), ...(history ? { history } : {}) };
}

// Departed lists merged by id, keeping the first one's entries.
function mergeDeparted(a = [], b = []) {
  const ids = new Set(a.map((g) => g.id));
  return [...a, ...b.filter((g) => !ids.has(g.id))].slice(0, MAX_DEPARTED);
}

class Catalog {
  constructor(dir) {
    this.dir = path.join(dir, 'catalog');
    this.cache = {};
  }

  fileFor(service) {
    return path.join(this.dir, `${service}.json`);
  }

  load(service) {
    if (!this.cache[service]) {
      const cached = readJson(this.fileFor(service), null);
      if (cached) {
        this.cache[service] = withRealDates(cached);
      } else {
        const snap = readJson(path.join(SNAPSHOT_DIR, `${service}.json`), { games: [], builtAt: null });
        this.cache[service] = {
          service,
          source: 'bundled',
          fetchedAt: snap.builtAt,
          games: cleanDates(mergeDuplicates(snap.games)),
          history: { firstSeen: {}, departed: [] },
        };
      }
    }
    return this.cache[service];
  }

  loadAll() {
    return SERVICES.map((s) => this.load(s));
  }

  appStoreDir() {
    return path.join(this.dir, 'appstore');
  }

  // Adds history from an imported profile: earliest join dates, departed
  // games from both.
  importHistory(service, incoming, merge) {
    if (!SERVICES.includes(service)) return false;
    const entry = this.load(service);
    const next = { ...entry, history: merge(entry.history, incoming, MAX_DEPARTED) };
    // Drop departed games that are back in the list.
    const ids = new Set(entry.games.map((g) => g.id));
    next.history.departed = next.history.departed.filter((g) => !ids.has(g.id));
    writeJson(this.fileFor(service), next);
    this.cache[service] = next;
    return true;
  }

  // Re-applies App Store details found since the last refresh.
  reapplyArcade() {
    const entry = this.load('applearcade');
    if (!entry.games.length) return entry;
    const all = arcade.applyCached(entry.games, this.appStoreDir());
    // Games found to be off the App Store move to the departed list.
    const games = all.filter((g) => !g.gone);
    const { history } = applyHistory(null, games, entry.origin, all.filter((g) => g.gone));
    const next = { ...entry, games, history: { ...history, firstSeen: entry.history?.firstSeen || {}, departed: mergeDeparted(entry.history?.departed, history.departed) } };
    if (entry.source !== 'bundled') writeJson(this.fileFor('applearcade'), next);
    this.cache.applearcade = next;
    return next;
  }

  // Tries the official source first, then the community mirror. Returns a
  // summary; on total failure the previous catalogue stays in place.
  async refresh(service, settings) {
    const provider = PROVIDERS[service];
    const errors = [];
    for (const source of ['live', 'mirror'].filter((s) => provider[s])) {
      try {
        const all = cleanDates(mergeDuplicates(await provider[source](settings, service === 'applearcade' ? this.appStoreDir() : this.dir)));
        const left = all.filter((g) => g.gone);
        let games = all.filter((g) => !g.gone);
        if (service === 'nso') games = await covers.apply(games, path.join(this.dir, 'covers'));
        if (service === 'antstream') games = await covers.apply(games, path.join(this.dir, 'covers'), (g) => covers.systemName(g.system));
        if (service === 'applearcade') games = arcade.applyCached(games, this.appStoreDir());
        if (games.length === 0) throw new Error('empty list');
        const prev = this.load(service);
        const origin = originOf(service, source, settings);
        const { history, added, removed } = applyHistory(prev, games, origin, left);
        const entry = { service, source, origin, fetchedAt: new Date().toISOString(), games, history };
        writeJson(this.fileFor(service), entry);
        this.cache[service] = entry;
        return { service, ok: true, source, count: games.length, added, removed, errors };
      } catch (err) {
        errors.push(`${source}: ${err.message}`);
      }
    }
    return { service, ok: false, errors };
  }
}

module.exports = { Catalog, SERVICES, mergeDuplicates, applyHistory, titleKey, realDate };
