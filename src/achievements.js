// Xbox achievements and PlayStation trophies: games you've earned something
// in are marked as played, and games at 100% (or with the platinum) as
// completed. Each game is marked once, so a mark you remove stays removed.
//  - Xbox: OpenXBL (xbl.io), a free service that signs in to Xbox Live for
//    you and hands out an API key.
//  - PlayStation: Sony's own trophy API, signed in with the NPSSO code from
//    ca.account.sony.com/api/v1/ssocookie (while signed in on playstation.com).
const https = require('https');
const http = require('./providers/http');
const { unify, matchKey } = require('../renderer/unify');
const { t } = require('../renderer/i18n');

const XBL = 'https://xbl.io/api/v2/achievements';
const PSN_AUTH = 'https://ca.account.sony.com/api/authz/v3/oauth';
const PSN_TROPHIES = 'https://m.np.playstation.com/api/trophy/v1/users/me/trophyTitles';
// Sony's PlayStation App sign-in, as used by every PSN library.
const PSN_CLIENT = '09515159-7237-4370-9b40-3806e67c0891';
const PSN_BASIC = 'MDk1MTUxNTktNzIzNy00MzcwLTliNDAtMzgwNmU2N2MwODkxOnVjUGprYTV0bnRCMktxc1A=';
const PSN_REDIRECT = 'com.scee.psxandroid.scecompcall://redirect';

// "Marvel's Spider-Man 2 Trophies" -> without the suffix
const cleanTitle = (t) => String(t || '').replace(/\s+trophies$/i, '').replace(/\s*\((?:PS4|PS5|PS Vita|PS3)\)$/i, '').trim();

// ---- Xbox ----
function parseXbox(data) {
  const titles = (data && (data.titles || data.content?.titles)) || [];
  const out = [];
  for (const t of titles) {
    if (!t || !t.name || (t.type && t.type !== 'Game')) continue;
    const a = t.achievement || {};
    const earned = Number(a.currentAchievements) || 0;
    const total = Number(a.totalAchievements) || 0;
    const progress = Number(a.progressPercentage) || (total ? Math.round((earned / total) * 100) : 0);
    out.push({ name: t.name, earned, total, progress, completed: total > 0 && progress >= 100, played: earned > 0, lastPlayed: t.titleHistory?.lastTimePlayed || null });
  }
  return out;
}

async function fetchXbox(key) {
  try {
    return parseXbox(await http.getJson(XBL, { headers: { 'X-Authorization': key, 'Accept-Language': 'en-US' }, timeoutMs: 30000 }));
  } catch (err) {
    if (/HTTP (401|403)/.test(err.message)) throw new Error(t("OpenXBL didn't accept the API key. Check it at xbl.io (Profile → API keys)."));
    if (/HTTP 429/.test(err.message)) throw new Error(t('OpenXBL is limiting requests right now (its free plan allows 150 an hour). Try again later.'));
    throw new Error(t("Couldn't reach OpenXBL ({error}).", { error: err.message }));
  }
}

// ---- PlayStation ----
// The sign-in answers with a redirect carrying a code; fetch can't show
// that redirect, so this one request uses Node's https.
function psnCode(npsso) {
  const qs = new URLSearchParams({ access_type: 'offline', client_id: PSN_CLIENT, redirect_uri: PSN_REDIRECT, response_type: 'code', scope: 'psn:mobile.v2.core psn:clientapp' });
  return new Promise((resolve, reject) => {
    const req = https.get(`${PSN_AUTH}/authorize?${qs}`, { headers: { Cookie: `npsso=${npsso}` }, timeout: 20000 }, (res) => {
      res.resume();
      const loc = res.headers.location || '';
      const code = (loc.match(/[?&]code=([^&]+)/) || [])[1];
      if (code) resolve(decodeURIComponent(code));
      else reject(new Error(t("Sony didn't accept the NPSSO code. Sign in at playstation.com, open ca.account.sony.com/api/v1/ssocookie and copy the new code.")));
    });
    req.on('timeout', () => req.destroy(new Error('timed out')));
    req.on('error', (err) => reject(new Error(t("Couldn't reach Sony ({error}).", { error: err.message }))));
  });
}

