// Rebuilds data/nintendo-covers.json, the offline cover map for the bundled
// Switch Online list, from local listings of the libretro-thumbnails repos.
//
// Usage: node scripts/match-covers.js <dir-with-listings>
// where the dir holds one "<repo>.txt" per repo in src/providers/covers.js,
// listing its Named_Boxarts files (`git -c core.quotepath=off ls-tree -r
// --name-only HEAD Named_Boxarts` on a blobless clone).
const fs = require('fs');
const path = require('path');
const covers = require('../src/providers/covers');
const { parseSource } = require('../src/providers/nintendo');

const dir = process.argv[2];
const listings = {};
for (const repo of new Set(Object.values(covers.REPOS).flat())) {
  listings[repo] = fs.readFileSync(path.join(dir, `${repo}.txt`), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((f) => f.replace(/^Named_Boxarts\//, ''));
}
const index = covers.buildIndex(listings);
const map = {};
const missing = [];
for (const g of parseSource(fs.readFileSync(path.join(__dirname, 'nintendo-source.txt'), 'utf8'))) {
  const url = covers.match(index, g.platforms[0], g.title);
  if (url) map[g.id] = url;
  else missing.push(`${g.platforms[0]}|${g.title}`);
}
fs.writeFileSync(path.join(__dirname, '..', 'data', 'nintendo-covers.json'), `${JSON.stringify(map, null, 1)}\n`);
console.log(`matched ${Object.keys(map).length}`);
if (missing.length) console.log(`no cover:\n  ${missing.join('\n  ')}`);
