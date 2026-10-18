const test = require('node:test');
const assert = require('node:assert');
const { makeBackup, parseBackup, mergeHistory, mergeLookups, backupName } = require('../src/backup');

const state = {
  subscriptions: { nso: 'expansion', gamepass: 'ultimate' },
  marks: { 'nso:mario': 'completed', 'gamepass:A': 'played', 'psplus:B': 'ignored', 'gamepass:C': 'wishlist' },
  leaveDates: {},
  customServices: [{ id: 'custom:x', name: 'My service' }],
  customGames: [{ id: 'custom:g', title: 'My game' }],
  settings: { country: 'GB', hideDeparted: true },
  costs: { gamepass: { monthly: 14.99, since: '2024-01' } },
  freebies: { 'epic:ns:o1': 'claimed', 'gp:2': 'skip' },
  steam: { profile: '7656', key: 'KEY', owned: [{ appid: 1 }] },
  alertedLeaving: ['gamepass:A'],
  freeKnown: ['epic:ns:o1'],
  freeReminded: [],
  trayHintShown: true,
  catalog: { huge: true },
  lastRefresh: '2026-10-18T00:00:00Z',
};
const history = { gamepass: { firstSeen: { 'gamepass:A': '2026-10-06' }, departed: [{ id: 'gamepass:Z', title: 'Gone', leftOn: '2026-10-15' }] } };
const lookups = { ratings: { mario: { mc: 90 } }, prices: { 'gamepass:A': { amount: 59.99, market: 'GB' } }, wikipedia: {}, details: {}, appstore: {} };

test('Profile round trip keeps plans, marks, Steam, freebies, history and lookups, not catalogues', () => {
  const now = new Date('2026-10-16T12:00:00Z');
  const file = makeBackup(state, now, { history, lookups });
  assert.strictEqual(file.format, 'subscroll-backup');
  assert.strictEqual(file.version, 2);
  assert.strictEqual(file.exportedAt, '2026-10-16T12:00:00.000Z');
  assert.strictEqual(file.state.catalog, undefined);
  assert.strictEqual(file.state.lastRefresh, undefined);
  const back = parseBackup(JSON.stringify(file));
  assert.strictEqual(back.exportedAt, '2026-10-16T12:00:00.000Z');
  for (const k of ['marks', 'subscriptions', 'customGames', 'settings', 'costs', 'freebies', 'steam', 'alertedLeaving', 'freeKnown', 'freeReminded', 'trayHintShown']) {
    assert.deepStrictEqual(back.state[k], state[k], k);
  }
  assert.deepStrictEqual(back.history, history);
  assert.deepStrictEqual(back.lookups.ratings, lookups.ratings);
  assert.deepStrictEqual(back.lookups.prices, lookups.prices);
  assert.strictEqual(backupName(now), 'subscroll-profile-2026-10-16.json');
  // Without looked-up data.
  assert.deepStrictEqual(parseBackup(JSON.stringify(makeBackup(state, now, { history }))).lookups, {});
});

test('A version 1 backup still imports and leaves newer data alone', () => {
  const back = parseBackup(JSON.stringify({ format: 'subscroll-backup', version: 1, state: { marks: { a: 'played' }, subscriptions: { nso: 'base' } } }));
  assert.deepStrictEqual(back.state.marks, { a: 'played' });
  for (const k of ['freebies', 'steam', 'alertedLeaving', 'freeKnown', 'trayHintShown']) assert.strictEqual(k in back.state, false, k);
  assert.deepStrictEqual(back.history, {});
  assert.deepStrictEqual(back.lookups, {});
});

test('Other files are refused with a readable reason', () => {
  assert.throws(() => parseBackup('not json'), /isn't valid JSON/);
  assert.throws(() => parseBackup('{"marks":{}}'), /isn't a Subscroll profile/);
  assert.throws(() => parseBackup(JSON.stringify({ format: 'subscroll-backup', version: 99, state: {} })), /newer version/);
});

test('Unknown marks and broken fields are dropped', () => {
  const back = parseBackup(JSON.stringify({
    format: 'subscroll-backup',
    version: 2,
    state: { marks: { a: 'completed', b: 'loved', c: 5 }, subscriptions: 'nope', customGames: [1, { id: 'g' }], freebies: { x: 'claimed', y: 'maybe' }, steam: 'oops' },
    history: { gamepass: { firstSeen: { a: '2026-01-01', b: 3 }, departed: [{ id: 'z', title: 'Z' }, { title: 'no id' }] }, bad: 7 },
    lookups: { ratings: { a: { mc: 1 }, b: 'x' }, unknown: { a: {} } },
  }));
  assert.deepStrictEqual(back.state.marks, { a: 'completed' });
  assert.deepStrictEqual(back.state.subscriptions, {});
  assert.deepStrictEqual(back.state.customGames, [{ id: 'g' }]);
  assert.deepStrictEqual(back.state.freebies, { x: 'claimed' });
  assert.strictEqual(back.state.steam, null);
  assert.strictEqual('settings' in back.state, false);
  assert.deepStrictEqual(back.history, { gamepass: { firstSeen: { a: '2026-01-01' }, departed: [{ id: 'z', title: 'Z' }] } });
  assert.deepStrictEqual(back.lookups, { ratings: { a: { mc: 1 } } });
});

test('Importing merges history and fills in missing lookups only', () => {
  const merged = mergeHistory(
    { firstSeen: { a: '2026-10-10', b: '2026-09-01' }, departed: [{ id: 'x', title: 'X', leftOn: '2026-10-01' }] },
    { firstSeen: { a: '2026-10-06', b: '2026-09-05', c: '2026-08-01' }, departed: [{ id: 'x', title: 'X old', leftOn: '2026-09-01' }, { id: 'y', title: 'Y', leftOn: '2026-10-12' }] },
  );
  assert.deepStrictEqual(merged.firstSeen, { a: '2026-10-06', b: '2026-09-01', c: '2026-08-01' });
  assert.deepStrictEqual(merged.departed.map((g) => g.title), ['Y', 'X']);
  const local = { a: { v: 'mine' } };
  assert.strictEqual(mergeLookups(local, { a: { v: 'theirs' }, b: { v: 'new' } }), 1);
  assert.deepStrictEqual(local, { a: { v: 'mine' }, b: { v: 'new' } });
});