async function psnToken(npsso) {
  const code = await psnCode(npsso);
  const res = await http.fetchRaw(`${PSN_AUTH}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: `Basic ${PSN_BASIC}` },
    body: new URLSearchParams({ code, redirect_uri: PSN_REDIRECT, grant_type: 'authorization_code', token_format: 'jwt' }).toString(),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) throw new Error(t("Sony didn't hand out a sign-in token. Get a fresh NPSSO code and try again."));
  return data.access_token;
}

function parsePsn(list) {
  return (list || []).filter((t) => t && t.trophyTitleName).map((t) => {
    const e = t.earnedTrophies || {};
    const earned = (e.bronze || 0) + (e.silver || 0) + (e.gold || 0) + (e.platinum || 0);
    const progress = Number(t.progress) || 0;
    return { name: cleanTitle(t.trophyTitleName), earned, progress, completed: progress >= 100 || (e.platinum || 0) > 0, played: earned > 0, lastPlayed: t.lastUpdatedDateTime || null };
  });
}

async function fetchPsn(npsso) {
  const token = await psnToken(npsso);
  const all = [];
  for (let offset = 0, guard = 0; guard < 10; guard++) {
    const data = await http.getJson(`${PSN_TROPHIES}?limit=800&offset=${offset}`, { headers: { Authorization: `Bearer ${token}`, 'Accept-Language': 'en-US' }, timeoutMs: 30000 })
      .catch((err) => { throw new Error(t("Couldn't read your trophies ({error}).", { error: err.message })); });
    all.push(...(data.trophyTitles || []));
    if (data.nextOffset == null || data.nextOffset <= offset) break;
    offset = data.nextOffset;
  }
  return parsePsn(all);
}

// ---- matching and marks ----
// Titles by the key the app merges games with; the furthest progress wins
// (a game on PS4 and PS5 has two trophy lists).
function titleIndex(titles) {
  const out = {};
  for (const t of titles) {
    const k = matchKey(t.name);
    if (!k) continue;
    const prev = out[k];
    if (!prev || t.progress > prev.progress || (t.completed && !prev.completed)) {
      out[k] = { name: t.name, earned: t.earned, total: t.total || null, progress: t.progress, completed: t.completed, played: t.played || (prev && prev.played), ...(t.lastPlayed ? { lastPlayed: t.lastPlayed } : {}) };
    }
  }
  return out;
}

// `done` holds what was marked before ("key:played", "key:completed").
function achievementMarks(games, index, marks, done = []) {
  const skip = new Set(done);
  const add = {};
  // When a game was completed: the last time it was played, as near as the service says.
  const finished = {};
  const clear = [];
  const keys = [];
  let found = 0;
  for (const g of unify(games.filter((x) => x.service !== 'nso'))) {
    const k = matchKey(g.title);
    const t = index[k];
    if (!t) continue;
    found += 1;
    const ids = (g.offers || [g]).map((o) => o.id);
    const current = ids.map((id) => marks[id]).find(Boolean) || null;
    if (current === 'ignored' || current === 'completed') continue;
    let next = null;
    if (t.completed && !skip.has(`${k}:completed`)) next = 'completed';
    else if (t.played && !current && !skip.has(`${k}:played`)) next = 'played';
    else if (t.played && current === 'wishlist' && !skip.has(`${k}:played`)) next = 'played';
    if (!next || next === current) continue;
    add[g.id] = next;
    if (next === 'completed' && /^\d{4}-\d{2}-\d{2}/.test(t.lastPlayed || '')) finished[g.id] = t.lastPlayed.slice(0, 10);
    clear.push(...ids.filter((id) => id !== g.id && marks[id]));
    // A completed game counts as played too, so a removed mark isn't put back as played.
    keys.push(`${k}:${next}`, ...(next === 'completed' ? [`${k}:played`] : []));
  }
  return { add, clear, keys, found, finished };
}

async function importAchievements(kind, secret, games, current = {}, marks = {}) {
  if (!secret) throw new Error(kind === 'xbox' ? t('Enter your OpenXBL API key.') : t('Enter your NPSSO code.'));
  const titles = kind === 'xbox' ? await fetchXbox(secret) : await fetchPsn(secret);
  const index = titleIndex(titles);
  const r = achievementMarks(games, index, marks, current.marked);
  const completed = Object.values(r.add).filter((m) => m === 'completed').length;
  return {
    account: {
      ...(kind === 'xbox' ? { key: secret } : { npsso: secret }),
      importedAt: new Date().toISOString(),
      count: titles.length,
      titles: index,
      marked: [...new Set([...(current.marked || []), ...r.keys])],
    },
    marks: r.add,
    finished: r.finished,
    clear: r.clear,
    summary: { titles: titles.length, inCatalogue: r.found, played: Object.keys(r.add).length - completed, completed },
  };
}

module.exports = { parseXbox, parsePsn, titleIndex, achievementMarks, importAchievements, cleanTitle };
