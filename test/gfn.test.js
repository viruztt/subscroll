const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { GeForceNow, parseGfn, storeName } = require('../src/gfn');

// The shape of NVIDIA's list: one entry per game and store.
const LIST = [
  { id: 1, title: 'Hades', sortName: 'hades', store: 'Steam', status: 'AVAILABLE' },
  { id: 2, title: 'Hades', sortName: 'hades', store: 'Epic', status: 'AVAILABLE' },
  { id: 3, title: 'Forza Horizon 5', store: 'Xbox', status: 'AVAILABLE' },
  { id: 4, title: 'Assassin’s Creed® Mirage', store: 'Ubisoft Connect', status: 'AVAILABLE' },
  { id: 5, title: 'Fortnite®', store: 'None', status: 'AVAILABLE' },
  { id: 6, title: 'Coming Game', store: 'Steam', status: 'MAINTENANCE' },
  { title: '', store: 'Steam' },
];

test('GeForce NOW list: games by title with the stores they stream from', () => {
  const g = parseGfn(LIST);
  assert.deepStrictEqual(g.hades, ['Steam', 'Epic Games Store']);
  assert.deepStrictEqual(g.forzahorizon5, ['Xbox']);
  assert.deepStrictEqual(g.assassinscreedmirage, ['Ubisoft Connect']);
  // Free-to-play games stream without a store; games not available are left out.
  assert.deepStrictEqual(g.fortnite, []);
  assert.strictEqual(g.cominggame, undefined);
  assert.deepStrictEqual(parseGfn({ data: LIST.slice(0, 1) }), { hades: ['Steam'] });
  assert.deepStrictEqual(parseGfn(null), {});
  assert.strictEqual(storeName('EA'), 'EA app');
  assert.strictEqual(storeName('Battle.net'), 'Battle.net');
});

test('GeForce NOW fill: matches catalogue titles, not Switch Online games', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gfn-'));
  const gfn = new GeForceNow(dir);
  assert.strictEqual(gfn.due(), true);
  gfn.data = { at: new Date().toISOString(), games: parseGfn(LIST) };
  assert.deepStrictEqual(gfn.fill({ service: 'gamepass', title: 'Forza Horizon 5 (PC)' }).gfn, ['Xbox']);
  assert.strictEqual(gfn.fill({ service: 'nso', title: 'Hades' }).gfn, undefined);
  assert.strictEqual(gfn.fill({ service: 'psplus', title: 'Celeste' }).gfn, undefined);
  assert.strictEqual(gfn.due(), false);
});
