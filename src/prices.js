// What a game costs to buy outright today, for the Value page: the full
// (not sale) price from the store of a service that has it, falling back to
// Steam. Looked up only for games you've marked, one at a time, cached for
// a month (two weeks when nothing was found).
const fs = require('fs');
const path = require('path');
const { getJson, fetchRaw } = require('./providers/http');
const { matchKey } = require('../renderer/unify');

const FRESH_DAYS = 30;
const MISS_DAYS = 14;
const PAUSE_MS = 1200;
const MICROSOFT_STORE = ['gamepass', 'eaplay', 'ubisoftplus'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- Microsoft Store: the product's list price (MSRP) ----
function microsoftPrice(product) {
  let best = null;
  for (const sku of product?.DisplaySkuAvailabilities || []) {
    for (const a of sku.Availabilities || []) {
      if (!(a.Actions || []).includes('Purchase')) continue;
      const p = a.OrderManagementData?.Price;
      const amount = Number(p?.MSRP) || Number(p?.ListPrice) || 0;
      if (amount > 0 && (!best || amount < best.amount)) best = { amount, currency: p.CurrencyCode };
    }
  }
  return best;
}

async function fromMicrosoft(offer, { market, language }) {
  const id = offer.id.split(':')[1];
  const data = await getJson(`https://displaycatalog.mp.microsoft.com/v7.0/products?bigIds=${id}&market=${market}&languages=${language}`);
  const price = microsoftPrice((data.Products || [])[0]);
  return price && { ...price, source: 'Microsoft Store', url: offer.storeUrl || null };
}

// ---- PlayStation Store: the page's embedded data has each edition's base
// price in minor units; the cheapest edition is the standard one. ----
function playstationPrice(html) {
  const values = [...html.matchAll(/"basePriceValue":(\d+)/g)].map((m) => Number(m[1])).filter((v) => v > 0);
  const currency = (html.match(/"currencyCode":"([A-Z]{3})"/) || [])[1];
  if (!values.length || !currency) return null;
  return { amount: Math.min(...values) / 100, currency };
}

async function fromPlayStation(offer, { psLocale }) {
  if (!offer.storeUrl) return null;
  const url = psLocale ? offer.storeUrl.replace(/\/[a-z]{2}-[a-z]{2}\/concept\//i, `/${psLocale}/concept/`) : offer.storeUrl;
  const res = await fetchRaw(url, { headers: { Accept: 'text/html' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} from store.playstation.com`);
  const price = playstationPrice(await res.text());
  return price && { ...price, source: 'PlayStation Store', url };
}

// ---- Steam: store search, exact title only ----
function steamPrice(items, title) {
  const key = matchKey(title);
  const hit = (items || []).find((i) => matchKey(i.name) === key && i.price?.initial > 0);
  return hit && { amount: hit.price.initial / 100, currency: hit.price.currency, source: 'Steam', url: `https://store.steampowered.com/app/${hit.id}/` };
}

async function fromSteam(title, { market }) {
  const data = await getJson(`https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(title)}&l=english&cc=${market}`);
  return steamPrice(data.items, title);
}

// Stores in the order they're asked: the service's own store first.
async function findPrice(game, settings) {
  const offers = game.offers || [game];
  for (const o of offers) {
    try {
      if (MICROSOFT_STORE.includes(o.service)) {
        const p = await fromMicrosoft(o, settings);
        if (p) return p;
      } else if (o.service === 'psplus') {
        const p = await fromPlayStation(o, settings);
        if (p) return p;
      }
    } catch {
      // Try the next store.
    }
  }
  // Retro Switch Online games aren't sold anywhere today.
  if (offers.every((o) => o.service === 'nso')) return null;
  try {
    return await fromSteam(game.title, settings);
  } catch {
    return null;
  }
}

class Prices {
  constructor(dir, { pauseMs = PAUSE_MS, onUpdate = () => {} } = {}) {
    this.file = path.join(dir, 'prices.json');
    this.pauseMs = pauseMs;
    this.onUpdate = onUpdate;
    this.running = null;
    try {
      this.cache = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      this.cache = {};
    }
  }

  all() {
    return this.cache;
  }

  // A different country means different prices.
  due(id, market, now = Date.now()) {
    const e = this.cache[id];
    if (!e || e.market !== market) return true;
    const days = e.amount ? FRESH_DAYS : MISS_DAYS;
    return now - new Date(e.at).getTime() > days * 86400000;
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.cache));
  }

  // games: [{ id, title, offers: [{ id, service, storeUrl }] }]
  lookup(games, settings) {
    if (this.running) return this.running;
    this.running = (async () => {
      const todo = games.filter((g) => this.due(g.id, settings.market));
      for (const [i, g] of todo.entries()) {
        const p = await findPrice(g, settings);
        const at = new Date().toISOString();
        // A price in another currency (a store that ignored the country) is no use.
        this.cache[g.id] = p && (!settings.currency || p.currency === settings.currency) ? { ...p, market: settings.market, at } : { amount: null, market: settings.market, at };
        this.save();
        this.onUpdate({ [g.id]: this.cache[g.id] }, { done: i + 1, total: todo.length });
        if (i < todo.length - 1) await sleep(this.pauseMs);
      }
    })();
    return this.running.finally(() => { this.running = null; });
  }
}

module.exports = { Prices, findPrice, microsoftPrice, playstationPrice, steamPrice };
