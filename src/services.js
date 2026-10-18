// Built-in services and their tiers. A tier's `includes` lists every tier
// whose games it also gets, so "Ultimate" sees Premium and Essential games.
const SERVICES = [
  {
    id: 'gamepass',
    name: 'Xbox Game Pass',
    short: 'Game Pass',
    color: '#107c10',
    tiers: [
      { id: 'essential', name: 'Essential', includes: ['essential'] },
      { id: 'premium', name: 'Premium', includes: ['premium', 'essential'] },
      { id: 'pc', name: 'PC Game Pass', includes: ['pc', 'eaplay:eaplay'] },
      // Ultimate and PC Game Pass include EA Play; Ultimate also Ubisoft+ Classics.
      { id: 'ultimate', name: 'Ultimate', includes: ['ultimate', 'premium', 'essential', 'pc', 'eaplay:eaplay', 'ubisoftplus:classics'] },
    ],
  },
  {
    id: 'psplus',
    name: 'PlayStation Plus',
    short: 'PS Plus',
    color: '#0070d1',
    tiers: [
      { id: 'essential', name: 'Essential', includes: ['essential'] },
      { id: 'extra', name: 'Extra', includes: ['extra', 'essential'] },
      { id: 'premium', name: 'Premium', includes: ['premium', 'extra', 'essential'] },
    ],
  },
  {
    id: 'nso',
    name: 'Nintendo Switch Online',
    short: 'Switch Online',
    color: '#e60012',
    tiers: [
      { id: 'base', name: 'Standard', includes: ['base'] },
      { id: 'expansion', name: '+ Expansion Pack', includes: ['expansion', 'base'] },
    ],
  },
  {
    id: 'eaplay',
    name: 'EA Play',
    short: 'EA Play',
    color: '#f47c20',
    tiers: [{ id: 'eaplay', name: 'EA Play', includes: ['eaplay'] }],
  },
  {
    id: 'ubisoftplus',
    name: 'Ubisoft+',
    short: 'Ubisoft+',
    color: '#00a6c8',
    tiers: [
      { id: 'classics', name: 'Classics', includes: ['classics'] },
      { id: 'premium', name: 'Premium', includes: ['premium', 'classics'] },
    ],
  },
  {
    id: 'netflix',
    name: 'Netflix Games',
    short: 'Netflix',
    color: '#b20710',
    tiers: [{ id: 'any', name: 'Any Netflix plan', includes: ['any'] }],
  },
  {
    id: 'applearcade',
    name: 'Apple Arcade',
    short: 'Arcade',
    color: '#bf5af2',
    tiers: [{ id: 'any', name: 'Apple Arcade', includes: ['any'] }],
  },
  {
    id: 'crunchyroll',
    name: 'Crunchyroll Game Vault',
    short: 'Game Vault',
    color: '#f47521',
    tiers: [
      { id: 'megafan', name: 'Mega Fan', includes: ['megafan'] },
      { id: 'ultimate', name: 'Ultimate Fan', includes: ['megafan'] },
    ],
  },
  {
    id: 'humble',
    name: 'Humble Choice',
    short: 'Humble',
    color: '#cc2929',
    tiers: [{ id: 'choice', name: 'Humble Choice', includes: ['choice'] }],
  },
];

// Tier labels shown on game badges, which can differ from the plan name
// (a PS Plus "premium" game is a Classic; "essential" ones are monthly games).
const TIER_BADGES = {
  'psplus:essential': 'Monthly games',
  'psplus:extra': 'Game Catalog',
  'psplus:premium': 'Classics',
  'nso:base': 'NSO',
  'nso:expansion': 'Expansion Pack',
  'ubisoftplus:classics': 'Classics',
};

function allServices(customServices = []) {
  return [...SERVICES, ...customServices];
}

// Set of "service:tier" keys a user's subscriptions unlock.
function unlockedTiers(subscriptions, customServices = []) {
  const keys = new Set();
  for (const service of allServices(customServices)) {
    const tierId = subscriptions[service.id];
    if (!tierId) continue;
    const tier = service.tiers.find((t) => t.id === tierId);
    if (!tier) continue;
    // "service:tier" entries are another service's tier included in this plan.
    for (const inc of tier.includes) keys.add(inc.includes(':') ? inc : `${service.id}:${inc}`);
  }
  return keys;
}

module.exports = { SERVICES, TIER_BADGES, allServices, unlockedTiers };
