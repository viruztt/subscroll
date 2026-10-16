// Countries offered in the region picker, with the codes each store expects.
// Xbox titles are always requested in English; PlayStation uses the
// country's own store locale (the app shows each game's English name).
// Nintendo's library differs only between Japan and everywhere else.
// Prices on the Value page are in the country's currency (ISO 4217).
const CURRENCY = { US: 'USD', CA: 'CAD', MX: 'MXN', BR: 'BRL', GB: 'GBP', IE: 'EUR', DE: 'EUR', AT: 'EUR', CH: 'CHF', FR: 'EUR', BE: 'EUR', NL: 'EUR', ES: 'EUR', PT: 'EUR', IT: 'EUR', PL: 'PLN', CZ: 'CZK', SE: 'SEK', NO: 'NOK', DK: 'DKK', FI: 'EUR', AU: 'AUD', NZ: 'NZD', JP: 'JPY' };

const REGIONS = [
  ['US', 'United States', 'en-us', 'en-us'],
  ['CA', 'Canada', 'en-us', 'en-ca'],
  ['MX', 'Mexico', 'en-us', 'es-mx'],
  ['BR', 'Brazil', 'en-us', 'pt-br'],
  ['GB', 'United Kingdom', 'en-gb', 'en-gb'],
  ['IE', 'Ireland', 'en-gb', 'en-ie'],
  ['DE', 'Germany', 'en-gb', 'de-de'],
  ['AT', 'Austria', 'en-gb', 'de-at'],
  ['CH', 'Switzerland', 'en-gb', 'de-ch'],
  ['FR', 'France', 'en-gb', 'fr-fr'],
  ['BE', 'Belgium', 'en-gb', 'fr-be'],
  ['NL', 'Netherlands', 'en-gb', 'nl-nl'],
  ['ES', 'Spain', 'en-gb', 'es-es'],
  ['PT', 'Portugal', 'en-gb', 'pt-pt'],
  ['IT', 'Italy', 'en-gb', 'it-it'],
  ['PL', 'Poland', 'en-gb', 'pl-pl'],
  ['CZ', 'Czechia', 'en-gb', 'cs-cz'],
  ['SE', 'Sweden', 'en-gb', 'sv-se'],
  ['NO', 'Norway', 'en-gb', 'no-no'],
  ['DK', 'Denmark', 'en-gb', 'da-dk'],
  ['FI', 'Finland', 'en-gb', 'fi-fi'],
  ['AU', 'Australia', 'en-au', 'en-au'],
  ['NZ', 'New Zealand', 'en-au', 'en-nz'],
  ['JP', 'Japan', 'en-us', 'ja-jp'],
].map(([id, name, language, psLocale]) => ({ id, name, market: id, language, psLocale, currency: CURRENCY[id], nintendo: id === 'JP' ? 'jp' : 'west' }));

const regionById = (id) => REGIONS.find((r) => r.id === id) || null;

module.exports = { REGIONS, regionById };
