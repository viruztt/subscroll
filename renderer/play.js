// The Play buttons in a game's details: launch or install it with Steam when
// you own it there, open it in the Xbox app when a PC Game Pass list has it,
// or open its PlayStation Store page.
//   g          a (merged) game with offers and, when owned on Steam, steam.appid
//   installed  true / false when Steam says whether it's installed, null when unknown
(function (root) {
  const XBOX = new Set(['gamepass', 'eaplay', 'ubisoftplus']);
  const productId = (id) => String(id || '').split(':').pop().toUpperCase();

  function playActions(g, { installed = null } = {}) {
    const offers = g.offers || [g];
    const out = [];
    if (g.steam && g.steam.appid) {
      const id = g.steam.appid;
      if (installed === true) out.push({ kind: 'steam', label: '▶ Play on Steam', url: `steam://run/${id}` });
      else if (installed === false) out.push({ kind: 'steam', label: 'Install with Steam', url: `steam://install/${id}` });
      else out.push({ kind: 'steam', label: 'Open in Steam', url: `steam://nav/games/details/${id}` });
    }
    const pc = offers.find((o) => XBOX.has(o.service) && (o.platforms || []).includes('pc') && /^[0-9A-Z]{12}$/.test(productId(o.id)));
    if (pc) out.push({ kind: 'xbox', label: 'Open in the Xbox app', url: `msxbox://game/?productId=${productId(pc.id)}` });
    const ps = offers.find((o) => o.service === 'psplus' && o.storeUrl);
    if (ps) out.push({ kind: 'ps', label: 'Open in PlayStation Store', url: ps.storeUrl });
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
