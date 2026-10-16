// Rebuilds the catalogue data that ships inside the app, used until the
// first successful refresh (or whenever every online source is down).
const fs = require('fs');
const path = require('path');
const gamepass = require('../src/providers/gamepass');
const psplus = require('../src/providers/psplus');
const nintendo = require('../src/providers/nintendo');

const root = path.join(__dirname, '..');
const write = (rel, games) => {
  const file = path.join(root, rel);
  fs.writeFileSync(file, JSON.stringify({ builtAt: new Date().toISOString(), games }));
  console.log(`${rel}: ${games.length} games`);
};

const bundledCovers = require('../data/nintendo-covers.json');

(async () => {
  try {
    const nso = await nintendo.fetchLive();
    write('data/snapshot/nso.json', nso.map((g) => ({ ...g, image: bundledCovers[g.id] || null })));
  } catch (err) {
    console.log(`nso: Wikipedia failed (${err.message}), keeping the current snapshot`);
  }
  for (const [name, provider] of [['gamepass', gamepass], ['psplus', psplus]]) {
    try {
      write(`data/snapshot/${name}.json`, await provider.fetchLive());
    } catch (err) {
      console.log(`${name}: live source failed (${err.message}), using mirror`);
      write(`data/snapshot/${name}.json`, await provider.fetchMirror());
    }
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
