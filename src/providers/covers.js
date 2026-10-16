const fs = require('fs');
const path = require('path');
const { getJson } = require('./http');

// Retro box art from the libretro-thumbnails collection on GitHub. File
// listings are fetched through the GitHub API (two calls per system, cached
// for a week) so games added to Switch Online later still get covers. The
// bundled map in data/nintendo-covers.json covers the offline case.
const REPOS = {
  NES: ['Nintendo_-_Nintendo_Entertainment_System'],
  SNES: ['Nintendo_-_Super_Nintendo_Entertainment_System'],
  'Game Boy': ['Nintendo_-_Game_Boy_Color', 'Nintendo_-_Game_Boy'],
  N64: ['Nintendo_-_Nintendo_64'],
  'Sega Genesis': ['Sega_-_Mega_Drive_-_Genesis'],
  'Game Boy Advance': ['Nintendo_-_Game_Boy_Advance'],
  'Virtual Boy': ['Nintendo_-_Virtual_Boy'],
  'GameCube (Switch 2)': ['Nintendo_-_GameCube'],
};
const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const LISTING_MAX_AGE_MS = 7 * 24 * 3600 * 1000;
const REGION_RANK = ['USA', 'World', 'Europe', 'Japan'];
const SKIP = /\((Beta|Proto|Demo|Sample|Kiosk|Aftermarket|Unl|Pirate|Hack|e-Reader)[^)]*\)|\[/i;

const readJson = (file, fallback) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
};
// Titles whose No-Intro file name differs too much to match automatically.
const ALIASES = readJson(path.join(DATA_DIR, 'nintendo-cover-aliases.json'), {});
const BUNDLED = readJson(path.join(DATA_DIR, 'nintendo-covers.json'), {});

function key(title) {
  return title
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/^(the|a) /, '')
    .replace(/[^a-z0-9]+/g, '');
}

// "Legend of Zelda, The - A Link to the Past (USA).png" -> "The Legend of Zelda - A Link to the Past"
function noIntroTitle(file) {
  const t = path.posix.basename(file, '.png').split(' (')[0];
  return t.replace(/^(.*?), (The|A|An)( - |$)/, '$2 $1$3');
}

function regionScore(file) {
  const m = file.match(/\(([^)]*)\)/);
  const ranks = (m ? m[1].split(', ') : []).map((r) => REGION_RANK.indexOf(r)).filter((i) => i !== -1);
  return ranks.length ? Math.min(...ranks) : REGION_RANK.length;
}

const urlFor = (repo, file) =>
  `https://raw.githubusercontent.com/libretro-thumbnails/${repo}/master/Named_Boxarts/${encodeURIComponent(file)}`;

// listings: { repo: [file names inside Named_Boxarts] }
function buildIndex(listings) {
  const index = {};
  for (const [system, repos] of Object.entries(REPOS)) {
    const bySystem = new Map();
    for (const repo of repos) {
      for (const file of listings[repo] || []) {
        if (!file.endsWith('.png') || SKIP.test(file)) continue;
        const k = key(noIntroTitle(file));
        if (!bySystem.has(k)) bySystem.set(k, []);
        bySystem.get(k).push({ repo, file });
      }
    }
    index[system] = bySystem;
  }
  return index;
}

function match(index, system, title) {
  const alias = ALIASES[`${system}|${title}`];
  if (alias) return urlFor(alias.repo || REPOS[system][0], alias.file);
  const candidates = (index[system] && index[system].get(key(title))) || [];
  if (!candidates.length) return null;
  const best = [...candidates].sort((a, b) => regionScore(a.file) - regionScore(b.file) || a.file.length - b.file.length)[0];
  return urlFor(best.repo, best.file);
}

async function fetchListing(repo) {
  const api = `https://api.github.com/repos/libretro-thumbnails/${repo}/git/trees`;
  const root = await getJson(`${api}/master`);
  const dir = (root.tree || []).find((t) => t.path === 'Named_Boxarts' && t.type === 'tree');
  if (!dir) throw new Error(`${repo} has no Named_Boxarts`);
  const tree = await getJson(`${api}/${dir.sha}`);
  return (tree.tree || []).filter((t) => t.type === 'blob').map((t) => t.path);
}

// Listings cached on disk; a failed fetch falls back to an older cache.
async function loadListings(cacheDir) {
  const listings = {};
  const repos = [...new Set(Object.values(REPOS).flat())];
  for (const repo of repos) {
    const file = path.join(cacheDir, `${repo}.json`);
    const cached = readJson(file, null);
    if (cached && Date.now() - cached.fetchedAt < LISTING_MAX_AGE_MS) {
      listings[repo] = cached.files;
      continue;
    }
    try {
      const files = await fetchListing(repo);
      fs.mkdirSync(cacheDir, { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ fetchedAt: Date.now(), files }));
      listings[repo] = files;
    } catch {
      if (cached) listings[repo] = cached.files;
    }
  }
  return listings;
}

// Fills in `image` for Switch Online games: live listing first, then the
// bundled map, then whatever the game already had.
async function apply(games, cacheDir) {
  let index = {};
  try {
    index = buildIndex(await loadListings(cacheDir));
  } catch {
    // Offline: the bundled map still covers the known library.
  }
  return games.map((g) => ({
    ...g,
    image: match(index, g.platforms[0], g.title) || BUNDLED[g.id] || g.image || null,
  }));
}

module.exports = { REPOS, buildIndex, match, apply, key, noIntroTitle };
