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
  // Macs get the .dmg for their chip.
  const mac = ['arm64', 'x64'].map((arch) => ({ name: `Subscroll-0.5.0-${arch}.dmg`, browser_download_url: `https://github.com/viruztt/subscroll/releases/download/v0.5.0/Subscroll-0.5.0-${arch}.dmg`, size: 90 }));
  const both = [...release.assets, ...mac];
  assert.strictEqual(updates.pickAsset(both, 'darwin', 'arm64').name, 'Subscroll-0.5.0-arm64.dmg');
  assert.strictEqual(updates.pickAsset(both, 'darwin', 'x64').name, 'Subscroll-0.5.0-x64.dmg');
  assert.strictEqual(updates.pickAsset(both, 'win32').name, 'Subscroll-0.5.0-abc1234.exe');
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

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const selfupdate = require('../src/selfupdate');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'subscroll-update-'));
const body = Buffer.from('new subscroll build '.repeat(5000));
const sha = crypto.createHash('sha256').update(body).digest('hex');
const serve = (buf) => async () => new Response(buf, { headers: { 'content-length': String(buf.length) } });

test('Updates: GitHub\'s checksum comes with the download, and installing needs it', () => {
  const withDigest = { ...release, assets: release.assets.map((a) => ({ ...a, digest: `sha256:${'A'.repeat(64)}` })) };
  const latest = updates.parseRelease(withDigest, 'win32');
  assert.strictEqual(latest.download.sha256, 'a'.repeat(64));
  assert.strictEqual(updates.status({ latest }, '0.4.0', { canInstall: true }).canInstall, true);
  // No checksum: the window links to the download instead.
  assert.strictEqual(updates.status({ latest: updates.parseRelease(release, 'win32') }, '0.4.0', { canInstall: true }).canInstall, false);
  // A download for a version this copy already is isn't waiting any more.
  assert.strictEqual(updates.status({ latest, ready: { version: '0.5.0' } }, '0.5.0').ready, null);
  assert.strictEqual(updates.status({ latest, ready: { version: '0.5.0' } }, '0.4.0').ready.version, '0.5.0');
});

test('Updates: only the portable exe and the AppImage replace themselves', () => {
  assert.strictEqual(selfupdate.currentFile({ packaged: false, platform: 'win32', env: { PORTABLE_EXECUTABLE_FILE: 'C:\\x.exe' } }), null);
  assert.strictEqual(selfupdate.currentFile({ packaged: true, platform: 'win32', env: { PORTABLE_EXECUTABLE_FILE: 'C:\\x.exe' } }), 'C:\\x.exe');
  assert.strictEqual(selfupdate.currentFile({ packaged: true, platform: 'linux', env: {} }), null);
  assert.strictEqual(selfupdate.currentFile({ packaged: true, platform: 'linux', env: { APPIMAGE: '/a/S.AppImage' } }), '/a/S.AppImage');
  assert.strictEqual(selfupdate.currentFile({ packaged: true, platform: 'darwin', env: {} }), null);
  assert.ok(selfupdate.VERSIONED.test('Subscroll-0.4.0-d519ede.exe'));
  assert.ok(selfupdate.VERSIONED.test('Subscroll-0.4.0.AppImage'));
  assert.ok(!selfupdate.VERSIONED.test('Subscroll.exe'));
});

