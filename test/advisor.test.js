const test = require('node:test');
const assert = require('node:assert');
const { SERVICES } = require('../src/services');
const { advise } = require('../renderer/advisor');

const game = (id, service, tiers, extra = {}) => ({ id, title: id, service, tiers, ...extra });
const wish = new Set();
const markOf = (g) => (wish.has(g.id) ? 'wishlist' : 'none');
const opts = (subs, more = {}) => ({
  services: SERVICES, subscriptions: subs, markOf, today: '2026-10-17',
  comingOn: (g) => g.comingOn || null, leaving: (g) => !!g.leavingSoon, ...more,
});

test('advise: ranks plans by To play games they add, leaving soon first', () => {
  wish.clear();
  const games = [
    game('a', 'gamepass', ['premium']),
    game('b', 'gamepass', ['ultimate']),
    game('c', 'gamepass', ['pc']),
    game('d', 'psplus', ['extra'], { leavingSoon: true }),
    game('e', 'psplus', ['extra'], { leavingSoon: true }),
    game('f', 'nso', ['expansion']),
    game('g', 'nso', ['base']),
    game('h', 'eaplay', ['eaplay'], { comingOn: '2026-10-30', platforms: ['pc'] }),
    game('later', 'eaplay', ['eaplay'], { comingOn: '2027-03-01', platforms: ['pc'] }),
    game('notwanted', 'gamepass', ['essential']),
  ];
  ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'later'].forEach((id) => wish.add(id));
  const r = advise(games, opts({ nso: 'base' }));
  assert.strictEqual(r.total, 9);
  assert.strictEqual(r.ready, 1); // g, in NSO Standard you already have
  // PS Plus: 2 games, both leaving (score 4) beats Game Pass Ultimate: 4 games incl. EA Play's arriving one (score 3.5).
  assert.deepStrictEqual(r.options.map((o) => `${o.service}:${o.tier}`), ['psplus:extra', 'gamepass:ultimate', 'nso:expansion', 'eaplay:eaplay']);
  const gp = r.options[1];
  assert.deepStrictEqual(gp.games.map((g) => g.id), ['a', 'b', 'c', 'h']);
  assert.deepStrictEqual(gp.arriving.map((g) => g.id), ['h']);
  assert.deepStrictEqual(gp.smaller, { tier: 'pc', count: 2 }); // c, and h through EA Play
  assert.strictEqual(r.options[2].upgradeFrom, 'base');
  assert.deepStrictEqual(r.options[0].leaving.map((g) => g.id), ['d', 'e']);
});

test('advise: smaller tier picks the lower tier that covers most', () => {
  wish.clear();
  const games = [game('a', 'gamepass', ['pc']), game('b', 'gamepass', ['pc']), game('c', 'gamepass', ['ultimate']), game('d', 'gamepass', ['premium'])];
  games.forEach((g) => wish.add(g.id));
  const [gp] = advise(games, opts({})).options;
  assert.strictEqual(gp.tier, 'ultimate');
  assert.deepStrictEqual(gp.smaller, { tier: 'pc', count: 2 });
});

test('advise: month-by-month rotation and plans no To play game needs', () => {
  wish.clear();
  const games = [
    game('a', 'gamepass', ['ultimate']), game('b', 'gamepass', ['ultimate']), game('c', 'gamepass', ['ultimate']),
    game('d', 'psplus', ['essential']),
    game('e', 'ubisoftplus', ['premium'], { comingOn: '2026-12-20' }),
    game('n', 'nso', ['base']),
  ];
  games.forEach((g) => wish.add(g.id));
  const r = advise(games, opts({ nso: 'expansion', netflix: 'any' }));
  assert.deepStrictEqual(r.rotation, [
    { service: 'gamepass', tier: 'ultimate', count: 3 },
    { service: 'psplus', tier: 'essential', count: 1 },
    { service: 'ubisoftplus', tier: 'premium', count: 1 },
  ]);
  // E arrives in two months: in the rotation, not in this month's options.
  assert.ok(!r.options.some((o) => o.service === 'ubisoftplus'));
  assert.deepStrictEqual(r.keep, [
    { service: 'nso', tier: 'expansion', needs: 1, lower: 'base' },
    { service: 'netflix', tier: 'any', needs: 0, lower: null },
  ]);
});

test('advise: nothing to suggest when the list is empty or all ready', () => {
  wish.clear();
  const games = [game('a', 'gamepass', ['ultimate'])];
  assert.deepStrictEqual(advise(games, opts({})).options, []);
  wish.add('a');
  const r = advise(games, opts({ gamepass: 'ultimate' }));
  assert.strictEqual(r.ready, 1);
  assert.deepStrictEqual(r.options, []);
  assert.deepStrictEqual(r.rotation, []);
});
