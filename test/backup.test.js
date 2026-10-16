const test = require('node:test');
const assert = require('node:assert');
const { makeBackup, parseBackup, backupName } = require('../src/backup');

const state = {
  subscriptions: { nso: 'expansion', gamepass: 'ultimate' },
  marks: { 'nso:mario': 'completed', 'gamepass:A': 'played', 'psplus:B': 'ignored' },
  leaveDates: {},
  customServices: [{ id: 'custom:x', name: 'My service' }],
  customGames: [{ id: 'custom:g', title: 'My game' }],
  settings: { country: 'GB', hideDeparted: true },
  catalog: { huge: true },
};

test('Backup round trip keeps plans, marks and settings, not catalogues', () => {
  const now = new Date('2026-10-16T12:00:00Z');
  const file = makeBackup(state, now);
  assert.strictEqual(file.format, 'subscroll-backup');
  assert.strictEqual(file.exportedAt, '2026-10-16T12:00:00.000Z');
  assert.strictEqual(file.state.catalog, undefined);
  const back = parseBackup(JSON.stringify(file));
  assert.strictEqual(back.exportedAt, '2026-10-16T12:00:00.000Z');
  assert.deepStrictEqual(back.state.marks, state.marks);
  assert.deepStrictEqual(back.state.subscriptions, state.subscriptions);
  assert.deepStrictEqual(back.state.customGames, state.customGames);
  assert.deepStrictEqual(back.state.settings, state.settings);
  assert.strictEqual(backupName(now), 'subscroll-backup-2026-10-16.json');
});

test('Other files are refused with a readable reason', () => {
  assert.throws(() => parseBackup('not json'), /isn't valid JSON/);
  assert.throws(() => parseBackup('{"marks":{}}'), /isn't a Subscroll backup/);
  assert.throws(() => parseBackup(JSON.stringify({ format: 'subscroll-backup', version: 99, state: {} })), /newer version/);
});

test('Unknown marks and broken fields are dropped', () => {
  const back = parseBackup(JSON.stringify({
    format: 'subscroll-backup',
    version: 1,
    state: { marks: { a: 'completed', b: 'loved', c: 5 }, subscriptions: 'nope', customGames: [1, { id: 'g' }] },
  }));
  assert.deepStrictEqual(back.state.marks, { a: 'completed' });
  assert.deepStrictEqual(back.state.subscriptions, {});
  assert.deepStrictEqual(back.state.customGames, [{ id: 'g' }]);
  assert.strictEqual('settings' in back.state, false);
});
