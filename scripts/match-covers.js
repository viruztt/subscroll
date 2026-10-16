// Matches the Switch Online titles in nintendo-source.txt to box art in the
// libretro-thumbnails collection on GitHub and writes nintendo-covers.json.
//
// Usage: node scripts/match-covers.js <dir-with-listings>
// where the dir holds one "<repo>.txt" per repo below, listing its
// Named_Boxarts files (`git ls-tree -r --name-only HEAD Named_Boxarts` on a
// blobless clone of github.com/libretro-thumbnails/<repo>).
const fs = require('fs');
const path = require('path');
const { parseSource } = require('../src/providers/nintendo');

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
const REGION_RANK = ['USA', 'World', 'Europe', 'Japan'];
const SKIP = /\((Beta|Proto|Demo|Sample|Kiosk|Aftermarket|Unl|Pirate|Hack|e-Reader)[^)]*\)/i;

// Manual matches for titles whose No-Intro name differs a lot.
const ALIASES = require('./nintendo-cover-aliases.json');

function key(title) {
  return title
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/^(the|a) /, '')
    .replace(/[^a-z0-9]+/g, '');
}

// "Legend of Zelda, The - A Link to the Past (USA)" -> "The Legend of Zelda - A Link to the Past"
function noIntroTitle(file) {
  let t = path.basename(file, '.png').split(' (')[0];
  t = t.replace(/^(.*?), (The|A|An)( - |$)/, '$2 $1$3');
  return t;
}

function regionScore(file) {
  const m = file.match(/\(([^)]*)\)/);
  const regions = m ? m[1].split(', ') : [];
  const ranks = regions.map((r) => REGION_RANK.indexOf(r)).filter((i) => i !== -1);
  return ranks.length ? Math.min(...ranks) : REGION_RANK.length;
}

function main(dir) {
  const games = parseSource(fs.readFileSync(path.join(__dirname, 'nintendo-source.txt'), 'utf8'));
  const index = {};
  for (const [system, repos] of Object.entries(REPOS)) {
    index[system] = new Map();
    for (const repo of repos) {
      const files = fs.readFileSync(path.join(dir, `${repo}.txt`), 'utf8').split('\n').filter((f) => f.endsWith('.png') && !SKIP.test(f));
      for (const file of files) {
        const k = key(noIntroTitle(file));
        const list = index[system].get(k) || [];
        list.push({ repo, file });
        index[system].set(k, list);
      }
    }
  }

  const covers = {};
  const missing = [];
  for (const g of games) {
    const system = g.platforms[0];
    const alias = ALIASES[`${system}|${g.title}`];
    const candidates = alias
      ? [{ repo: alias.repo || REPOS[system][0], file: `Named_Boxarts/${alias.file}` }]
      : index[system].get(key(g.title)) || [];
    if (candidates.length === 0) {
      missing.push(`${system}|${g.title}`);
      continue;
    }
    const best = [...candidates].sort((a, b) => regionScore(a.file) - regionScore(b.file) || a.file.length - b.file.length)[0];
    covers[g.id] = `https://raw.githubusercontent.com/libretro-thumbnails/${best.repo}/master/${best.file.split('/').map(encodeURIComponent).join('/')}`;
  }
  fs.writeFileSync(path.join(__dirname, 'nintendo-covers.json'), `${JSON.stringify(covers, null, 1)}\n`);
  console.log(`matched ${Object.keys(covers).length}/${games.length}`);
  if (missing.length) console.log(`no cover:\n  ${missing.join('\n  ')}`);
}

main(process.argv[2]);
