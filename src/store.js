const fs = require('fs');
const path = require('path');
const { regionById } = require('./regions');

const DEFAULT_STATE = {
  subscriptions: {}, // serviceId -> tierId
  marks: {}, // gameId -> 'played' | 'completed' | 'ignored'
  leaveDates: {}, // gameId -> 'YYYY-MM-DD', entered by the user
  customServices: [], // { id, name, color, tiers: [{ id, name, includes }] }
  customGames: [], // same shape as catalogue games, service = a custom service id
  settings: { region: 'US', market: 'US', language: 'en-us', psLocale: 'en-us', autoRefreshHours: 24, hideDeparted: false, hideCompleted: false, hideIgnored: true, closeToTray: true, startWithWindows: false, alerts: true },
};

// The region picker sets every store code at once. Settings saved before it
// existed had free-text codes; Microsoft and Sony use ISO country codes, so
// the UK is GB ("en-gb"), and an unknown code makes the official lists fail.
function normalizeSettings(s) {
  const out = { ...s };
  if (typeof out.market === 'string') out.market = out.market.trim().toUpperCase().replace(/^UK$/, 'GB');
  for (const k of ['language', 'psLocale']) {
    if (typeof out[k] === 'string') out[k] = out[k].trim().toLowerCase().replace(/_/g, '-').replace(/-uk$/, '-gb');
  }
  if (!out.region && regionById(out.market)) out.region = out.market;
  const region = regionById(out.region);
  if (region) Object.assign(out, { market: region.market, language: region.language, psLocale: region.psLocale });
  return out;
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

// Write to a temp file and rename, so a crash never leaves half a file.
function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 1));
  fs.renameSync(tmp, file);
}

class Store {
  constructor(dir) {
    this.file = path.join(dir, 'state.json');
    const saved = readJson(this.file, {});
    this.state = {
      ...structuredClone(DEFAULT_STATE),
      ...saved,
      settings: normalizeSettings({ ...DEFAULT_STATE.settings, ...(saved.settings || {}) }),
    };
  }

  get() {
    return this.state;
  }

  update(patch) {
    this.state = { ...this.state, ...patch };
    if (patch.settings) this.state.settings = normalizeSettings(this.state.settings);
    writeJson(this.file, this.state);
    return this.state;
  }
}

module.exports = { Store, readJson, writeJson, normalizeSettings, DEFAULT_STATE };
