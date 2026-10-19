// What to tell the user after a refresh: games that just joined a service
// in their plans, and games in their plans that started leaving. Games
// they've completed or ignored are left out.
const { unify, matchKey } = require('../renderer/unify');
const { t, tn } = require('../renderer/i18n');

const { offerOpen } = require('./services');

const mineIn = (keys) => (o) => offerOpen(keys, o);
const coming = (o, today) => !!o.comingOn && o.comingOn > today;

// Games on the To play list, split into ones you can play now in your plans
// and ones still waiting (coming soon, or only in services you don't have).
function wishlist(games, { keys, marks, today }) {
  const isMine = mineIn(keys);
  const ready = new Map();
  const waiting = new Map();
  for (const g of unify(games)) {
    const offers = g.offers || [g];
    if (!offers.some((o) => marks[o.id] === 'wishlist')) continue;
    const now = offers.some((o) => isMine(o) && !coming(o, today));
    (now ? ready : waiting).set(matchKey(g.title) || g.id, g.title);
  }
  return { ready, waiting };
}

// To-play games that were waiting before the refresh and are playable now.
function arrived(waitingBefore, after) {
  return [...waitingBefore.keys()].filter((k) => after.ready.has(k)).map((k) => after.ready.get(k));
}

function pickAlerts({ games, newIds, keys, marks, alertedLeaving = [] }) {
  const isMine = mineIn(keys);
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
  if (titles.length <= max) return titles.length > 1 ? t('{list} and {last}', { list: titles.slice(0, -1).join(', '), last: titles[titles.length - 1] }) : titles.join('');
  return tn(titles.length - max, '{list} and {n} more', '{list} and {n} more', { list: titles.slice(0, max).join(', ') });
}

function messages({ added, leaving, ready = [] }) {
  const out = [];
  if (ready.length) out.push({ view: 'toplay', title: tn(ready.length, 'Ready to play from your list: {n} game', 'Ready to play from your list: {n} games'), body: listTitles(ready) });
  // A game on your list that just arrived is announced once, as ready.
  added = added.filter((t) => !ready.includes(t));
  if (added.length) out.push({ view: 'changes', title: tn(added.length, 'New in your plans: {n} game', 'New in your plans: {n} games'), body: listTitles(added) });
  if (leaving.length) out.push({ view: 'leaving', title: tn(leaving.length, 'Leaving your plans soon: {n} game', 'Leaving your plans soon: {n} games'), body: listTitles(leaving) });
  return out;
}

module.exports = { pickAlerts, messages, listTitles, wishlist, arrived };
