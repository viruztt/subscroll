const { getJson } = require('./http');
const { normalize } = require('./netflix');

// Crunchyroll Game Vault: mobile games included with the Mega Fan and
// Ultimate Fan memberships. Like Netflix, Crunchyroll publishes them as
// separate apps under its own App Store developer account, so Apple's
// public lookup for that account is the list.
const CRUNCHYROLL_ARTIST_ID = 329913457;

// "Crunchyroll: Phantom Breaker" -> "Phantom Breaker"
const cleanName = (name) => String(name || '')
  .replace(/^Crunchyroll\s*[:\-–—]\s*/i, '')
  .replace(/[\s:–—-]*\bCrunchyroll(?:\s+(?:Edition|Game Vault))?$/i, '')
  .trim();

function normalizeVault(data) {
  return normalize(data, { service: 'crunchyroll', clean: cleanName, tiers: ['megafan'] })
    // The anime app itself and companion apps aren't games.
    .filter((g) => g.title && !/^crunchyroll$/i.test(g.title));
}

async function fetchLive({ region = 'US', market = 'US' } = {}) {
  const country = (region || market || 'US').toLowerCase();
  const games = normalizeVault(await getJson(`https://itunes.apple.com/lookup?id=${CRUNCHYROLL_ARTIST_ID}&entity=software&limit=200&country=${country}`));
  if (games.length < 5) throw new Error(`App Store list looks incomplete (${games.length} games)`);
  return games;
}

module.exports = { fetchLive, normalizeVault, cleanName };
