// Sale alerts: To play games that aren't in any of your plans, checked
// twice a day in their stores (src/prices.js). A game is announced once per
// sale price; a lower price later is news again.
const CHECK_HOURS = 12;
const MAX_WATCH = 200;

// The list the window sends: [{ id, title, offers: [{ id, service, storeUrl }] }]
function cleanWatch(list) {
  if (!Array.isArray(list)) return [];
  return list
    .filter((g) => g && typeof g.id === 'string' && typeof g.title === 'string')
    .slice(0, MAX_WATCH)
    .map((g) => ({
      id: g.id,
      title: g.title,
      offers: (Array.isArray(g.offers) ? g.offers : []).filter((o) => o && typeof o.id === 'string' && typeof o.service === 'string')
        .map((o) => ({ id: o.id, service: o.service, storeUrl: typeof o.storeUrl === 'string' ? o.storeUrl : null })),
    }));
}

// prices: id -> { amount, currency, sale, saleEnds }; alerted: id -> sale price already announced
function saleAlerts(watch, prices, alerted = {}, { currency = null } = {}) {
  const onSale = [];
  for (const g of watch) {
    const p = prices[g.id];
    if (!p || !(p.sale > 0) || !(p.amount > p.sale)) continue;
    if (currency && p.currency !== currency) continue;
    onSale.push({ id: g.id, title: g.title, sale: p.sale, amount: p.amount, currency: p.currency, saleEnds: p.saleEnds || null, off: Math.round((1 - p.sale / p.amount) * 100) });
  }
  const fresh = onSale.filter((s) => !(alerted[s.id] > 0) || s.sale < alerted[s.id]);
  // Games no longer on sale are forgotten, so their next sale is news.
  const next = Object.fromEntries(onSale.map((s) => [s.id, Math.min(s.sale, alerted[s.id] > 0 ? alerted[s.id] : Infinity)]));
  return { onSale, fresh, alerted: next };
}

module.exports = { cleanWatch, saleAlerts, CHECK_HOURS };
