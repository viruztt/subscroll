const test = require('node:test');
const assert = require('node:assert');
const updates = require('../src/updates');
const http = require('../src/providers/http');

const release = {
  tag_name: 'v0.5.0',
  name: 'Subscroll 0.5.0',
  html_url: 'https://github.com/viruztt/subscroll/releases/tag/v0.5.0',
  published_at: '2026-11-01T10:00:00Z',
  draft: false,
  prerelease: false,
  assets: [
    { name: 'Subscroll-0.5.0-abc1234.AppImage', browser_download_url: 'https://github.com/viruztt/subscroll/releases/download/v0.5.0/Subscroll-0.5.0-abc1234.AppImage', size: 120 },
    { name: 'Subscroll-0.5.0-abc1234.exe', browser_download_url: 'https://github.com/viruztt/subscroll/releases/download/v0.5.0/Subscroll-0.5.0-abc1234.exe', size: 100 },
  ],
};

test('Updates: versions compare by number, not text', () => {
  assert.strictEqual(updates.compareVersions('0.10.0', '0.9.3'), 1);
  assert.strictEqual(updates.compareVersions('v0.4.0', '0.4.0'), 0);
  assert.strictEqual(updates.compareVersions('0.4', '0.4.1'), -1);
  assert.strictEqual(updates.compareVersions('nightly', '0.4.0'), 0);
});

test('Updates: the download for this computer', () => {
  assert.match(updates.parseRelease(release, 'win32').download.url, /\.exe$/);
  assert.match(updates.parseRelease(release, 'linux').download.url, /\.AppImage$/);
  assert.strictEqual(updates.parseRelease(release, 'darwin').download, null);
  // An older release without a Linux file still points at its page.
  const old = updates.parseRelease({ ...release, assets: [release.assets[1]] }, 'linux');
  assert.strictEqual(old.download, null);
  assert.strictEqual(old.page, release.html_url);
  assert.strictEqual(updates.parseRelease({ ...release, draft: true }, 'win32'), null);
});

test('Updates: newer only when the release is ahead of this copy', async () => {
  let asked;
  http.setFetch(async (url, opts) => { asked = { url, opts }; return { ok: true, json: async () => release }; });
  const latest = await updates.fetchLatest('win32');
  assert.strictEqual(asked.url, 'https://api.github.com/repos/viruztt/subscroll/releases/latest');
  assert.ok(asked.opts.headers['User-Agent']);
  const saved = { latest, checkedAt: '2026-11-01T12:00:00Z' };
  assert.strictEqual(updates.status(saved, '0.4.0').newer, true);
  assert.strictEqual(updates.status(saved, '0.5.0').newer, false);
  assert.strictEqual(updates.status(null, '0.4.0').newer, false);
  assert.strictEqual(updates.due('2026-11-01T12:00:00Z', new Date('2026-11-01T20:00:00Z').getTime()), false);
  assert.strictEqual(updates.due('2026-11-01T12:00:00Z', new Date('2026-11-02T01:00:00Z').getTime()), true);
  assert.strictEqual(updates.due(null), true);
  http.setFetch((...a) => globalThis.fetch(...a));
});
