const { getJson } = require('./http');

// Meta Horizon+ (Meta Quest). Meta's store pages build their lists in the
// browser, so there's nothing an app can read there. Quest+ History
// (questplushistory.com), run by Carlos Santiago, records every game added
// to and removed from the Games Catalog and every month's games since the
// subscription began (July 2023), and publishes both as JSON:
//   catalog.json  { "2026": { "10": [{ title, url, event: "+" | "-" }] } }
//   monthly.json  { "2026": { "10": [{ title, url }] } }
// The catalog is every game whose latest event is an addition. Monthly games
// can be added to your library during their month and stay playable while
// you subscribe, so this month's are listed until the month ends.
const BASE = 'https://questplushistory.com/wp-content/plugins/quest-plus-tools/data';
const CATALOG_URL = `${BASE}/catalog.json`;
const MONTHLY_URL = `${BASE}/monthly.json`;

const slug = (s) => String(s).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
// "https://www.meta.com/experiences/1304877726278670/" -> "1304877726278670"
const appId = (url) => (String(url || '').match(/experiences\/(?:[^/]+\/)?(\d{6,})/) || [])[1] || null;

// Entries oldest first, each with its month as 'YYYY-MM'. Months aren't in
// order in the files, and a month's entries keep their order.
function entries(data) {
  const out = [];
  for (const [year, months] of Object.entries(data || {})) {
    if (!/^\d{4}$/.test(year) || !months || typeof months !== 'object') continue;
    for (const [month, list] of Object.entries(months)) {
      if (!/^\d{1,2}$/.test(month) || !Array.isArray(list)) continue;
      list.forEach((e, i) => { if (e && e.title) out.push({ ...e, month: `${year}-${month.padStart(2, '0')}`, i }); });
    }
  }
  return out.sort((a, b) => a.month.localeCompare(b.month) || a.i - b.i);
}

function makeGame(e, tier) {
  const id = appId(e.url);
  return {
    id: `horizonplus:${id || slug(e.title)}`,
    service: 'horizonplus',
    title: String(e.title).trim(),
    image: null,
    platforms: ['Meta Quest'],
    tiers: [tier],
    leavingSoon: false,
    genres: [],
    releaseDate: null,
    addedOn: null,
    storeUrl: /^https:\/\/(www\.)?(meta|oculus)\.com\//.test(e.url || '') ? e.url : null,
  };
}

const lastDay = (month) => {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
};

// Games in the catalog now, with the month each was (last) added.
function parseCatalog(data) {
  const now = new Map();
  for (const e of entries(data)) {
    const key = appId(e.url) || slug(e.title);
    if (e.event === '-') now.delete(key);
    else if (e.event === '+') now.set(key, e);
  }
  return [...now.values()].map((e) => ({ ...makeGame(e, 'catalog'), addedOn: `${e.month}-01` }));
}

// This month's games, while the month lasts.
function parseMonthly(data, today = new Date().toISOString().slice(0, 10)) {
  const month = today.slice(0, 7);
  return entries(data).filter((e) => e.month === month)
    .map((e) => ({ ...makeGame(e, 'monthly'), addedOn: `${month}-01`, leavesOn: lastDay(month), monthly: true }));
}

async function fetchLive() {
  const [catalog, monthly] = await Promise.all([getJson(CATALOG_URL, { timeoutMs: 30000 }), getJson(MONTHLY_URL, { timeoutMs: 30000 }).catch(() => null)]);
  const games = parseCatalog(catalog);
  // A change to the file's layout shouldn't empty the list.
  if (games.length < 15) throw new Error(`Horizon+ catalog looks incomplete (${games.length} games)`);
  const byId = new Map(games.map((g) => [g.id, g]));
  for (const g of monthly ? parseMonthly(monthly) : []) {
    const prev = byId.get(g.id);
    byId.set(g.id, prev ? { ...prev, tiers: [...new Set([...prev.tiers, 'monthly'])] } : g);
  }
  return [...byId.values()];
}

module.exports = { fetchLive, parseCatalog, parseMonthly, entries, appId, CATALOG_URL, MONTHLY_URL };
