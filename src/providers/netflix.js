const { getJson } = require('./http');

// Netflix publishes its games as separate apps under its own developer
// account, so Apple's public App Store lookup for that account is the list.
// (Games published under a partner's account, and TV-only cloud games, are
// missing from it.)
const NETFLIX_ARTIST_ID = 363590054;

// "Red Dead Redemption NETFLIX" -> "Red Dead Redemption"
const cleanName = (name) => name.replace(/[\s:–—-]*\bNETFLIX\b\s*(Edition)?$/i, '').replace(/^NETFLIX\s+/i, '').trim();

const firstParagraph = (text) => {
  const p = (text || '').split(/\n\s*\n/).map((x) => x.replace(/\s+/g, ' ').trim()).find((x) => x.length > 40) || '';
  return p.length > 600 ? `${p.slice(0, 597).replace(/\s+\S*$/, '')}…` : p || null;
};

// The games a developer account publishes on the App Store, as catalogue
// games of `service`. Shared with Crunchyroll Game Vault.
function normalize(data, { service = 'netflix', clean = cleanName, tiers = ['any'] } = {}) {
  if (!data || !Array.isArray(data.results)) throw new Error('Unexpected App Store format');
  return data.results
    .filter((r) => r.wrapperType === 'software' && (r.primaryGenreName === 'Games' || (r.genres || []).includes('Games')))
    .map((r) => ({
      id: `${service}:${r.trackId}`,
      service,
      title: clean(r.trackName),
      image: r.artworkUrl512 || r.artworkUrl100 || null,
      platforms: ['Mobile'],
      tiers,
      leavingSoon: false,
      genres: (r.genres || []).filter((g) => g !== 'Games' && g !== 'Entertainment'),
      releaseDate: r.releaseDate ? r.releaseDate.slice(0, 10) : null,
      description: firstParagraph(r.description),
      screenshots: [...(r.screenshotUrls || []), ...(r.ipadScreenshotUrls || [])].slice(0, 4),
      storeUrl: r.trackViewUrl ? r.trackViewUrl.split('?')[0] : null,
    }));
}

async function fetchLive({ region = 'US', market = 'US' } = {}) {
  const country = (region || market || 'US').toLowerCase();
  const games = normalize(await getJson(`https://itunes.apple.com/lookup?id=${NETFLIX_ARTIST_ID}&entity=software&limit=200&country=${country}`));
  if (games.length < 10) throw new Error(`App Store list looks incomplete (${games.length} games)`);
  return games;
}

module.exports = { fetchLive, normalize, cleanName, firstParagraph };
