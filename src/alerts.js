// What to tell the user after a refresh: games that just joined a service
// in their plans, and games in their plans that started leaving. Games
// they've completed or ignored are left out.
const { unify } = require('../renderer/unify');

function pickAlerts({ games, newIds, keys, marks, alertedLeaving = [] }) {
  const isMine = (o) => (o.tiers || []).some((t) => keys.has(`${o.service}:${t}`));
  const seen = new Set(alertedLeaving);
  const added = [];
  const leaving = [];
  const leavingIds = [];
  for (const g of unify(games)) {
    const offers = (g.offers || [g]).filter(isMine);
    if (!offers.length) continue;
    const ids = (g.offers || [g]).map((o) => o.id);
    const mark = ids.map((id) => marks[id]).find(Boolean);
    if (mark === 'completed' || mark === 'ignored') continue;
    // Already somewhere in your plans means it isn't new to you.
    if (offers.every((o) => newIds.has(o.id))) added.push(g.title);
    const going = offers.filter((o) => o.leavingSoon).map((o) => o.id);
    if (going.length) {
      leavingIds.push(...going);
      if (!going.every((id) => seen.has(id))) leaving.push(g.title);
    }
  }
  return { added, leaving, leavingIds };
}

// "Hades, Celeste and 3 more"
function listTitles(titles, max = 3) {
  if (titles.length <= max) return titles.length > 1 ? `${titles.slice(0, -1).join(', ')} and ${titles[titles.length - 1]}` : titles.join('');
  return `${titles.slice(0, max).join(', ')} and ${titles.length - max} more`;
}

function messages({ added, leaving }) {
  const out = [];
  const games = (n) => `${n} game${n === 1 ? '' : 's'}`;
  if (added.length) out.push({ view: 'changes', title: `New in your plans: ${games(added.length)}`, body: listTitles(added) });
  if (leaving.length) out.push({ view: 'leaving', title: `Leaving your plans soon: ${games(leaving.length)}`, body: listTitles(leaving) });
  return out;
}

module.exports = { pickAlerts, messages, listTitles };
