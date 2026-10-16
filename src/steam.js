// Steam library import: which games you own on Steam and how long you've
// played them, from Steam's Web API (needs a free key and a profile whose
// game details are public). Games you've played go down as played; owned
// games get an "On Steam" badge.
const http = require('./providers/http');
const { unify, matchKey } = require('../renderer/unify');

const API = 'https://api.steampowered.com';
// Less than this is a launch, not a play.
const PLAYED_MINUTES = 30;

// Accepts a profile link (…/profiles/7656… or …/id/name), a 17-digit
// Steam ID, or the custom name from a profile link.
function parseProfile(input) {
  const s = String(input || '').trim();
  let m = s.match(/^(?:https?:\/\/)?(?:www\.)?steamcommunity\.com\/profiles\/(\d{17})/i) || s.match(/^(\d{17})$/);
  if (m) return { steamId: m[1] };
  m = s.match(/^(?:https?:\/\/)?(?:www\.)?steamcommunity\.com\/id\/([^/?#\s]+)/i) || s.match(/^([A-Za-z0-9_-]{2,32})$/);
  if (m) return { vanity: m[1] };
  return null;
}

async function call(method, params) {
  try {
    return await http.getJson(`${API}/${method}/?${new URLSearchParams(params)}`);
  } catch (err) {
    if (/HTTP (401|403)/.test(err.message)) throw new Error("Steam didn't accept the API key. Check it at steamcommunity.com/dev/apikey.");
    if (/HTTP 429/.test(err.message)) throw new Error('Steam is limiting requests right now. Try again in a few minutes.');
    throw new Error(`Couldn't reach Steam (${err.message}).`);
  }
}

async function resolveSteamId(input, key) {
  const p = parseProfile(input);
  if (!p) throw new Error('Enter your Steam profile link or Steam ID.');
  if (p.steamId) return p.steamId;
  const r = await call('ISteamUser/ResolveVanityURL/v1', { key, vanityurl: p.vanity });
  if (r?.response?.success !== 1) throw new Error(`Steam has no profile called "${p.vanity}".`);
  return r.response.steamid;
}

async function fetchOwned(steamId, key) {
  const r = await call('IPlayerService/GetOwnedGames/v1', { key, steamid: steamId, include_appinfo: 1, include_played_free_games: 1 });
  const list = r?.response?.games;
  if (!Array.isArray(list)) {
    if (r?.response?.game_count === 0) return [];
    // A private profile answers with an empty response.
    throw new Error("Steam didn't share this profile's games. In Steam, open your profile's Privacy Settings, set Game details to Public, then import again.");
  }
  return list.filter((g) => g.name).map((g) => ({ appid: g.appid, name: g.name, minutes: g.playtime_forever || 0 }));
}

// Owned games by the same title key the app merges games with, so
// "DOOM Eternal" on Steam finds "DOOM Eternal (PC)" in Game Pass.
function ownedIndex(owned) {
  const out = {};
  for (const g of owned) {
    const k = matchKey(g.name);
    if (!k) continue;
    if (!out[k] || g.minutes > out[k].minutes) out[k] = { appid: g.appid, name: g.name, minutes: g.minutes };
  }
  return out;
}

// Switch Online games are particular old console versions, so a Steam copy
// isn't the same game.
const steamable = (games) => unify(games.filter((g) => g.service !== 'nso'));

// Played games get marked once. `done` holds the titles marked before, so a
// mark the user removes isn't put back on the next import.
function playedMarks(games, index, marks, done = []) {
  const skip = new Set(done);
  const add = {};
  const clear = [];
  const keys = [];
  let owned = 0;
  for (const g of steamable(games)) {
    const k = matchKey(g.title);
    const s = index[k];
    if (!s) continue;
    owned += 1;
    if (s.minutes < PLAYED_MINUTES || skip.has(k)) continue;
    // A game on the To play list that you've since played moves on.
    if ((g.offers || [g]).some((o) => marks[o.id] && marks[o.id] !== 'wishlist')) continue;
    add[g.id] = 'played';
    clear.push(...(g.offers || [g]).map((o) => o.id).filter((id) => id !== g.id && marks[id]));
    keys.push(k);
  }
  return { add, clear, keys, owned };
}

async function importLibrary({ profile, key }, games, current = {}, marks = {}) {
  if (!key) throw new Error('Enter your Steam Web API key.');
  const steamId = await resolveSteamId(profile, key);
  const owned = await fetchOwned(steamId, key);
  const index = ownedIndex(owned);
  const { add, clear, keys, owned: inCatalogue } = playedMarks(games, index, marks, current.marked);
  return {
    steam: {
      profile, key, steamId,
      importedAt: new Date().toISOString(),
      count: owned.length,
      owned: index,
      marked: [...new Set([...(current.marked || []), ...keys])],
    },
    marks: add,
    clear,
    summary: { owned: owned.length, inCatalogue, marked: Object.keys(add).length },
  };
}

module.exports = { parseProfile, resolveSteamId, fetchOwned, ownedIndex, playedMarks, importLibrary, PLAYED_MINUTES };
