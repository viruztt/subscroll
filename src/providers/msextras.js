const gamepass = require('./gamepass');

// EA Play and Ubisoft+ on Xbox and the Microsoft Store. Microsoft's catalogue
// service names the product ids in each subscription's list, the same source
// as Game Pass, so these show the Xbox/PC (Microsoft Store) editions.
// List names are Microsoft's: "eaaccess" is EA Play; "nakuconsole" and
// "nakupc" are Ubisoft+ Classics; "ubisoftplus" is the full Ubisoft+.
const SOURCES = {
  eaplay: [
    { list: 'eaaccess', tier: 'eaplay', platform: 'console' },
  ],
  ubisoftplus: [
    { list: 'nakuconsole', tier: 'classics', platform: 'console' },
    { list: 'nakupc', tier: 'classics', platform: 'pc' },
    { list: 'ubisoftplus', tier: 'premium', platform: 'console' },
  ],
};

async function fetchService(service, { market = 'US', language = 'en-us' } = {}) {
  const lists = await gamepass.fetchSubscriptionLists(market);
  const members = new Map();
  for (const { list, tier, platform } of SOURCES[service]) {
    for (const id of Array.isArray(lists[list]) ? lists[list] : []) {
      if (!members.has(id)) members.set(id, { tiers: new Set(), platforms: new Set() });
      members.get(id).tiers.add(tier);
      members.get(id).platforms.add(platform);
    }
  }
  if (!members.size) {
    // Say which lists exist, so a renamed list is easy to spot.
    throw new Error(`no ${service} list in Microsoft's catalogue (lists: ${Object.keys(lists).join(', ')})`);
  }
  const details = await gamepass.fetchProducts([...members.keys()], { market, language });
  const games = [];
  for (const [id, m] of members) {
    const d = details.get(id);
    // Lists include add-ons and bundles that aren't games.
    if (!d || d.kind && d.kind !== 'Game') continue;
    games.push({
      id: `${service}:${id}`,
      service,
      title: d.title,
      image: d.image,
      platforms: [...m.platforms],
      tiers: [...m.tiers],
      leavingSoon: false,
      genres: d.genres,
      releaseDate: d.releaseDate,
      description: d.description,
      screenshots: d.screenshots,
      storeUrl: gamepass.storeUrl(id),
    });
  }
  return games;
}

module.exports = {
  SOURCES,
  fetchEaPlay: (settings) => fetchService('eaplay', settings),
  fetchUbisoftPlus: (settings) => fetchService('ubisoftplus', settings),
};
