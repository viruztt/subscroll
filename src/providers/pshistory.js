const path = require('path');
const { getJson, mapLimit } = require('./http');
const { readJson, writeJson } = require('../store');

// When each PS Plus game joined. playstation.com's lists don't say, but the
// ps-plus-games-list mirror commits the lists every day they change, so the
// first commit a game appears in is (within a day) when it joined. The
// mirror started on 2026-07-01: games already there have no date.
//
// Saved as psplus-history.json in the catalogue folder, and only commits
// newer than the last one read are downloaded.
const REPO = 'ppazour/ps-plus-games-list';
const FILES = ['plus-games-list', 'plus-classics-list'];
// A game missing for longer than this and then back has joined again.
const GAP_DAYS = 7;
const VERSION = 1;

const DAY = 86400000;
const keyOf = (g) => String(g.conceptId || g.productId || g.name);
const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / DAY);

function keysIn(payload) {
  if (!Array.isArray(payload)) return null;
  return new Set(payload.flatMap((group) => (Array.isArray(group.games) ? group.games : [])).map(keyOf));
}

// Folds one day's list into the file's record:
//   seen[key] = { added: date or null (there from the start), absentSince }
function step(record, date, keys) {
  const first = !record.start;
  if (first) record.start = date;
  for (const key of keys) {
    const s = record.seen[key];
    if (!s) record.seen[key] = { added: first ? null : date };
    else if (s.absentSince) {
      if (daysBetween(s.absentSince, date) > GAP_DAYS) s.added = date;
      delete s.absentSince;
    }
  }
  for (const [key, s] of Object.entries(record.seen)) {
    if (!keys.has(key) && !s.absentSince) s.absentSince = date;
  }
  return record;
}

// Commits that changed one file, oldest first, stopping at one already read.
async function newCommits(file, lastSha) {
  const out = [];
  for (let page = 1; page <= 10; page += 1) {
    const list = await getJson(`https://api.github.com/repos/${REPO}/commits?path=data/${file}.json&per_page=100&page=${page}`, {
      headers: { Accept: 'application/vnd.github+json' },
    });
    if (!Array.isArray(list)) throw new Error('Unexpected GitHub commits format');
    let reached = false;
    for (const c of list) {
      if (c.sha === lastSha) {
        reached = true;
        break;
      }
      out.push({ sha: c.sha, date: String(c.commit?.committer?.date || c.commit?.author?.date || '').slice(0, 10) });
    }
    if (reached || list.length < 100) break;
  }
  return out.filter((c) => c.date).reverse();
}

async function update(dir) {
  const file = path.join(dir, 'psplus-history.json');
  const saved = readJson(file, null);
  const state = saved && saved.version === VERSION ? saved : { version: VERSION, files: {} };
  for (const name of FILES) {
    const record = state.files[name] || { lastSha: null, start: null, seen: {} };
    const commits = await newCommits(name, record.lastSha);
    // Download in parallel, apply in order.
    const lists = await mapLimit(commits, 4, (c) => getJson(`https://raw.githubusercontent.com/${REPO}/${c.sha}/data/${name}.json`, { timeoutMs: 60000 }).catch(() => null));
    commits.forEach((c, i) => {
      const keys = keysIn(lists[i]);
      if (!keys || !keys.size) return;
      step(record, c.date, keys);
      record.lastSha = c.sha;
    });
    state.files[name] = record;
    // Save as it goes, so a failure on the next file keeps this one.
    writeJson(file, state);
  }
  return state;
}

// key -> date the game joined, over both lists (earliest known).
function joinDates(state) {
  const out = new Map();
  for (const record of Object.values((state && state.files) || {})) {
    for (const [key, s] of Object.entries(record.seen || {})) {
      if (!s.added) continue;
      if (!out.has(key) || s.added < out.get(key)) out.set(key, s.added);
    }
  }
  return out;
}

// Adds addedOn to PS Plus games from the history; the list stays as it is
// when GitHub can't be reached (the last saved history is used).
async function withJoinDates(games, dir) {
  if (!dir) return games;
  let state;
  try {
    state = await update(dir);
  } catch {
    state = readJson(path.join(dir, 'psplus-history.json'), null);
  }
  const dates = joinDates(state);
  if (!dates.size) return games;
  return games.map((g) => {
    const date = dates.get(g.id.replace(/^psplus:/, ''));
    return date && !g.addedOn ? { ...g, addedOn: date } : g;
  });
}

module.exports = { step, joinDates, withJoinDates, keysIn, newCommits, update };
