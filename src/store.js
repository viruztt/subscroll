const fs = require('fs');
const path = require('path');
const Regions = require('../renderer/regions');

const DEFAULT_STATE = {
  subscriptions: {}, // serviceId -> tierId
  marks: {}, // gameId -> 'played' | 'completed' | 'ignored'
  leaveDates: {}, // gameId -> 'YYYY-MM-DD', entered by the user
  customServices: [], // { id, name, color, tiers: [{ id, name, includes }] }
  customGames: [], // same shape as catalogue games, service = a custom service id
  costs: {}, // serviceId -> { monthly, since: 'YYYY-MM' }, for the Value page
  priceOverrides: {}, // gameId -> price the user entered
  viaSub: {}, // gameId -> whether it was played through a subscription (when the user changed it)
  settings: { region: 'US', market: 'US', language: 'en-us', psLocale: 'en-us', autoRefreshHours: 24, hideDeparted: false, hideCompleted: false, hideIgnored: true, closeToTray: true, startWithWindows: false, alerts: true },
};

// The country picker sets every store code at once (renderer/regions.js).
// Settings saved before it existed had free-text codes; Microsoft and Sony
// use ISO country codes, so the UK is GB ("en-gb").
function normalizeSettings(s) {
  const out = { ...s };
  if (typeof out.market === 'string') out.market = out.market.trim().toUpperCase().replace(/^UK$/, 'GB');
  if (!out.region && Regions.isCountry(out.market)) out.region = out.market;
  const { missing, ...codes } = Regions.resolve(out.region, out.fallbackRegion);
  return Object.assign(out, codes);
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
