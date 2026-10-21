const fs = require('fs');
const path = require('path');
const http = require('./providers/http');
const { key } = require('./ratings');
const monthly = require('./monthly');
const humble = require('./providers/humble');
const { tk } = require('../renderer/i18n');

// Games that are free to keep for a limited time: Epic's weekly free games
// from Epic's own store feed (with exact end dates and next week's games),
// and Steam, GOG, Prime Gaming (now claimed through Amazon Luna) and Epic
// giveaways from GamerPower's public giveaway list. Plus the subscription
// games with a claim window: PS Plus monthly games and Xbox Free Play Days
// (see monthly.js).
const EPIC = 'https://store-site-backend-static-ipv4.ak.epicgames.com/freeGamesPromotions';
const GAMERPOWER = 'https://www.gamerpower.com/api/filter?platform=epic-games-store.steam.gog.pc&type=game&sort-by=date';
const PS_MONTHLY = (locale) => `https://www.playstation.com/bin/imagic/gameslist?locale=${locale}&categoryList=plus-monthly-games-list`;
const PS_MONTHLY_MIRROR = 'https://raw.githubusercontent.com/ppazour/ps-plus-games-list/main/data/plus-monthly-games-list.json';
const PS_BLOG = ['https://blog.playstation.com/tag/playstation-plus/feed/', 'https://blog.playstation.com/feed/'];
const FREE_PLAY_DAYS = 'https://news.xbox.com/en-us/tag/free-play-days/feed/';
const CHECK_HOURS = 6;
// Bumped when a source is added, so the list is checked again straight away.
const DATA_VERSION = 3;

const STORES = {
  epic: { name: 'Epic Games Store', short: 'Epic' },
  steam: { name: 'Steam', short: 'Steam' },
  gog: { name: 'GOG', short: 'GOG' },
  prime: { name: 'Prime Gaming (Amazon Luna)', short: 'Prime' },
  psplus: { name: tk('PlayStation Plus monthly games'), short: 'PS Plus' },
  fpd: { name: 'Xbox Free Play Days', short: 'Free Play Days' },
  humble: { name: 'Humble Choice', short: 'Humble' },
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
// Free Play Days aren't yours to keep, so they get no last-day reminder.
function freeAlerts(games, { known = null, reminded = [], marks = {}, now = new Date() }) {
  const was = new Set(known || []);
  const told = new Set(reminded);
  const open = games.filter((g) => !g.upcoming && !marks[g.id]);
  // The first check of each source is a baseline: nothing in it is news.
  const sources = new Set([...was].map((id) => id.split(':')[0]));
  const added = known ? open.filter((g) => !was.has(g.id) && sources.has(g.id.split(':')[0])) : [];
  const ending = open.filter((g) => g.kind !== 'try' && g.end && !told.has(g.id) && new Date(g.end) - now < 26 * 3600000);
  return { added, ending };
}

class FreeGames {
  constructor(dir) {
    this.dir = dir;
    this.file = path.join(dir, 'freegames.json');
    this.running = null;
    try {
      this.data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      this.data = { at: null, games: [], errors: {} };
    }
    // Saved before the newest sources: keep the list, but check now.
    if (this.data.v !== DATA_VERSION) this.data.at = null;
  }

  // Ended giveaways drop off even before the next check.
  list(now = new Date()) {
    return { ...this.data, games: (this.data.games || []).filter((g) => !g.end || new Date(g.end) > now) };
  }

  due(now = Date.now()) {
    return !this.data.at || now - new Date(this.data.at) > CHECK_HOURS * 3600000;
  }

  // `now` is for tests.
  refresh({ country = 'US', locale = 'en-US', psLocale = 'en-us', now = new Date() } = {}) {
    if (this.running) return this.running;
    this.running = (async () => {
      const errors = {};
      let epic = null;
      let others = null;
      let ps = null;
      let psBlog = null;
      let fpd = null;
      let hc = null;
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
      try {
        ps = monthly.parsePsList(await http.getJson(PS_MONTHLY(psLocale)), { now });
      } catch (e) {
        try {
          // The mirror's store links are for Austria; point them at your country's store.
          ps = monthly.parsePsList(await http.getJson(PS_MONTHLY_MIRROR), { now })
            .map((g) => ({ ...g, url: g.url && g.url.replace(/store\.playstation\.com\/[a-z]{2}-[a-z]{2}\//, `store.playstation.com/${psLocale}/`) }));
        } catch {
          errors.psplus = e.message;
        }
      }
      for (const url of PS_BLOG) {
        try {
          psBlog = [...(psBlog || []), ...monthly.parsePsBlog(await http.getText(url), { now })];
        } catch (e) {
          if (!psBlog && url === PS_BLOG[PS_BLOG.length - 1]) errors.psblog = e.message;
        }
      }
      try {
        fpd = monthly.parseFreePlayDays(await http.getText(FREE_PLAY_DAYS), { now });
      } catch (e) {
        errors.fpd = e.message;
      }
      try {
        hc = (await humble.fetchPage(this.dir)).map((g) => ({
          id: `humble:${g.month}:${g.id.split(':')[1]}`, store: 'humble', title: g.title, image: g.image, url: humble.PAGE,
          start: g.start, end: g.end, startDay: g.start.slice(0, 10), endDay: g.end.slice(0, 10), upcoming: false, needs: 'humble',
        }));
      } catch (e) {
        errors.humble = e.message;
      }
      const prev = this.data.games || [];
      // A source that failed keeps what it last gave.
      const keep = (list, prefix) => list || prev.filter((g) => g.id.startsWith(prefix) && (!g.end || new Date(g.end) > now));
      epic = keep(epic, 'epic:');
      others = keep(others, 'gp:');
      ps = keep(ps, 'psplus:');
      fpd = keep(fpd, 'fpd:');
      hc = keep(hc, 'humble:');
      // The blog only fills in months playstation.com's list doesn't have yet.
      const listed = new Set(ps.map((g) => g.id.split(':')[1]));
      psBlog = keep(psBlog, 'psblog:').filter((g) => !listed.has(g.month));
      this.data = { v: DATA_VERSION, at: now.toISOString(), games: mergeFree(epic, [...others, ...ps, ...psBlog, ...fpd, ...hc]), errors };
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

module.exports = { FreeGames, STORES, parseEpic, parseGamerPower, cleanGiveawayTitle, mergeFree, freeAlerts, isoDate, hasPlan: monthly.hasPlan };
