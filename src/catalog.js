const path = require('path');
const { readJson, writeJson } = require('./store');
const gamepass = require('./providers/gamepass');
const psplus = require('./providers/psplus');
const nintendo = require('./providers/nintendo');
const covers = require('./providers/covers');
const msextras = require('./providers/msextras');
const netflix = require('./providers/netflix');
const arcade = require('./providers/applearcade');

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
    ubisoftplus: settings.market, netflix: settings.region || settings.market,
  }[service];
  return region ? `live:${region}` : 'live';
}

function applyHistory(prev, games, origin) {
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
  history.departed = history.departed.filter((g) => !ids.has(g.id)).slice(0, MAX_DEPARTED);
  return { history, added, removed };
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
        this.cache[service] = cached;
      } else {
        const snap = readJson(path.join(SNAPSHOT_DIR, `${service}.json`), { games: [], builtAt: null });
        this.cache[service] = {
          service,
          source: 'bundled',
          fetchedAt: snap.builtAt,
          games: mergeDuplicates(snap.games),
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

  // Re-applies App Store details found since the last refresh.
  reapplyArcade() {
    const entry = this.load('applearcade');
    if (!entry.games.length) return entry;
    const next = { ...entry, games: arcade.applyCached(entry.games, this.appStoreDir()) };
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
        let games = mergeDuplicates(await provider[source](settings, service === 'applearcade' ? this.appStoreDir() : undefined));
        if (service === 'nso') games = await covers.apply(games, path.join(this.dir, 'covers'));
        if (service === 'applearcade') games = arcade.applyCached(games, this.appStoreDir());
        if (games.length === 0) throw new Error('empty list');
        const prev = this.load(service);
        const origin = originOf(service, source, settings);
        const { history, added, removed } = applyHistory(prev, games, origin);
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

module.exports = { Catalog, SERVICES, mergeDuplicates, applyHistory, titleKey };
