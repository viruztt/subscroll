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
  // Antstream Arcade's systems.
  'Amstrad CPC': ['Amstrad_-_CPC'],
  'Commodore 64': ['Commodore_-_64'],
  Amiga: ['Commodore_-_Amiga'],
  'ZX Spectrum': ['Sinclair_-_ZX_Spectrum'],
  MSX: ['Microsoft_-_MSX', 'Microsoft_-_MSX2'],
  DOS: ['DOS'],
  'Atari Lynx': ['Atari_-_Lynx'],
  'Atari 2600': ['Atari_-_2600'],
  'Atari 7800': ['Atari_-_7800'],
  'Atari ST': ['Atari_-_ST'],
  'Master System': ['Sega_-_Master_System_-_Mark_III'],
  'Game Gear': ['Sega_-_Game_Gear'],
  PlayStation: ['Sony_-_PlayStation'],
  'Neo Geo': ['SNK_-_Neo_Geo'],
  Arcade: ['MAME'],
};

// A system heading as Antstream's Wikipedia list writes it ("Super NES / Super
// Famicom", "MSX and MSX2") -> the system name above, or null.
const SYSTEM_NAMES = [
  [/super n(es|intendo)|snes|super famicom/i, 'SNES'],
  [/\bnes\b|famicom|nintendo entertainment/i, 'NES'],
  [/game boy advance/i, 'Game Boy Advance'],
  [/game boy/i, 'Game Boy'],
  [/mega drive|genesis/i, 'Sega Genesis'],
  [/master system/i, 'Master System'],
  [/game gear/i, 'Game Gear'],
  [/amstrad/i, 'Amstrad CPC'],
  [/commodore 64|\bc64\b/i, 'Commodore 64'],
  [/amiga/i, 'Amiga'],
  [/spectrum/i, 'ZX Spectrum'],
  [/\bmsx/i, 'MSX'],
  [/dos\b/i, 'DOS'],
  [/lynx/i, 'Atari Lynx'],
  [/2600/i, 'Atari 2600'],
  [/7800/i, 'Atari 7800'],
  [/atari st\b/i, 'Atari ST'],
  [/playstation|\bps1\b/i, 'PlayStation'],
  [/neo ?geo/i, 'Neo Geo'],
  [/arcade/i, 'Arcade'],
];
const systemName = (heading) => (SYSTEM_NAMES.find(([re]) => re.test(String(heading || ''))) || [])[1] || null;
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
    .replace(/\band\b/g, '') // No-Intro writes "&", which libretro turns into "_"
    .replace(/[^a-z0-9]+/g, '');
}

// Wikipedia lists special editions and regional copies separately:
// "Metroid SP (Ridley battle)", "Adventures of Lolo (NA)". They share the
// base game's box art.
function baseTitle(title) {
  return title
    .replace(/\s+\((NA|JP|EU|PAL)\)$/i, '')
    .replace(/\s+SP(\s+\(.*\))?$/, '')
    .trim();
}

// Shortened titles ("Donkey Kong Country 2") match the full No-Intro name
// ("Donkey Kong Country 2 - Diddy's Kong Quest") by prefix.
function prefixCandidates(bySystem, k) {
  if (!bySystem || k.length < 6) return [];
  let best = null;
  for (const [candidate, files] of bySystem) {
    if (candidate.startsWith(k) && (!best || candidate.length < best.key.length)) best = { key: candidate, files };
  }
  return best ? best.files : [];
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
function buildIndex(listings, systems = Object.keys(REPOS)) {
  const index = {};
  for (const system of systems) {
    const repos = REPOS[system] || [];
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
  const base = baseTitle(title);
  const alias = ALIASES[`${system}|${title}`] || ALIASES[`${system}|${base}`];
  if (alias) return urlFor(alias.repo || (REPOS[system] || [])[0], alias.file);
  const bySystem = index[system];
  let candidates = (bySystem && bySystem.get(key(base))) || [];
  if (!candidates.length) candidates = prefixCandidates(bySystem, key(base));
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
async function loadListings(cacheDir, systems = Object.keys(REPOS)) {
  const listings = {};
  const repos = [...new Set(systems.flatMap((s) => REPOS[s] || []))];
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

// Fills in `image` for Switch Online (and Antstream) games: live listing
// first, then the bundled map, then whatever the game already had.
// systemOf(game) names its system in REPOS.
async function apply(games, cacheDir, systemOf = (g) => g.platforms[0]) {
  const systems = [...new Set(games.map(systemOf))].filter((x) => REPOS[x]);
  let index = {};
  try {
    index = buildIndex(await loadListings(cacheDir, systems), systems);
  } catch {
    // Offline: the bundled map still covers the known library.
  }
  return games.map((g) => ({
    ...g,
    image: match(index, systemOf(g), g.title) || BUNDLED[g.id] || g.image || null,
  }));
}

module.exports = { REPOS, buildIndex, match, apply, key, noIntroTitle, baseTitle, systemName };
