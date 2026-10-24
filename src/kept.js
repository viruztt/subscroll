// Your own copy of every game you've marked, rated, timed or written about:
// its name, cover, description, screenshots and the rest, saved in your data
// (state.keptGames, which backs up and syncs with everything else). A game
// that leaves every service keeps its card here, however long ago it left,
// whatever happened to the catalogue's own history (a new region starts a
// fresh list; the departed list only holds the latest 300 per service).
//
//   update(kept, ids, catalogs, details)  the copies after a refresh or a change
//   fromProduct(id, product)               a Game Pass card rebuilt from Microsoft's catalogue

const { storeUrl } = require('./providers/gamepass');

// What a list says about a game today, not about the game itself.
const VOLATILE = new Set(['leavingSoon', 'comingOn', 'noDetails', 'gone', 'firstSeen', 'joined', 'genreTags', 'steam', 'missing']);

function slim(g) {
  const out = {};
  for (const [k, v] of Object.entries(g)) {
    if (VOLATILE.has(k) || v == null || (Array.isArray(v) && !v.length)) continue;
    out[k] = v;
  }
  return out;
}

// details: looked-up descriptions and screenshots by game id (details.json),
// added to cards whose list doesn't carry them, so the copy has everything.
function cardFor(g, details = {}) {
  const card = slim(g);
  const d = details[g.id];
  if (d && !card.description && d.description) card.description = d.description;
  if (d && !card.screenshots && d.screenshots?.length) card.screenshots = d.screenshots;
  if (d && !card.descriptionSource && d.descriptionSource) card.descriptionSource = d.descriptionSource;
  return card;
}

// Returns { kept, changed, missing }: the new copies (a game still in a list
// gets a fresh copy; one found nowhere keeps the copy it had), whether they
// differ from before, and the ids found nowhere and never copied.
function update(kept = {}, ids = new Set(), catalogs = [], details = {}) {
  const index = new Map();
  for (const c of catalogs) for (const g of c.games || []) if (!index.has(g.id)) index.set(g.id, g);
  for (const c of catalogs) for (const g of c.history?.departed || []) if (!index.has(g.id)) index.set(g.id, g);
  const next = {};
  const missing = [];
  for (const id of [...ids].sort()) {
    const g = index.get(id);
    if (g) next[id] = cardFor(g, details);
    else if (kept[id]) next[id] = kept[id];
    else missing.push(id);
  }
  const before = Object.keys(kept);
  const changed = before.length !== Object.keys(next).length || before.some((id) => JSON.stringify(kept[id]) !== JSON.stringify(next[id]));
  return { kept: changed ? next : kept, changed, missing };
}

// A Game Pass game that left before it was ever copied: Microsoft's
// catalogue still has its store product (src/providers/gamepass.js parseProduct).
function fromProduct(id, p) {
  return slim({
    id,
    service: 'gamepass',
    title: p.title,
    image: p.image,
    platforms: [],
    tiers: [],
    genres: p.genres,
    developer: p.developer,
    publisher: p.publisher,
    releaseDate: p.releaseDate,
    description: p.description,
    screenshots: p.screenshots,
    storeUrl: storeUrl(id.slice('gamepass:'.length)),
    departed: true,
  });
}

module.exports = { update, fromProduct, slim };
