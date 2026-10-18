const fs = require('fs');
const path = require('path');
const { getText } = require('./http');

// Amazon Luna: Amazon doesn't publish its list in a form an app can read.
// GameScriptions (gamescriptions.com) keeps a page per Luna tier, with the
// date each game was added, leaves or arrives:
//   luna_standard  games included with Prime
//   luna_premium   games in the paid Luna Premium
// Each game links to /game/<id>, with its cover, title and year, and labels
// such as "Added: Oct 6", "Leaves: Nov 3" or "Arrives: Nov 10". The page is
// read as HTML; when no games are found it's saved as luna-page.html next to
// the catalogue so the change can be looked at.
const PAGES = { standard: 'luna_standard', premium: 'luna_premium' };
const pageUrl = (slug) => `https://gamescriptions.com/subscription/service/${slug}`;
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

const entities = (s) => String(s || '')
  .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#x27;|&#39;|&apos;/g, "'")
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
  .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
const text = (html) => entities(String(html || '').replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();

// "Oct 6" -> ISO date, picking the year that fits: added dates are in the
// past, leave and arrival dates ahead (give or take a couple of weeks).
function dayOf(label, kind, now = new Date()) {
  const m = String(label || '').match(/([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2})(?:,?\s+(\d{4}))?/);
  if (!m) return null;
  const month = MONTHS.indexOf(m[1].toLowerCase());
  if (month < 0) return null;
  const at = (y) => new Date(Date.UTC(y, month, Number(m[2])));
  let d;
  if (m[3]) d = at(Number(m[3]));
  else {
    const y = now.getUTCFullYear();
    const slack = 14 * 86400000;
    const options = [y - 1, y, y + 1].map(at);
    d = kind === 'added'
      ? options.filter((x) => x - now <= slack).pop()
      : options.find((x) => x - now >= -slack);
  }
  return d ? d.toISOString().slice(0, 10) : null;
}

// The real image behind Next.js's resizer (/_next/image?url=...).
function imageOf(html) {
  const m = String(html || '').match(/<img\b[^>]*?\bsrc="([^"]+)"/i);
  if (!m) return null;
  const src = entities(m[1]);
  const inner = src.match(/[?&]url=([^&]+)/);
  const url = inner ? decodeURIComponent(inner[1]) : src;
  return /^https?:\/\//.test(url) ? url : null;
}

const altOf = (html) => {
  const m = String(html || '').match(/<img\b[^>]*?\balt="([^"]*)"/i);
  return m ? entities(m[1]).trim() : '';
};

// "Star Wars: Galactic Racer(2026) Added: Oct 6" -> "Star Wars: Galactic Racer"
const cleanTitle = (t) => String(t || '')
  .replace(/\s*(Added|Leaves|Arrives|Leaving|Cloud Only)\b.*$/i, '')
  .replace(/\s*\(\d{4}\)\s*$/, '')
  .replace(/\s+(cover|logo)$/i, '')
  .trim();

// Which section of the page a position falls in, from the headings.
function sections(html) {
  const out = [];
  for (const m of html.matchAll(/<h[1-6]\b[^>]*>([\s\S]*?)<\/h[1-6]>/gi)) {
    const t = text(m[1]).toLowerCase();
    const kind = /leaving/.test(t) ? 'leaving' : /coming/.test(t) ? 'coming' : /new/.test(t) ? 'new' : /available|all games/.test(t) ? 'available' : null;
    out.push({ at: m.index, kind });
  }
  return (pos) => {
    let kind = null;
    for (const s of out) if (s.at < pos) kind = s.kind;
    return kind;
  };
}

function parseLuna(html, { tier = 'standard', now = new Date() } = {}) {
  html = String(html || '');
  const sectionAt = sections(html);
  const links = [...html.matchAll(/<a\b[^>]*?href="(?:https:\/\/gamescriptions\.com)?\/game\/(\d+)[^"]*"[^>]*>/gi)];
  const games = new Map();
  for (let i = 0; i < links.length; i++) {
    const id = links[i][1];
    // A game's card runs until the next link to a different game.
    let j = i + 1;
    while (j < links.length && links[j][1] === id) j++;
    const end = j < links.length ? links[j].index : Math.min(html.length, links[i].index + 6000);
    const card = html.slice(links[i].index, end);
    i = j - 1;
    const words = text(card);
    const title = cleanTitle(altOf(card)) || cleanTitle(words);
    if (!title || title.length > 150) continue;
    const label = (re) => (words.match(re) || [])[1];
    const g = games.get(id) || {
      id: `luna:${id}`,
      service: 'luna',
      title,
      image: null,
      platforms: ['Cloud'],
      tiers: [tier],
      leavingSoon: false,
      addedOn: null,
      comingOn: null,
      leavesOn: null,
      releaseYear: null,
      storeUrl: `https://gamescriptions.com/game/${id}`,
    };
    g.image = g.image || imageOf(card);
    const year = words.match(/\((\d{4})\)/);
    if (year) g.releaseYear = Number(year[1]);
    const added = label(/Added:?\s*([A-Za-z]{3,9}\.? \d{1,2}(?:,? \d{4})?)/i);
    const leaves = label(/Leav(?:es|ing):?\s*([A-Za-z]{3,9}\.? \d{1,2}(?:,? \d{4})?)/i);
    const arrives = label(/Arriv(?:es|ing):?\s*([A-Za-z]{3,9}\.? \d{1,2}(?:,? \d{4})?)/i);
    if (added) g.addedOn = dayOf(added, 'added', now);
    if (leaves) g.leavesOn = dayOf(leaves, 'leaves', now);
    if (arrives) g.comingOn = dayOf(arrives, 'arrives', now);
    const section = sectionAt(links[i].index);
    if (section === 'leaving' || g.leavesOn) g.leavingSoon = true;
    games.set(id, g);
  }
  return [...games.values()];
}

async function fetchTier(tier, dir) {
  const html = await getText(pageUrl(PAGES[tier]), { timeoutMs: 30000, headers: { Accept: 'text/html' } });
  const games = parseLuna(html, { tier });
  if (games.length < 10) {
    if (dir) {
      try {
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, `luna-${tier}-page.html`), html);
      } catch {
        // Debugging aid only.
      }
    }
    throw new Error(`Couldn't read the Luna ${tier === 'standard' ? 'Standard' : 'Premium'} list (${games.length} games found)`);
  }
  return games;
}

// Both tiers; a game in both is one entry with both tiers.
async function fetchLive(_settings, dir) {
  const [standard, premium] = await Promise.all([fetchTier('standard', dir), fetchTier('premium', dir)]);
  const byId = new Map(standard.map((g) => [g.id, g]));
  for (const g of premium) {
    const prev = byId.get(g.id);
    if (!prev) byId.set(g.id, g);
    else byId.set(g.id, { ...prev, tiers: [...new Set([...prev.tiers, ...g.tiers])], leavingSoon: prev.leavingSoon || g.leavingSoon, leavesOn: prev.leavesOn || g.leavesOn });
  }
  return [...byId.values()];
}

module.exports = { fetchLive, parseLuna, dayOf, imageOf, cleanTitle, pageUrl };
