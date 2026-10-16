const fs = require('fs');
const path = require('path');

// Nintendo publishes no machine-readable list, so the library ships as a
// curated file (scripts/nintendo-source.txt -> data/nintendo.json).
const DATA_FILE = path.join(__dirname, '..', '..', 'data', 'nintendo.json');

const slug = (s) => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

// Box art from the libretro-thumbnails collection, matched by
// scripts/match-covers.js. Missing entries just show a plain tile.
function loadCovers() {
  try {
    return require('../../scripts/nintendo-covers.json');
  } catch {
    return {};
  }
}

function parseSource(text, covers = loadCovers()) {
  const games = [];
  let system = null;
  let tier = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || (line.startsWith('#') && !line.startsWith('###'))) continue;
    if (line.startsWith('###')) {
      [system, tier] = line.slice(3).split('|').map((s) => s.trim());
      continue;
    }
    if (!system) continue;
    const id = `nso:${slug(system)}:${slug(line)}`;
    games.push({
      id,
      service: 'nso',
      title: line,
      image: covers[id] || null,
      platforms: [system],
      tiers: [tier],
      leavingSoon: false,
      genres: [],
      releaseDate: null,
      storeUrl: null,
    });
  }
  return games;
}

function load() {
  return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')).games;
}

module.exports = { parseSource, load, DATA_FILE };
