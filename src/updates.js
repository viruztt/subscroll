// Is there a newer Subscroll? The app asks GitHub for the latest release of
// its own repository twice a day and points you at the download. Nothing is
// downloaded or installed for you: the portable exe and the AppImage are
// single files you replace yourself.
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
  return a ? { name: a.name, url: a.browser_download_url, size: a.size || null } : null;
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

// What the window shows: the saved check plus whether it's newer than this copy.
function status(saved, current) {
  const latest = saved && saved.latest;
  return {
    current,
    checkedAt: (saved && saved.checkedAt) || null,
    error: (saved && saved.error) || null,
    latest: latest || null,
    newer: !!latest && compareVersions(latest.version, current) > 0,
    releases: RELEASES,
  };
}

module.exports = { parseVersion, compareVersions, pickAsset, parseRelease, fetchLatest, due, status, CHECK_HOURS, RELEASES };
