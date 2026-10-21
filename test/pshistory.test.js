const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('../src/providers/http');
const history = require('../src/providers/pshistory');
const psplus = require('../src/providers/psplus');

const list = (ids) => [{ catalogKey: 'A', games: ids.map((id) => ({ conceptId: id, name: `Game ${id}` })) }];

test('PS Plus history: a game joins on the first day it is listed', () => {
  const r = { lastSha: null, start: null, seen: {} };
  history.step(r, '2026-07-01', new Set(['1', '2']));
  history.step(r, '2026-07-21', new Set(['1', '2', '3']));
  // 2 leaves for a day and comes back: still the same stay.
  history.step(r, '2026-08-01', new Set(['1', '3']));
  history.step(r, '2026-08-02', new Set(['1', '2', '3']));
  // 3 leaves and is back weeks later: it joined again.
  history.step(r, '2026-08-18', new Set(['1', '2']));
  history.step(r, '2026-09-15', new Set(['1', '2', '3']));
  assert.deepStrictEqual(Object.fromEntries(history.joinDates({ files: { x: r } })), { 3: '2026-09-15' });
  assert.strictEqual(r.seen['1'].added, null); // there from the start: unknown
});

test('PS Plus history: reads new commits only, and adds join dates to the list', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pshist-'));
  const commits = { 'plus-games-list': [['c2', '2026-07-21', ['1', '2']], ['c1', '2026-07-01', ['1']]], 'plus-classics-list': [] };
  const raws = [];
  http.setFetch(async (url) => {
    const u = new URL(url);
    let body;
    if (u.host === 'api.github.com') {
      const file = u.searchParams.get('path').replace(/^data\/|\.json$/g, '');
      body = commits[file].map(([sha, date]) => ({ sha, commit: { committer: { date: `${date}T05:00:00Z` } } }));
    } else {
      raws.push(url);
      const [, , , sha] = u.pathname.split('/');
      body = list(Object.values(commits).flat().find((c) => c[0] === sha)[2]);
    }
    return { ok: true, json: async () => body };
  });
  const games = [{ id: 'psplus:1', title: 'One' }, { id: 'psplus:2', title: 'Two' }];
  const out = await history.withJoinDates(games, dir);
  assert.deepStrictEqual(out.map((g) => g.addedOn || null), [null, '2026-07-21']);
  assert.strictEqual(raws.length, 2);
  // A second run downloads nothing new.
  await history.withJoinDates(games, dir);
  assert.strictEqual(raws.length, 2);
  // Offline: the saved history still answers.
  http.setFetch(async () => { throw new Error('offline'); });
  assert.strictEqual((await history.withJoinDates(games, dir))[1].addedOn, '2026-07-21');
});

test('PS Plus: publisher from the product id', () => {
  assert.strictEqual(psplus.publisherOf('EP9000-CUSA00003_00-AAA'), 'Sony Interactive Entertainment');
  assert.strictEqual(psplus.publisherOf('UP1004-CUSA00419_00-GTAV'), 'Rockstar Games');
  assert.strictEqual(psplus.publisherOf('EP4008-CUSA1'), null);
  assert.strictEqual(psplus.publisherOf(null), null);
});
