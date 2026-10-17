const fs = require('fs');
const path = require('path');
const http = require('./providers/http');
const { key } = require('./ratings');

// Games that are free to keep for a limited time: Epic's weekly free games
// from Epic's own store feed (with exact end dates and next week's games),
// and Steam, GOG, Prime Gaming (now claimed through Amazon Luna) and Epic
// giveaways from GamerPower's public giveaway list.
const EPIC = 'https://store-site-backend-static-ipv4.ak.epicgames.com/freeGamesPromotions';
const GAMERPOWER = 'https://www.gamerpower.com/api/filter?platform=epic-games-store.steam.gog.pc&type=game&sort-by=date';
const CHECK_HOURS = 6;

const STORES = {
  epic: { name: 'Epic Games Store', short: 'Epic' },
  steam: { name: 'Steam', short: 'Steam' },
  gog: { name: 'GOG', short: 'GOG' },
  prime: { name: 'Prime Gaming (Amazon Luna)', short: 'Prime' },
};

// "2026-10-23T15:00:00.000Z" or "2026-10-23 23:59:00" -> ISO, or null.
function isoDate(s) {
  if (!s || s === 'N/A') return null;
  const d = new Date(/T/.test(s) ? s : `${s.replace(' ', 'T')}Z`);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

// ---- Epic's own feed ----
function epicPicture(e) {
  const imgs = e.keyImages || [];
  for (const type of ['OfferImageTall', 'Thumbnail', 'DieselStoreFrontTall', 'OfferImageWide', 'DieselStoreFrontWide']) {
    const hit = imgs.find((i) => i.type === type && i.url);
    if (hit) return hit.url;
  }
  return (imgs[0] && imgs[0].url) || null;
}

function epicUrl(e, locale) {
  const pages = [...((e.catalogNs && e.catalogNs.mappings) || []), ...(e.offerMappings || [])];
  const page = pages.find((m) => m.pageType === 'productHome') || pages[0];
  const slug = (page && page.pageSlug) || e.productSlug || e.urlSlug;
  if (!slug || /^[0-9a-f]{32}$/.test(slug)) return 'https://store.epicgames.com/free-games';
  return `https://store.epicgames.com/${locale}/p/${slug.replace(/\/home$/, '')}`;
}

// The free (100% off) window among a game's offers.
function freeWindow(groups) {
  for (const group of groups || []) {
    for (const o of group.promotionalOffers || []) {
      if (o.discountSetting && o.discountSetting.discountPercentage === 0) return { start: isoDate(o.startDate), end: isoDate(o.endDate) };
    }
  }
  return null;
}

function parseEpic(data, { now = new Date(), locale = 'en-US' } = {}) {
  const els = (((data || {}).data || {}).Catalog || {}).searchStore;
  const out = [];
  for (const e of (els && els.elements) || []) {
    const promo = e.promotions || {};
    const current = freeWindow(promo.promotionalOffers);
    const upcoming = freeWindow(promo.upcomingPromotionalOffers);
    const win = current || upcoming;
    if (!win || !win.end || new Date(win.end) <= now) continue;
    // A deal that isn't free right now, unless its free week is still to come.
    const price = e.price && e.price.totalPrice;
    if (current && price && price.discountPrice > 0 && new Date(win.start) <= now) continue;
    const later = !!(win.start && new Date(win.start) > now);
    const mystery = /mystery game/i.test(e.title || '');
    out.push({
      id: `epic:${e.namespace || ''}:${e.id}`,
      store: 'epic',
      title: e.title,
      image: mystery ? null : epicPicture(e),
      url: epicUrl(e, locale),
      start: win.start,
      end: win.end,
      upcoming: later,
      worth: (price && price.fmtPrice && price.fmtPrice.originalPrice && price.originalPrice > 0) ? price.fmtPrice.originalPrice : null,
      mystery,
    });
  }
  return out;
}

// ---- GamerPower ----
// "Pony Island (Steam) Giveaway" -> "Pony Island"
function cleanGiveawayTitle(t) {
  return String(t || '')
    .replace(/\s*\((?:steam|gog|gog\.com|epic games?(?: store)?|prime gaming|amazon(?: luna| prime)?|luna|pc)\)\s*/gi, ' ')
    .replace(/\s+(?:free\s+)?(?:steam\s+|gog\s+)?(?:key\s+)?giveaway$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function storeOf(g) {
  const text = `${g.title} ${g.platforms} ${g.description || ''} ${g.instructions || ''}`;
  if (/prime gaming|amazon luna|luna\.amazon|with (?:amazon )?prime\b/i.test(text)) return 'prime';
  if (/epic games/i.test(g.platforms || '') || /\(epic games/i.test(g.title || '')) return 'epic';
  if (/\bgog\b/i.test(g.platforms || '') || /\(gog/i.test(g.title || '')) return 'gog';
  if (/\bsteam\b/i.test(g.platforms || '')) return 'steam';
  return null;
}

function parseGamerPower(list, { now = new Date() } = {}) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const g of list) {
    if (g.status && g.status !== 'Active') continue;
    if (g.type && g.type !== 'Game') continue;
    // Playtests and demos aren't games you keep.
    if (/playtest|\bdemo\b|\bbeta\b|early access key/i.test(g.title || '')) continue;
    const store = storeOf(g);
    if (!store) continue;
    const end = isoDate(g.end_date);
    if (end && new Date(end) <= now) continue;
    out.push({
      id: `gp:${g.id}`,
      store,
      title: cleanGiveawayTitle(g.title),
      image: g.image || g.thumbnail || null,
      url: g.open_giveaway_url || g.open_giveaway || g.gamerpower_url || null,
      start: isoDate(g.published_date),
      end,
      upcoming: false,
      worth: g.worth && g.worth !== 'N/A' ? g.worth : null,
      // Keys handed out by a third party run out.
      limited: /\bkeys?\b/i.test(g.title || '') || /while (?:keys|supplies) last/i.test(g.description || ''),
    });
  }
  return out;
}

// Epic's own entries win over GamerPower's copy of the same game.
function mergeFree(epic, others) {
  const have = new Set(epic.map((g) => `epic:${key(g.title)}`));
  const seen = new Set();
  const out = [...epic];
  for (const g of others) {
    const k = `${g.store}:${key(g.title)}`;
    if (have.has(k) || seen.has(k)) continue;
    seen.add(k);
    out.push(g);
  }
  return out.sort((a, b) => (a.upcoming - b.upcoming) || ((a.end || '9') < (b.end || '9') ? -1 : (a.end || '9') > (b.end || '9') ? 1 : 0) || a.title.localeCompare(b.title));
}

// ---- reminders ----
// New giveaways, and ones ending within a day that you haven't claimed.
function freeAlerts(games, { known = null, reminded = [], marks = {}, now = new Date() }) {
  const was = new Set(known || []);
  const told = new Set(reminded);
  const open = games.filter((g) => !g.upcoming && !marks[g.id]);
  // The first check is a baseline: nothing in it is news.
  const added = known ? open.filter((g) => !was.has(g.id)) : [];
  const ending = open.filter((g) => g.end && !told.has(g.id) && new Date(g.end) - now < 26 * 3600000);
  return { added, ending };
}

class FreeGames {
  constructor(dir) {
    this.file = path.join(dir, 'freegames.json');
    this.running = null;
    try {
      this.data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      this.data = { at: null, games: [], errors: {} };
    }
  }

  // Ended giveaways drop off even before the next check.
  list(now = new Date()) {
    return { ...this.data, games: (this.data.games || []).filter((g) => !g.end || new Date(g.end) > now) };
  }

  due(now = Date.now()) {
    return !this.data.at || now - new Date(this.data.at) > CHECK_HOURS * 3600000;
  }

  refresh({ country = 'US', locale = 'en-US' } = {}) {
    if (this.running) return this.running;
    this.running = (async () => {
      const now = new Date();
      const errors = {};
      let epic = null;
      let others = null;
      try {
        const qs = new URLSearchParams({ locale, country, allowCountries: country });
        epic = parseEpic(await http.getJson(`${EPIC}?${qs}`), { now, locale });
      } catch (e) {
        errors.epic = e.message;
      }
      try {
        others = parseGamerPower(await http.getJson(GAMERPOWER), { now });
      } catch (e) {
        errors.gamerpower = e.message;
      }
      const prev = this.data.games || [];
      // A source that failed keeps what it last gave.
      if (!epic) epic = prev.filter((g) => g.id.startsWith('epic:'));
      if (!others) others = prev.filter((g) => g.id.startsWith('gp:'));
      this.data = { at: now.toISOString(), games: mergeFree(epic, others), errors };
      try {
        fs.writeFileSync(this.file, JSON.stringify(this.data));
      } catch {
        // Cache only.
      }
      return this.list(now);
    })().finally(() => { this.running = null; });
    return this.running;
  }
}

module.exports = { FreeGames, STORES, parseEpic, parseGamerPower, cleanGiveawayTitle, mergeFree, freeAlerts, isoDate };
