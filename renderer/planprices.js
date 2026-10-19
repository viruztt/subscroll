// Each plan's list price, for the Value page's price picker. Services don't
// publish their prices in a form the app can read, so these are the prices
// on their own sites when checked (AS_OF); the picker says so, and every
// price can be changed. Amounts are what one payment costs, keyed by how
// many months it covers: { '1': 6.99, '12': 59.99 }.
(function (root) {
  const I18n = root.I18n || (typeof require === 'function' ? require('./i18n') : null);
  const { tk } = I18n;
  const AS_OF = '2026-10';
  const PRICES = {
    GBP: {
      gamepass: {"essential": {"1": 6.99}, "premium": {"1": 10.99}, "ultimate": {"1": 16.99}, "pc": {"1": 10.99}},
      psplus: {"essential": {"1": 7.99, "3": 21.99, "12": 59.99}, "extra": {"1": 11.99, "3": 34.99, "12": 99.99}, "premium": {"1": 14.99, "3": 43.99, "12": 119.99}},
      nso: {"base": {"1": 3.49, "3": 6.99, "12": 17.99}, "expansion": {"12": 34.99}, "base_family": {"12": 31.49}, "expansion_family": {"12": 59.99}},
      eaplay: {"eaplay": {"1": 5.99, "12": 35.99}, "pro": {"1": 16.99, "12": 109.99}},
      ubisoftplus: {"classics": {"1": 6.99, "12": 69.99}, "premium": {"1": 14.99, "12": 149.99}},
      netflix: {"ads": {"1": 7.99}, "standard": {"1": 13.99}, "premium": {"1": 20.99}},
      applearcade: {"any": {"1": 6.99, "12": 49.99}},
      crunchyroll: {"megafan": {"1": 6.99, "12": 69.99}},
      humble: {"choice": {"1": 11.49}},
      playpass: {"any": {"1": 4.99, "12": 29.99, unsure: true}},
      luna: {"premium": {"1": 8.99, unsure: true}, "prime": {"1": 8.99, "12": 95.0}},
      horizonplus: {"any": {"1": 7.99, "12": 59.99, unsure: true}},
      antstream: {"any": {"1": 3.99, "12": 29.99, unsure: true}},
    },
    USD: {
      gamepass: {"essential": {"1": 9.99}, "premium": {"1": 14.99}, "ultimate": {"1": 22.99}, "pc": {"1": 13.99}},
      psplus: {"essential": {"1": 10.99, "3": 27.99, "12": 79.99}, "extra": {"1": 16.99, "3": 43.99, "12": 134.99}, "premium": {"1": 19.99, "3": 54.99, "12": 159.99}},
      nso: {"base": {"1": 3.99, "3": 7.99, "12": 19.99}, "expansion": {"12": 49.99}, "base_family": {"12": 34.99}, "expansion_family": {"12": 79.99}},
      eaplay: {"eaplay": {"1": 5.99, "12": 39.99}, "pro": {"1": 16.99, "12": 119.99}},
      ubisoftplus: {"classics": {"1": 7.99, "12": 79.99}, "premium": {"1": 17.99, "12": 179.99}},
      netflix: {"ads": {"1": 8.99}, "standard": {"1": 19.99}, "premium": {"1": 26.99}},
      applearcade: {"any": {"1": 6.99, "12": 49.99}},
      crunchyroll: {"megafan": {"1": 13.99}, "ultimate": {"1": 17.99}},
      humble: {"choice": {"1": 14.99}},
      playpass: {"any": {"1": 4.99, "12": 29.99}},
      luna: {"premium": {"1": 9.99}, "prime": {"1": 14.99, "12": 139.0}},
      horizonplus: {"any": {"1": 7.99, "12": 59.99, unsure: true}},
      antstream: {"any": {"1": 4.99, "12": 39.99, unsure: true}},
    },
    EUR: {
      gamepass: {"essential": {"1": 8.99}, "premium": {"1": 12.99}, "ultimate": {"1": 20.99}, "pc": {"1": 12.99}},
      psplus: {"essential": {"1": 9.99, "3": 27.99, "12": 71.99}, "extra": {"1": 15.99, "3": 43.99, "12": 125.99}, "premium": {"1": 18.99, "3": 54.99, "12": 151.99}},
      nso: {"base": {"1": 3.99, "3": 7.99, "12": 19.99}, "expansion": {"12": 39.99}, "base_family": {"12": 34.99}, "expansion_family": {"12": 69.99}},
      eaplay: {"eaplay": {"1": 5.99, "12": 39.99}, "pro": {"1": 16.99, "12": 119.99}},
      ubisoftplus: {"classics": {"1": 7.99, "12": 79.99}, "premium": {"1": 17.99, "12": 179.99}},
      netflix: {"ads": {"1": 6.99}, "standard": {"1": 15.99}, "premium": {"1": 21.99}},
      applearcade: {"any": {"1": 6.99, "12": 49.99}},
      crunchyroll: {"megafan": {"1": 11.99, "12": 119.99}},
      humble: {"choice": {"1": 12.99}},
      playpass: {"any": {"1": 4.99, "12": 29.99, unsure: true}},
      luna: {"premium": {"1": 9.99}, "prime": {"1": 8.99, "12": 89.9}},
      horizonplus: {"any": {"1": 7.99, "12": 59.99, unsure: true}},
      antstream: {"any": {"1": 4.99, "12": 39.99, unsure: true}},
    },
  };

  // Names for tiers the app's plan list doesn't have (it only needs to know which games each unlocks).
  const TIER_NAMES = {
    'nso:base': tk('Standard'),
    'nso:expansion': tk('Expansion Pack'),
    'nso:base_family': tk('Family'),
    'nso:expansion_family': tk('Expansion Pack Family'),
    'eaplay:pro': 'EA Play Pro',
    'netflix:ads': tk('Standard with adverts'),
    'netflix:standard': tk('Standard'),
    'netflix:premium': tk('Premium'),
    'luna:prime': 'Prime (Luna Standard)',
  };
  // Which of the app's tiers (the games a plan unlocks) a priced plan gives.
  // Plans not listed here are the tier of the same name.
  const TIER_OF = {
    'nso:base_family': 'base',
    'nso:expansion_family': 'expansion',
    'eaplay:pro': 'eaplay',
    'netflix:ads': 'any',
    'netflix:standard': 'any',
    'netflix:premium': 'any',
    'luna:prime': 'standard',
  };
  const LENGTHS = { 1: 'a month', 3: '3 months', 12: 'a year' };

  // Picker options for one service in one currency, cheapest tier first:
  // [{ key: 'gamepass:ultimate:1', plan: 'ultimate', months: 1, amount, monthly, label }]
  function options(service, currency, { tierName = (t) => t } = {}) {
    const tiers = (PRICES[currency] || {})[service.id] || {};
    const out = [];
    for (const [tier, byLength] of Object.entries(tiers)) {
      // unsure: a price that couldn't be confirmed on the service's own site.
      const { unsure, ...lengths } = byLength;
      for (const [months, amount] of Object.entries(lengths)) {
        const n = Number(months);
        if (!(amount > 0) || !n) continue;
        const name = TIER_NAMES[`${service.id}:${tier}`] || tierName(tier);
        out.push({ key: `${service.id}:${tier}:${n}`, plan: tier, tier: TIER_OF[`${service.id}:${tier}`] || tier, months: n, amount, monthly: Math.round((amount / n) * 100) / 100, name, length: LENGTHS[n] || `${n} months`, ...(unsure ? { unsure: true } : {}) });
      }
    }
    // Tiers cheapest first, each from its shortest payment.
    const tierRank = {};
    for (const o of out) tierRank[o.plan] = Math.max(tierRank[o.plan] || 0, o.monthly);
    return out.sort((a, b) => tierRank[a.plan] - tierRank[b.plan] || a.months - b.months);
  }

  const api = { AS_OF, PRICES, options };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PlanPrices = api;
})(this);
