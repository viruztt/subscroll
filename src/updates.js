// Is there a newer Subscroll? The app asks GitHub for the latest release of
// its own repository twice a day. src/selfupdate.js downloads and installs it
// where it can (the portable exe and the AppImage); elsewhere the window
// links to the download.
const { getJson } = require('./providers/http');

const REPO = 'viruztt/subscroll';
const API = `https://api.github.com/repos/${REPO}/releases/latest`;
const RELEASES = `https://github.com/${REPO}/releases`;
const CHECK_HOURS = 12;

// "v0.4.0" -> [0, 4, 0]; anything that isn't a version -> null.
function parseVersion(v) {
  const m = String(v || '').trim().match(/^v?(\d+)\.(\d+)(?:\.(\d+))?/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3] || 0)] : null;
}

// 1 when a is newer, -1 when older, 0 when the same (or either is unreadable).
function compareVersions(a, b) {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) return 0;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i] ? 1 : -1;
  return 0;
}

// The file for this computer: the .exe on Windows, the .AppImage on Linux.
function pickAsset(assets, platform) {
  const ext = platform === 'win32' ? /\.exe$/i : platform === 'linux' ? /\.appimage$/i : platform === 'darwin' ? /\.(dmg|zip)$/i : null;
  if (!ext || !Array.isArray(assets)) return null;
  const a = assets.find((x) => x && ext.test(x.name || '') && /^https:\/\//.test(x.browser_download_url || ''));
  if (!a) return null;
  const sha = String(a.digest || '').match(/^sha256:([0-9a-f]{64})$/i);
  return { name: a.name, url: a.browser_download_url, size: a.size || null, sha256: sha ? sha[1].toLowerCase() : null };
}

// GitHub's release -> what the app keeps.
function parseRelease(r, platform) {
  if (!r || r.draft || r.prerelease) return null;
  const version = String(r.tag_name || '').replace(/^v/i, '');
  if (!parseVersion(version)) return null;
  const page = /^https:\/\/github\.com\//.test(r.html_url || '') ? r.html_url : `${RELEASES}/tag/${encodeURIComponent(r.tag_name)}`;
  return {
    version,
    name: r.name || `Subscroll ${version}`,
    page,
    download: pickAsset(r.assets, platform),
    publishedAt: r.published_at || null,
  };
}

async function fetchLatest(platform = process.platform) {
  const r = await getJson(API, { timeoutMs: 20000, headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Subscroll' } });
  return parseRelease(r, platform);
}

const due = (checkedAt, now = Date.now()) => !checkedAt || now - new Date(checkedAt) > CHECK_HOURS * 3600000;

// What the window shows: the saved check plus whether it's newer than this
// copy, and the app's own install state (canInstall: this copy can replace
// itself; downloading: { version, got, total }; ready: a downloaded newer
// version waiting for a restart).
function status(saved, current, { canInstall = false, downloading = null } = {}) {
  const latest = saved && saved.latest;
  const ready = saved && saved.ready;
  return {
    current,
    checkedAt: (saved && saved.checkedAt) || null,
    error: (saved && saved.error) || null,
    downloadError: (saved && saved.downloadError) || null,
    latest: latest || null,
    newer: !!latest && compareVersions(latest.version, current) > 0,
    canInstall: canInstall && !!latest?.download?.sha256,
    downloading,
    ready: ready && compareVersions(ready.version, current) > 0 ? ready : null,
    releases: RELEASES,
  };
}

module.exports = { parseVersion, compareVersions, pickAsset, parseRelease, fetchLatest, due, status, CHECK_HOURS, RELEASES };
