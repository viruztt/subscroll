const fs = require('fs');
const path = require('path');

const DEFAULT_STATE = {
  subscriptions: {}, // serviceId -> tierId
  marks: {}, // gameId -> 'played' | 'completed'
  leaveDates: {}, // gameId -> 'YYYY-MM-DD', entered by the user
  customServices: [], // { id, name, color, tiers: [{ id, name, includes }] }
  customGames: [], // same shape as catalogue games, service = a custom service id
  settings: { market: 'US', language: 'en-us', psLocale: 'en-us', autoRefreshHours: 24 },
};

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
      settings: { ...DEFAULT_STATE.settings, ...(saved.settings || {}) },
    };
  }

  get() {
    return this.state;
  }

  update(patch) {
    this.state = { ...this.state, ...patch };
    writeJson(this.file, this.state);
    return this.state;
  }
}

module.exports = { Store, readJson, writeJson, DEFAULT_STATE };
