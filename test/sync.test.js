const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Store } = require('../src/store');
const { Sync, merge, makeFile, stamp } = require('../src/sync');

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
function device(name, folder) {
  const store = new Store(tmp(`sync-${name}-`));
  const sync = new Sync(store, { name });
  store.update({ settings: { ...store.get().settings, syncFolder: folder } });
  return { store, sync };
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('Sync: each item changed gets its own time', () => {
  const prev = { marks: { a: 'played', b: 'wishlist' } };
  const next = { marks: { a: 'completed', c: 'played' } };
  const s = stamp(prev, next, ['marks'], { 'marks|b': 'old' }, 'T1');
  assert.deepStrictEqual(s, { 'marks|a': 'T1', 'marks|b': 'T1', 'marks|c': 'T1' });
  // Unchanged items keep their time.
  assert.deepStrictEqual(stamp(next, { marks: { ...next.marks } }, ['marks'], { 'marks|a': 'T0' }, 'T2'), { 'marks|a': 'T0' });
});

test('Sync: the newest change wins, item by item, and removals sync', () => {
  const mine = { marks: { a: 'played', b: 'completed', gone: 'wishlist' }, settings: { theme: 'dark', startWithWindows: true } };
  const stamps = { 'marks|a': '2026-10-20T10:00:00Z', 'marks|b': '2026-10-22T10:00:00Z', 'marks|gone': '2026-10-01T00:00:00Z', 'settings|theme': '2026-10-01T00:00:00Z' };
  const theirs = makeFile(
    { marks: { a: 'completed', b: 'dropped', c: 'playing' }, settings: { theme: 'light', startWithWindows: false } },
    { 'marks|a': '2026-10-21T10:00:00Z', 'marks|b': '2026-10-21T10:00:00Z', 'marks|c': '2026-10-21T10:00:00Z', 'marks|gone': '2026-10-21T10:00:00Z', 'settings|theme': '2026-10-21T10:00:00Z' },
    { id: 'laptop', name: 'Laptop' },
  );
  assert.deepStrictEqual(theirs.entries['marks|gone'], { removed: true, at: '2026-10-21T10:00:00Z' });
  const { patch } = merge(mine, stamps, [theirs], { device: 'pc' });
  // a: theirs is newer. b: mine is newer. c: new. gone: removed there later.
  assert.deepStrictEqual(patch.marks, { a: 'completed', b: 'completed', c: 'playing' });
  // Settings about one device stay on that device.
  assert.deepStrictEqual(patch.settings, { theme: 'light', startWithWindows: true });
});

test('Sync: keys stay out of the folder unless asked', () => {
  const state = { steam: { key: 'SECRET', id: '1' }, psn: { npsso: 'SECRET2' }, marks: {} };
  assert.ok(!JSON.stringify(makeFile(state, {}, { id: 'pc', name: 'PC' })).includes('SECRET'));
  assert.ok(JSON.stringify(makeFile(state, {}, { id: 'pc', name: 'PC' }, { accounts: true })).includes('SECRET'));
  // Nor are they taken from another device's file.
  const file = makeFile(state, {}, { id: 'laptop', name: 'Laptop' }, { accounts: true });
  assert.strictEqual(merge({ marks: {} }, {}, [file], { device: 'pc' }).patch, null);
});

test('Sync: a device joining takes the folder\'s version of things neither changed since', () => {
  const folderFile = makeFile({ marks: { a: 'completed' } }, {}, { id: 'aaa', name: 'PC' });
  // Same moment (both unknown): the joining device takes the folder's.
  assert.deepStrictEqual(merge({ marks: { a: 'played' } }, {}, [folderFile], { device: 'zzz', joining: true }).patch.marks, { a: 'completed' });
  // Once joined, ties go to the larger device id on every device.
  assert.strictEqual(merge({ marks: { a: 'played' } }, {}, [folderFile], { device: 'zzz' }).patch, null);
  assert.deepStrictEqual(merge({ marks: { a: 'played' } }, {}, [makeFile({ marks: { a: 'completed' } }, {}, { id: 'zzz' })], { device: 'aaa' }).patch.marks, { a: 'completed' });
});

test('Sync: two devices through one folder', async () => {
  const folder = tmp('sync-folder-');
  const pc = device('PC', folder);
  pc.store.update({ marks: { a: 'completed', b: 'wishlist' }, subscriptions: { gamepass: 'pc' } });
  pc.sync.pull();
  const laptop = device('Laptop', folder);
  laptop.store.update({ marks: { c: 'played' } });
  laptop.sync.pull();
  // The laptop gets the PC's things and keeps its own.
  assert.deepStrictEqual(laptop.store.get().marks, { a: 'completed', b: 'wishlist', c: 'played' });
  assert.deepStrictEqual(laptop.store.get().subscriptions, { gamepass: 'pc' });
  pc.sync.pull();
  assert.deepStrictEqual(pc.store.get().marks, { a: 'completed', b: 'wishlist', c: 'played' });
  assert.deepStrictEqual(pc.sync.status().devices.map((d) => d.name), ['Laptop']);

  // Changes on both: both survive, and a removal on one removes it on the other.
  await wait(5);
  const marks = { ...laptop.store.get().marks, a: 'dropped' };
  delete marks.b;
  laptop.store.update({ marks });
  laptop.sync.write();
  await wait(5);
  pc.store.update({ marks: { ...pc.store.get().marks, c: 'completed' }, notes: { a: { stars: 4 } } });
  pc.sync.write();
  laptop.sync.seen.clear();
  pc.sync.seen.clear();
  assert.strictEqual(pc.sync.pull(), 2);
  laptop.sync.pull();
  for (const d of [pc, laptop]) {
    assert.deepStrictEqual(d.store.get().marks, { a: 'dropped', c: 'completed' });
    assert.deepStrictEqual(d.store.get().notes, { a: { stars: 4 } });
  }
  // Nothing new: nothing changes, and no echo back and forth.
  pc.sync.seen.clear();
  assert.strictEqual(pc.sync.pull(), 0);
  // Only the two device files, no conflict copies.
  assert.deepStrictEqual(fs.readdirSync(folder).sort(), [`subscroll-${laptop.store.get().syncDevice}.sync.json`, `subscroll-${pc.store.get().syncDevice}.sync.json`].sort());
  for (const d of [pc, laptop]) d.sync.stop();
});
