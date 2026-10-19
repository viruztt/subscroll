// Countries. You can pick any country; each store-based list then uses your
// country's store where the service is sold there, and your fallback country's
// store where it isn't (Lithuania has PC Game Pass but no PlayStation Store,
// for example, so PS Plus comes from the store you pick as the fallback).
// Country names come from the system in the app's language.
// Sources, checked October 2026: xbox.com/regions and Xbox Wire's PC Game Pass
// launches (2022, 2023); the PlayStation country and locale list on
// psdevwiki.com (PS4 Regioning), which matches Sony's country selector.
(function (root) {
  // Every inhabited country and territory (ISO 3166-1).
  const COUNTRIES = ('AD AE AF AG AI AL AM AO AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GT GU GW GY HK HN HR HT HU ID IE IL IM IN IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW').split(' ');

  // Game Pass on console (and so Ultimate), then the countries that only have PC Game Pass.
  const XBOX_CONSOLE = 'AR AU AT BE BR CA CL CO CZ DK FI FR DE GR HK HU IN IE IL IT JP KR MX NL NZ NO PL PT SA SG SK ZA ES SE CH TW TR AE GB US'.split(' ');
  const XBOX_PC_ONLY = 'ID MY PH TH VN AL DZ BH BO BA BG CR HR CY EC EG SV EE GE GT HN IS KW LV LY LI LT LU MT MD ME MA NI MK OM PA PY PE QA RO RS SI TN UA UY'.split(' ');

  // PlayStation Store countries and the playstation.com locale each one uses.
  const PS = {
    GB: 'en-gb', IE: 'en-ie', FR: 'fr-fr', DE: 'de-de', AT: 'de-at', CH: 'de-ch', NL: 'nl-nl', BE: 'fr-be', LU: 'fr-lu',
    ES: 'es-es', PT: 'pt-pt', IT: 'it-it', MT: 'en-mt', CY: 'en-cy', GR: 'el-gr', BG: 'bg-bg', HR: 'hr-hr',
    CZ: 'cs-cz', SK: 'sk-sk', SI: 'sl-si', HU: 'hu-hu', RO: 'ro-ro', PL: 'pl-pl', RS: 'sr-rs',
    DK: 'da-dk', FI: 'fi-fi', NO: 'no-no', SE: 'sv-se', IS: 'en-is', UA: 'uk-ua', TR: 'tr-tr',
    IL: 'he-il', SA: 'en-sa', AE: 'en-ae', KW: 'en-kw', QA: 'en-qa', BH: 'en-bh', OM: 'en-om', LB: 'en-lb',
    ZA: 'en-za', IN: 'en-in', AU: 'en-au', NZ: 'en-nz', JP: 'ja-jp',
    US: 'en-us', CA: 'en-ca', MX: 'es-mx', BR: 'pt-br', AR: 'es-ar', CL: 'es-cl', CO: 'es-co', PE: 'es-pe', BO: 'es-bo', UY: 'es-uy',
    PY: 'es-py', PA: 'es-pa', CR: 'es-cr', EC: 'es-ec', SV: 'es-sv', GT: 'es-gt', HN: 'es-hn', NI: 'es-ni',
    HK: 'en-hk', TW: 'zh-hant-tw', KR: 'ko-kr', SG: 'en-sg', MY: 'en-my', ID: 'en-id', TH: 'th-th', VN: 'en-vn', PH: 'en-ph',
  };

  const CURRENCY = {
    AR: 'ARS', AU: 'AUD', AT: 'EUR', BE: 'EUR', BR: 'BRL', CA: 'CAD', CL: 'CLP', CO: 'COP', CZ: 'CZK', DK: 'DKK', FI: 'EUR', FR: 'EUR', DE: 'EUR', GR: 'EUR',
    HK: 'HKD', HU: 'HUF', IN: 'INR', IE: 'EUR', IL: 'ILS', IT: 'EUR', JP: 'JPY', KR: 'KRW', MX: 'MXN', NL: 'EUR', NZ: 'NZD', NO: 'NOK', PL: 'PLN', PT: 'EUR',
    SA: 'SAR', SG: 'SGD', SK: 'EUR', ZA: 'ZAR', ES: 'EUR', SE: 'SEK', CH: 'CHF', TW: 'TWD', TR: 'TRY', AE: 'AED', GB: 'GBP', US: 'USD',
    ID: 'IDR', MY: 'MYR', PH: 'PHP', TH: 'THB', VN: 'VND', AL: 'ALL', DZ: 'DZD', BH: 'BHD', BO: 'BOB', BA: 'BAM', BG: 'EUR',
    CR: 'CRC', HR: 'EUR', CY: 'EUR', EC: 'USD', EG: 'EGP', SV: 'USD', EE: 'EUR', GE: 'GEL', GT: 'GTQ', HN: 'HNL', IS: 'ISK', KW: 'KWD', LV: 'EUR', LY: 'LYD',
    LI: 'CHF', LT: 'EUR', LU: 'EUR', MT: 'EUR', MD: 'MDL', ME: 'EUR', MA: 'MAD', NI: 'NIO', MK: 'MKD', OM: 'OMR', PA: 'USD', PY: 'PYG',
    PE: 'PEN', QA: 'QAR', RO: 'RON', RS: 'RSD', SI: 'EUR', TN: 'TND', UA: 'UAH', UY: 'UYU', LB: 'LBP',
    MC: 'EUR', SM: 'EUR', VA: 'EUR', AD: 'EUR', XK: 'EUR', PR: 'USD',
  };

  // Europe, the Middle East and Africa use the UK's English for Xbox titles and default to the UK as fallback.
  const EMEA = new Set('AD AE AL AM AO AT AX AZ BA BE BF BG BH BI BJ BW BY CD CF CG CH CI CM CV CY CZ DE DJ DK DZ EE EG EH ER ES ET FI FO FR GA GB GE GG GH GI GL GM GN GQ GR GW HR HU IE IL IM IQ IR IS IT JE JO KE KM KW KZ LB LI LR LS LT LU LV LY MA MC MD ME MG MK ML MR MT MU MW MZ NA NE NG NL NO OM PL PS PT QA RE RO RS RU RW SA SC SD SE SH SI SJ SK SL SM SN SO SS ST SY SZ TD TG TN TR TZ UA UG VA YE YT ZA ZM ZW'.split(' '));

  const hasXbox = (id) => XBOX_CONSOLE.includes(id) || XBOX_PC_ONLY.includes(id);
  const hasPlayStation = (id) => !!PS[id];
  // Fallbacks: countries with both stores, so one pick covers everything.
  const FALLBACKS = XBOX_CONSOLE.filter((id) => PS[id]);
  const isCountry = (id) => COUNTRIES.includes(id);
  const defaultFallback = (id) => (id === 'JP' || id === 'KR' ? id : EMEA.has(id) ? 'GB' : ['AU', 'NZ'].includes(id) ? 'AU' : 'US');
  const xboxLanguage = (id) => (['AU', 'NZ'].includes(id) ? 'en-au' : EMEA.has(id) ? 'en-gb' : 'en-us');

  // Every store code for a country and fallback.
  function resolve(region, fallback) {
    const id = isCountry(String(region || '').toUpperCase()) ? String(region).toUpperCase() : 'US';
    const back = FALLBACKS.includes(fallback) ? fallback : defaultFallback(id);
    const xbox = hasXbox(id) ? id : back;
    const ps = hasPlayStation(id) ? id : back;
    return {
      region: id,
      fallbackRegion: back,
      market: xbox,
      language: xboxLanguage(xbox),
      psLocale: PS[ps],
      currency: CURRENCY[id] || CURRENCY[back],
      nintendo: id === 'JP' ? 'jp' : 'west',
      // Which stores your country lacks, so the fallback is used for them.
      missing: [!hasXbox(id) && 'xbox', !hasPlayStation(id) && 'playstation'].filter(Boolean),
    };
  }

  // Country names in the given language, sorted the way that language sorts.
  function names(ids, locale) {
    let dn = null;
    try {
      dn = new Intl.DisplayNames([locale, 'en'], { type: 'region' });
    } catch { /* codes only */ }
    return ids.map((id) => ({ id, name: (dn && dn.of(id)) || id })).sort((a, b) => a.name.localeCompare(b.name, locale));
  }

  const api = { COUNTRIES, FALLBACKS, XBOX_CONSOLE, XBOX_PC_ONLY, PS, CURRENCY, hasXbox, hasPlayStation, resolve, names, defaultFallback, isCountry };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Regions = api;
})(this);
