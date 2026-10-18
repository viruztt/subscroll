const { getText, getJson } = require('./http');

// Google Play Pass: Google doesn't publish its list. playpassBrowser
// (github.com/inkvolcano/playpassBrowser) checks every game's Play Store
// page for the Play Pass badge each month, per country, and publishes the
// result as one page with the data embedded as JSON. Each game is a row:
//   [title, genre index, appId, icon, [screenshot, count], developer,
//    listed as, in Play Pass, rating, ratings, installs, tags,
//    regions not offering it, {region: regional appId}, PEGI, first seen,
//    released, ...]
const BASE = 'https://raw.githubusercontent.com/inkvolcano/playpassBrowser/main';
const SOURCE = `${BASE}/index.html`;
const IMG = 'https://play-lh.googleusercontent.com/';
const APPS = 'Apps'; // Play Pass apps that aren't games

const img = (s) => (!s ? null : /^https?:/.test(s) ? s : IMG + s);

function parsePlayPass(html, { region = 'US' } = {}) {
  const m = String(html || '').match(/<script id="data" type="application\/json">([\s\S]*?)<\/script>/);
  if (!m) throw new Error('Play Pass list format changed');
  const data = JSON.parse(m[1]);
  const genres = data.genres || [];
  const regions = (data.regions || []).map((r) => r.code);
  const mine = regions.indexOf(String(region || 'US').toUpperCase());
  // Every game seen on the first check carries that day; only later ones are real join dates.
  const since = data.meta && data.meta.trackingSince;
  const out = [];
  for (const r of data.games || []) {
    if (!Array.isArray(r)) continue;
    const [title, genre, appId, icon, shots, developer, , inPass, , , , , notOffered, altIds, , firstSeen, released] = r;
    if (!title || !appId || inPass === 0 || genres[genre] === APPS) continue;
    if (mine >= 0 && Array.isArray(notOffered) && notOffered.includes(mine)) continue;
    const id = (mine >= 0 && altIds && altIds[String(mine)]) || appId;
    out.push({
      id: `playpass:${appId}`,
      service: 'playpass',
      title: String(title).trim(),
      image: img(icon),
      platforms: ['Mobile'],
      tiers: ['any'],
      leavingSoon: false,
      genres: genres[genre] ? [genres[genre]] : [],
      developer: developer || null,
      releaseDate: released || null,
      addedOn: firstSeen && since && firstSeen > since ? firstSeen : null,
      screenshots: Array.isArray(shots) && shots[0] ? [img(shots[0])] : [],
      storeUrl: `https://play.google.com/store/apps/details?id=${encodeURIComponent(id)}`,
      appId,
    });
  }
  return out;
}

async function fetchLive({ region = 'US', market = 'US' } = {}) {
  const games = parsePlayPass(await getText(SOURCE, { timeoutMs: 60000 }), { region: region || market });
  if (games.length < 100) throw new Error(`Play Pass list looks incomplete (${games.length} games)`);
  return games;
}

// Description and screenshots, from the same project's per-game files.
async function fetchDetails(appId) {
  const d = await getJson(`${BASE}/details/${encodeURIComponent(appId)}.json`);
  return {
    description: typeof d.description === 'string' ? d.description.replace(/\s+/g, ' ').trim().slice(0, 1200) || null : null,
    screenshots: Array.isArray(d.screenshots) ? d.screenshots.filter((s) => typeof s === 'string') : [],
  };
}

module.exports = { fetchLive, parsePlayPass, fetchDetails, SOURCE };