test('Updates: the download is kept only when it matches the checksum', async () => {
  const dir = tmp();
  const file = path.join(dir, 'Subscroll-0.5.0-abc1234.AppImage');
  const seen = [];
  const r = await selfupdate.download({ url: 'https://github.com/x', size: body.length, sha256: sha }, file, { fetch: serve(body), platform: 'linux', onProgress: (got, total) => seen.push([got, total]) });
  assert.strictEqual(r.file, file);
  assert.ok(fs.readFileSync(file).equals(body));
  // Windows files have no executable bit to check.
  if (process.platform !== 'win32') assert.ok(fs.statSync(file).mode & 0o100, 'the AppImage can run');
  assert.deepStrictEqual(seen[seen.length - 1], [body.length, body.length]);
  assert.ok(!fs.existsSync(`${file}.part`));

  const bad = path.join(dir, 'bad.exe');
  await assert.rejects(selfupdate.download({ url: 'https://github.com/x', size: body.length, sha256: 'f'.repeat(64) }, bad, { fetch: serve(body), platform: 'win32' }), /checksum/);
  await assert.rejects(selfupdate.download({ url: 'https://github.com/x', size: body.length + 1, sha256: sha }, bad, { fetch: serve(body), platform: 'win32' }), /stopped early/);
  await assert.rejects(selfupdate.download({ url: 'https://github.com/x', size: 1 }, bad, { fetch: serve(body) }), /checksum/);
  await assert.rejects(selfupdate.download({ url: 'https://github.com/x', size: 1, sha256: sha }, bad, { fetch: async () => new Response('', { status: 404 }) }), /HTTP 404/);
  assert.deepStrictEqual(fs.readdirSync(dir).sort(), ['Subscroll-0.5.0-abc1234.AppImage']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('Updates: a release-named file is followed by the new one; a renamed file keeps its name', async () => {
  const dir = tmp();
  // Release name: the new file starts under its own name and the old one goes.
  const oldExe = path.join(dir, 'Subscroll-0.4.0-d519ede.exe');
  const ready = selfupdate.readyPath(oldExe, 'Subscroll-0.5.0-abc1234.exe');
  assert.strictEqual(ready, path.join(dir, 'Subscroll-0.5.0-abc1234.exe'));
  fs.writeFileSync(oldExe, 'old');
  fs.writeFileSync(ready, 'new');
  assert.deepStrictEqual(selfupdate.install(ready, oldExe), { launch: ready, old: oldExe });
  assert.strictEqual(await selfupdate.removeOld(oldExe, ready, { waitMs: 1 }), true);
  assert.ok(!fs.existsSync(oldExe));

  // Renamed: the running file moves aside and the new one takes its name.
  const mine = path.join(dir, 'Subscroll.exe');
  const next = selfupdate.readyPath(mine, 'Subscroll-0.6.0-def5678.exe');
  fs.writeFileSync(mine, 'old');
  fs.writeFileSync(next, 'newer');
  assert.deepStrictEqual(selfupdate.install(next, mine), { launch: mine, old: `${mine}.old` });
  assert.strictEqual(fs.readFileSync(mine, 'utf8'), 'newer');
  assert.ok(!fs.existsSync(next));
  // The new copy never deletes itself, and waits while the old file is busy.
  assert.strictEqual(await selfupdate.removeOld(mine, mine, { waitMs: 1 }), false);
  let tries = 0;
  const busy = (f, o) => { tries += 1; if (tries < 3) throw Object.assign(new Error('busy'), { code: 'EBUSY' }); fs.rmSync(f, o); };
  assert.strictEqual(await selfupdate.removeOld(`${mine}.old`, mine, { waitMs: 1, rm: busy }), true);
  assert.strictEqual(tries, 3);

  // If the running file can't be moved, the new one starts under its own name.
  const stuck = path.join(dir, 'Games.exe');
  const later = path.join(dir, 'Subscroll-0.7.0.exe');
  fs.writeFileSync(stuck, 'old');
  fs.writeFileSync(later, 'new');
  const refuse = (a) => { if (a === stuck) throw new Error('in use'); };
  assert.deepStrictEqual(selfupdate.install(later, stuck, { rename: refuse }), { launch: later, old: stuck });
  // Same name as the running file: download beside it.
  assert.strictEqual(selfupdate.readyPath(path.join(dir, 'Subscroll-0.5.0.exe'), 'Subscroll-0.5.0.exe'), path.join(dir, 'Subscroll-0.5.0.exe.new'));
  fs.rmSync(dir, { recursive: true, force: true });
});
