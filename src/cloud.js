const fs = require('fs');
const path = require('path');
const http = require('./providers/http');

// Which Xbox games can be streamed with Xbox Cloud Gaming, and on which Game
// Pass tiers. Microsoft's own answer needs one product lookup per game and
// joining its streaming programmes with the plans that include it; Gameglass
// (github.com/jackheuberger/gameglass), run by a former Xbox cloud engineer,
// does exactly that every few hours and publishes the result.
// PlayStation's lists say per game whether it streams (PS Plus Premium), so
// those come with the PS Plus list itself.
const SOURCE = 'https://raw.githubusercontent.com/jackheuberger/gameglass/main/data/games.json';
const CHECK_HOURS = 24;
const TIERS = ['essential', 'premium', 'ultimate'];

// product id -> { tiers: Game Pass tiers whose members can stream it, own: streams if you own it }
function parseCloud(data) {
  const games = (data && data.games) || [];
  const out = {};
  for (const g of games) {
    if (!g || g.streamable === false) continue;
    const t = g.tiers || {};
    const tiers = TIERS.filter((x) => t[x] === 'included' || t[x] === 'free');
    const own = TIERS.some((x) => t[x] === 'purchase');
    if (!tiers.length && !own) continue;
    const info = { tiers, own, free: TIERS.some((x) => t[x] === 'free') };
    for (const id of new Set([...(g.product_ids || []), g.base_product_id].filter(Boolean))) {
      const prev = out[id];
      out[id] = prev ? { tiers: [...new Set([...prev.tiers, ...info.tiers])], own: prev.own || info.own, free: prev.free || info.free } : info;
    }
  }
  return out;
}

// "gamepass:9NPDN9R45JX4" -> "9NPDN9R45JX4"
const productId = (id) => String(id || '').split(':').pop().toUpperCase();
const XBOX = new Set(['gamepass', 'eaplay', 'ubisoftplus']);

class Cloud {
  constructor(dir) {
    this.file = path.join(dir, 'cloud.json');
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

  // Adds `cloud` to an Xbox game that can be streamed.
  fill(g) {
    if (!XBOX.has(g.service)) return g;
    const games = this.data.games || {};
    for (const id of [g.id, ...(g.altIds || [])]) {
      const hit = games[productId(id)];
      if (hit) return { ...g, cloud: hit };
    }
    return g;
  }

  refresh() {
    if (this.running) return this.running;
    this.running = (async () => {
      const games = parseCloud(await http.getJson(SOURCE, { timeoutMs: 60000 }));
      if (!Object.keys(games).length) throw new Error('Cloud list was empty');
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

module.exports = { Cloud, parseCloud, SOURCE };
