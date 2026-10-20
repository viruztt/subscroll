// The Play buttons in a game's details: launch or install it with Steam when
// you own it there, open it in the Xbox app when a PC Game Pass list has it,
// or open its PlayStation Store page.
//   g          a (merged) game with offers and, when owned on Steam, steam.appid
//   installed  true / false when Steam says whether it's installed, null when unknown
//   platform   process.platform; the Xbox app is Windows only
(function (root) {
  const I18n = root.I18n || (typeof require === 'function' ? require('./i18n') : null);
  const { t } = I18n;
  const XBOX = new Set(['gamepass', 'eaplay', 'ubisoftplus']);
  const productId = (id) => String(id || '').split(':').pop().toUpperCase();

  function playActions(g, { installed = null, platform = 'win32' } = {}) {
    const offers = g.offers || [g];
    const out = [];
    if (g.steam && g.steam.appid) {
      const id = g.steam.appid;
      if (installed === true) out.push({ kind: 'steam', label: t('▶ Play on Steam'), url: `steam://run/${id}` });
      else if (installed === false) out.push({ kind: 'steam', label: t('Install with Steam'), url: `steam://install/${id}` });
      else out.push({ kind: 'steam', label: t('Open in Steam'), url: `steam://nav/games/details/${id}` });
    }
    const pc = platform === 'win32' && offers.find((o) => XBOX.has(o.service) && (o.platforms || []).includes('pc') && /^[0-9A-Z]{12}$/.test(productId(o.id)));
    // A merged entry shown under its console edition keeps the PC edition's id in pcId.
    if (pc) out.push({ kind: 'xbox', label: t('Open in the Xbox app'), url: `msxbox://game/?productId=${productId(pc.pcId || pc.id)}` });
    const ps = offers.find((o) => o.service === 'psplus' && o.storeUrl);
    if (ps) out.push({ kind: 'ps', label: t('Open in PlayStation Store'), url: ps.storeUrl });
    if (out.length) out[0].primary = true;
    return out;
  }

  // What the main process lets the app open.
  const ALLOWED = [
    /^https:\/\//,
    /^steam:\/\/(?:run|install|nav\/games\/details)\/\d+$/,
    /^msxbox:\/\/game\/\?productId=[0-9A-Z]{12}$/,
  ];
  const allowed = (url) => typeof url === 'string' && ALLOWED.some((re) => re.test(url));

  const api = { playActions, allowed };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Play = api;
})(this);
