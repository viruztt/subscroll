// Installing a new version by itself. Subscroll is one file (the portable exe
// on Windows, the AppImage on Linux), so updating means downloading the new
// file next to it, checking it against GitHub's checksum, and starting it in
// place of this one; the new copy then deletes the old file.
//
// A file named like a release (Subscroll-0.4.0-d519ede.exe) is followed by
// the new release's file name. A file you renamed (Subscroll.exe) keeps its
// name, so shortcuts and taskbar pins keep working: the running file is moved
// aside to "<name>.old" and the new one takes its place.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { fetchRaw } = require('./providers/http');

const VERSIONED = /^Subscroll-\d+\.\d+\.\d+(?:-[0-9a-f]{4,40})?\.(?:exe|appimage)$/i;

// The file this copy runs from, or null when it can't replace itself
// (started with npm start, macOS, or not the portable exe or AppImage).
function currentFile({ packaged, platform = process.platform, env = process.env } = {}) {
  if (!packaged) return null;
  if (platform === 'win32') return env.PORTABLE_EXECUTABLE_FILE || null;
  if (platform === 'linux') return env.APPIMAGE || null;
  return null;
}

// Where the downloaded file goes: next to this one, under the release's name.
function readyPath(current, assetName) {
  const dir = path.dirname(current);
  const name = path.basename(assetName);
  const file = path.join(dir, name);
  return path.resolve(file) === path.resolve(current) ? `${file}.new` : file;
}

// Downloads asset ({ url, size, sha256 }) to file, through "<file>.part", and
// keeps it only when its size and SHA-256 match what GitHub published.
async function download(asset, file, { onProgress, platform = process.platform, fetch = fetchRaw } = {}) {
  if (!asset || !/^https:\/\//.test(asset.url || '')) throw new Error('No download for this computer');
  if (!/^[0-9a-f]{64}$/.test(asset.sha256 || '')) throw new Error('GitHub gave no checksum for this file');
  const part = `${file}.part`;
  const res = await fetch(asset.url, { headers: { Accept: 'application/octet-stream', 'User-Agent': 'Subscroll' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(asset.url).host}`);
  const total = Number(res.headers?.get?.('content-length')) || asset.size || 0;
  const hash = crypto.createHash('sha256');
  const out = fs.createWriteStream(part);
  let got = 0;
  try {
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      hash.update(chunk);
      got += chunk.length;
      if (!out.write(chunk)) await new Promise((ok) => out.once('drain', ok));
      onProgress?.(got, total);
    }
    await new Promise((ok, bad) => out.end((e) => (e ? bad(e) : ok())));
    if (asset.size && got !== asset.size) throw new Error(`The download stopped early (${got} of ${asset.size} bytes)`);
    if (hash.digest('hex') !== asset.sha256) throw new Error('The download doesn\'t match GitHub\'s checksum');
  } catch (e) {
    out.destroy();
    fs.rmSync(part, { force: true });
    throw e;
  }
  fs.renameSync(part, file);
  if (platform !== 'win32') fs.chmodSync(file, 0o755);
  return { file, sha256: asset.sha256 };
}

// Puts the downloaded file in place. Returns which file to start and which
// old one the new copy should delete once this one has quit.
function install(ready, current, { rename = fs.renameSync } = {}) {
  const side = { launch: ready, old: current };
  if (VERSIONED.test(path.basename(current))) return side;
  const aside = `${current}.old`;
  try {
    fs.rmSync(aside, { force: true });
    rename(current, aside);
  } catch {
    return side;
  }
  try {
    rename(ready, current);
  } catch {
    try { rename(aside, current); } catch { /* leave it; the new copy still starts */ }
    return side;
  }
  return { launch: current, old: aside };
}

// The new copy deletes the old file, waiting for the old copy to finish quitting.
async function removeOld(file, self, { tries = 30, waitMs = 2000, rm = fs.rmSync } = {}) {
  if (!file || (self && path.resolve(file) === path.resolve(self))) return false;
  for (let i = 0; i < tries; i++) {
    try {
      rm(file, { force: true });
      return true;
    } catch {
      await new Promise((ok) => setTimeout(ok, waitMs));
    }
  }
  return false;
}

module.exports = { VERSIONED, currentFile, readyPath, download, install, removeOld };
