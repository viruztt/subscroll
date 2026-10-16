const path = require('path');
const { readJson, writeJson } = require('./store');
const gamepass = require('./providers/gamepass');
const psplus = require('./providers/psplus');
const nintendo = require('./providers/nintendo');

const SNAPSHOT_DIR = path.join(__dirname, '..', 'data', 'snapshot');
const MAX_DEPARTED = 300;

const PROVIDERS = {
  gamepass: { live: gamepass.fetchLive, mirror: gamepass.fetchMirror },
  psplus: { live: psplus.fetchLive, mirror: psplus.fetchMirror },
};

// Xbox lists console and Windows versions as separate products. Fold them
// into one entry per game so a title shows (and gets marked) once.
const plainKey = (title) => title.toLowerCase().replace(/[™®©]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
const WINDOWS_SUFFIX = /\s*[-–:(]?\s*(for )?(windows( 10| 11)?( edition)?|pc)\)?\s*$/i;

function titleKey(title) {
  return plainKey(title.replace(/[™®©]/g, '').replace(WINDOWS_SUFFIX, ''));
}

const isWindowsVariant = (g) => titleKey(g.title) !== plainKey(g.title);

function mergeDuplicates(games) {
  const byKey = new Map();
  for (const g of games) {
    const key = `${g.service}:${titleKey(g.title)}`;
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
function applyHistory(prev, games) {
  const history = { firstSeen: {}, departed: [], ...(prev && prev.history) };
  // A bundled snapshot may come from a different region; the first real
  // refresh after it becomes the baseline instead of a wave of false changes.
  const comparable = prev && prev.source !== 'bundled';
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
    if (service === 'nso') {
      return { service, source: 'bundled', fetchedAt: null, games: nintendo.load(), history: { firstSeen: {}, departed: [] } };
    }
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
    return ['gamepass', 'psplus', 'nso'].map((s) => this.load(s));
  }

  // Tries the official source first, then the community mirror. Returns a
  // summary; on total failure the previous catalogue stays in place.
  async refresh(service, settings) {
    const provider = PROVIDERS[service];
    if (!provider) return { service, ok: true, source: 'bundled', count: this.load(service).games.length };
    const errors = [];
    for (const source of ['live', 'mirror']) {
      try {
        const games = mergeDuplicates(await provider[source](settings));
        if (games.length === 0) throw new Error('empty list');
        const prev = this.load(service);
        const { history, added, removed } = applyHistory(prev, games);
        const entry = { service, source, fetchedAt: new Date().toISOString(), games, history };
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

module.exports = { Catalog, mergeDuplicates, applyHistory, titleKey };
