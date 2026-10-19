// Which games stream on GeForce NOW. GeForce NOW doesn't give you games: it
// streams copies you own on Steam, Epic, Ubisoft, PC Game Pass and other PC
// stores. NVIDIA publishes the list of supported games (the one its website's
// games page uses), with one entry per game and store; it's read once a day.
const fs = require('fs');
const path = require('path');
const http = require('./providers/http');
const { matchKey } = require('../renderer/unify');

const SOURCE = 'https://static.nvidiagrid.net/supported-public-game-list/locales/gfnpc-en-US.json';
const CHECK_HOURS = 24;

// NVIDIA's store names, tidied: "Xbox" there means the PC Game Pass / Microsoft Store copy.
function storeName(s) {
  const x = String(s || '').trim();
  if (!x || /^none$/i.test(x)) return null;
  if (/steam/i.test(x)) return 'Steam';
  if (/epic/i.test(x)) return 'Epic Games Store';
  if (/xbox|microsoft/i.test(x)) return 'Xbox';
  if (/ubisoft|uplay/i.test(x)) return 'Ubisoft Connect';
  if (/^ea\b|origin/i.test(x)) return 'EA app';
  if (/gog/i.test(x)) return 'GOG';
  if (/battle\.?net/i.test(x)) return 'Battle.net';
  return x;
}

// title key -> stores it streams from. Entries not available (coming, patching) are left out.
function parseGfn(data) {
  const list = Array.isArray(data) ? data : Array.isArray(data?.data) ? data.data : Array.isArray(data?.games) ? data.games : [];
  const out = {};
  for (const g of list) {
    if (!g || !g.title) continue;
    if (g.status && !/^available$/i.test(g.status)) continue;
    const key = matchKey(g.title);
    if (!key) continue;
    const stores = (Array.isArray(g.stores) ? g.stores : [g.store]).map(storeName).filter(Boolean);
    out[key] = [...new Set([...(out[key] || []), ...stores])];
  }
  return out;
}

class GeForceNow {
  constructor(dir) {
    this.file = path.join(dir, 'gfn.json');
    this.running = null;
    try {
      this.data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      this.data = { at: null, games: {} };
    }
  }

  due(now = Date.now()) {
    return !this.data.at || now - new Date(this.data.at) > CHECK_HOURS * 3600000;
  }

  // Adds `gfn` (the stores it streams from) to a game on GeForce NOW. Switch
  // Online games are old console versions, so a PC game of the same name isn't them.
  fill(g) {
    if (g.service === 'nso') return g;
    const stores = (this.data.games || {})[matchKey(g.title)];
    return stores ? { ...g, gfn: stores } : g;
  }

  refresh() {
    if (this.running) return this.running;
    this.running = (async () => {
      const games = parseGfn(await http.getJson(SOURCE, { timeoutMs: 60000 }));
      if (!Object.keys(games).length) throw new Error('GeForce NOW list was empty');
      this.data = { at: new Date().toISOString(), games };
      try {
        fs.writeFileSync(this.file, JSON.stringify(this.data));
      } catch {
        // Cache only.
      }
      return Object.keys(games).length;
    })().finally(() => { this.running = null; });
    return this.running;
  }
}

module.exports = { GeForceNow, parseGfn, storeName, SOURCE };
