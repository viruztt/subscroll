const { key } = require('./ratings');

// Subscription games with a claim window:
//  - PlayStation Plus monthly games: added to your library while you have
//    PS Plus, from the first Tuesday of a month to the first Tuesday of the
//    next. This month's come from playstation.com's own list; next month's
//    from the PlayStation Blog post that announces them.
//  - Xbox Free Play Days: a few games to play free for a long weekend (most
//    need any Game Pass plan, some are open to everyone), from Xbox Wire's
//    weekly post.
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const pad = (n) => String(n).padStart(2, '0');

// ---- dates ----
// Hours behind UTC in US Pacific time: daylight time runs from the second
// Sunday of March to the first Sunday of November.
function ptOffset(y, m0, d) {
  const sunday = (month, n) => 1 + ((7 - new Date(Date.UTC(y, month, 1)).getUTCDay()) % 7) + (n - 1) * 7;
  const afterStart = m0 > 2 || (m0 === 2 && d >= sunday(2, 2));
  const beforeEnd = m0 < 10 || (m0 === 10 && d < sunday(10, 1));
  return afterStart && beforeEnd ? 7 : 8;
}

// A Pacific wall-clock time as ISO.
function pacific(y, m0, d, h = 0, min = 0) {
  const day = new Date(Date.UTC(y, m0, d));
  return new Date(Date.UTC(y, m0, d, h + ptOffset(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate()), min)).toISOString();
}

// The day in California at an ISO time, YYYY-MM-DD.
function ptDay(iso) {
  const t = Date.parse(iso);
  for (const off of [7, 8]) {
    const d = new Date(t - off * 3600000);
    if (ptOffset(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) === off) return d.toISOString().slice(0, 10);
  }
  return new Date(t - 8 * 3600000).toISOString().slice(0, 10);
}
const dayBefore = (iso) => new Date(Date.parse(`${iso.slice(0, 10)}T12:00:00Z`) - 86400000).toISOString().slice(0, 10);

function firstTuesday(y, m0) {
  return 1 + ((2 - new Date(Date.UTC(y, m0, 1)).getUTCDay() + 7) % 7);
}

// PS Plus monthly games swap on the first Tuesday, in the morning in California.
function monthWindow(y, m0) {
  const d = new Date(Date.UTC(y, m0, 1));
  const n = new Date(Date.UTC(y, m0 + 1, 1));
  const [Y, M] = [d.getUTCFullYear(), d.getUTCMonth()];
  const [NY, NM] = [n.getUTCFullYear(), n.getUTCMonth()];
  const start = pacific(Y, M, firstTuesday(Y, M), 9);
  const end = pacific(NY, NM, firstTuesday(NY, NM), 9);
  // On the calendar: from the first Tuesday to the Monday before the next.
  return { month: `${Y}-${pad(M + 1)}`, start, end, startDay: start.slice(0, 10), endDay: dayBefore(end) };
}

// The PS Plus month running at `now`, or `offset` months after it.
function psWindow(now = new Date(), offset = 0) {
  let w = monthWindow(now.getUTCFullYear(), now.getUTCMonth());
  if (new Date(w.start) > now) w = monthWindow(now.getUTCFullYear(), now.getUTCMonth() - 1);
  if (!offset) return w;
  const [y, m] = w.month.split('-').map(Number);
  return monthWindow(y, m - 1 + offset);
}

// ---- RSS ----
function entities(s) {
  return String(s || '')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&nbsp;/g, ' ').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}
const unwrap = (s) => {
  const c = s.match(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/);
  return c ? c[1] : entities(s);
};
const field = (item, name) => {
  const m = item.match(new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`));
  return m ? unwrap(m[1]) : '';
};
const text = (html) => entities(String(html || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').replace(/\s+([,.:;!?])/g, '$1').trim();

function rssItems(xml) {
  return [...String(xml || '').matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/g)].map(([, it]) => ({
    title: text(field(it, 'title')),
    link: text(field(it, 'link')),
    pubDate: new Date(text(field(it, 'pubDate'))),
    categories: [...it.matchAll(/<category\b[^>]*>([\s\S]*?)<\/category>/g)].map((m) => text(unwrap(m[1]))),
    html: field(it, 'content:encoded') || field(it, 'description'),
    image: (it.match(/<media:content\b[^>]*\burl="([^"]+)"/) || it.match(/<enclosure\b[^>]*\burl="([^"]+)"/) || [])[1] || null,
  })).filter((it) => !Number.isNaN(it.pubDate.getTime()));
}

// ---- PS Plus ----
// "EARTH DEFENSE FORCE: WORLD BROTHERS 2　PS4 & PS5" -> without the platforms
const cleanPsTitle = (t) => String(t || '').replace(/[\s　]+(?:PS4\s*(?:&|and)\s*PS5|PS5\s*(?:&|and)\s*PS4|PS4|PS5)\s*$/i, '').trim();

// playstation.com's list of this month's games.
function parsePsList(payload, { now = new Date() } = {}) {
  if (!Array.isArray(payload)) return [];
  const w = psWindow(now);
  const out = [];
  const seen = new Set();
  for (const g of payload.flatMap((group) => (Array.isArray(group.games) ? group.games : []))) {
    // A game's bonus pack shares its concept id; the game comes first.
    const id = g.conceptId || g.productId;
    if (!id || seen.has(String(id))) continue;
    seen.add(String(id));
    out.push({
      id: `psplus:${w.month}:${id}`,
      store: 'psplus',
      title: cleanPsTitle(g.nameEn || g.name),
      image: g.imageUrl || null,
      url: g.conceptUrl || null,
      start: w.start,
      end: w.end,
      startDay: w.startDay,
      endDay: w.endDay,
      upcoming: false,
      needs: 'psplus',
    });
  }
  return out;
}

// "F1 25, Hunt: Showdown 1896, and Earth Defense Force" -> three titles
function splitTitles(s) {
  return String(s || '').replace(/[,\s]+and more\.?$/i, '').split(/\s*,\s*(?:and\s+)?/).map((t) => t.trim().replace(/\.$/, '')).filter(Boolean);
}

const PS_POST = new RegExp(`PlayStation Plus Monthly Games for (${MONTHS.join('|')})\\b\\s*[:\\-–—]\\s*(.+)$`, 'i');

// The blog post announcing a month's games, usually the last Wednesday before.
function parsePsBlog(xml, { now = new Date() } = {}) {
  const out = [];
  const months = new Set();
  for (const it of rssItems(xml)) {
    const m = it.title.match(PS_POST);
    if (!m) continue;
    const m0 = MONTHS.indexOf(m[1].toLowerCase());
    // A December post announces January's games.
    const y = it.pubDate.getUTCFullYear() + (m0 < it.pubDate.getUTCMonth() - 6 ? 1 : 0);
    const w = monthWindow(y, m0);
    if (new Date(w.end) <= now || months.has(w.month)) continue;
    months.add(w.month);
    for (const title of splitTitles(m[2])) {
      out.push({
        id: `psblog:${w.month}:${key(title)}`,
        store: 'psplus',
        title,
        image: it.image,
        url: it.link || null,
        start: w.start,
        end: w.end,
        startDay: w.startDay,
        endDay: w.endDay,
        upcoming: new Date(w.start) > now,
        needs: 'psplus',
        month: w.month,
      });
    }
  }
  return out;
}

// ---- Free Play Days ----
const DATE = `(?:[a-z]+day\\s*,?\\s*)?(${MONTHS.join('|')})\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:\\s*(?:at\\s+)?(\\d{1,2})(?::(\\d\\d))?\\s*([ap])\\.?m\\.?)?`;
const START_RE = new RegExp(`\\b(?:from|beginning|starting|begins)\\s+${DATE}`, 'i');
const END_RE = new RegExp(`\\b(?:until|through|thru|ends)\\s+${DATE}`, 'i');

function findDate(t, re, pub, isEnd) {
  const m = t.match(re);
  if (!m) return null;
  const m0 = MONTHS.indexOf(m[1].toLowerCase());
  const y = pub.getUTCFullYear() + (m0 < pub.getUTCMonth() - 6 ? 1 : 0) - (m0 > pub.getUTCMonth() + 6 ? 1 : 0);
  let h = isEnd ? 23 : 0;
  let min = isEnd ? 59 : 1;
  if (m[3]) {
    h = Number(m[3]) % 12 + (m[5].toLowerCase() === 'p' ? 12 : 0);
    min = Number(m[4] || 0);
  }
  return pacific(y, m0, Number(m[2]), h, min);
}

// Free Play Days end on Sunday night in California.
function nextSundayEnd(pub) {
  const d = new Date(pub.getTime() - 8 * 3600000);
  const add = (7 - d.getUTCDay()) % 7;
  return pacific(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + add, 23, 59);
}

function windowFrom(t, pub, base) {
  const start = findDate(t, START_RE, pub, false);
  const end = findDate(t, END_RE, pub, true);
  const out = { start: start || (base && base.start) || pub.toISOString(), end: end || (base && base.end) || nextSundayEnd(pub) };
  // Anything else ("save 50% until…") isn't the free window.
  const days = (new Date(out.end) - new Date(out.start)) / 86400000;
  return days > 0 && days < 15 ? out : base || { start: pub.toISOString(), end: nextSundayEnd(pub) };
}

const STORE_LINK = /href="(?:https?:)?\/\/(?:www\.)?(?:xbox\.com\/[a-z-]+\/games\/store|microsoft\.com\/[a-z-]+\/(?:store\/(?:apps|p)|p))\/([^"/]+)\/([0-9a-z]{12})\b[^"]*"/gi;
const BUTTON_TEXT = /^(?:get it now|buy|buy now|download|pre-?install|play|learn more|see more)\b/i;

function fpdTitle(chunk, slug) {
  for (const m of chunk.matchAll(/<a\b[^>]*href="[^"]*\/[0-9a-z]{12}\b[^"]*"[^>]*>([\s\S]*?)<\/a>/gi)) {
    const t = text(m[1]);
    if (t && !BUTTON_TEXT.test(t) && t.length < 120) return t;
  }
  const h = chunk.match(/<h[2-4]\b[^>]*>([\s\S]*?)<\/h[2-4]>/i);
  if (h && text(h[1])) return text(h[1]).replace(/\s*\((?:xbox|windows|pc)[^)]*\)\s*$/i, '');
  return slug.split('-').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

function parseFreePlayDays(xml, { now = new Date() } = {}) {
  const out = [];
  const seen = new Set();
  for (const it of rssItems(xml)) {
    if (!/free play days/i.test(it.title) && !it.categories.some((c) => /free play days/i.test(c))) continue;
    const html = it.html || '';
    const heads = [...html.matchAll(/<h2\b[^>]*>([\s\S]*?)<\/h2>/gi)]
      .filter((m) => /free play days|for all|game pass/i.test(text(m[1])) && !/how to|keep the fun/i.test(text(m[1])));
    const firstHr = html.search(/<hr\b/i);
    const introEnd = Math.min(heads.length ? heads[0].index : html.length, firstHr >= 0 ? firstHr : html.length);
    const base = windowFrom(text(html.slice(0, introEnd)), it.pubDate, null);
    const groups = heads.length
      ? heads.map((h, i) => ({ all: /for all|everyone|no game pass/i.test(text(h[1])), html: html.slice(h.index, i + 1 < heads.length ? heads[i + 1].index : html.length) }))
      : [{ all: false, html: html.slice(introEnd) }];
    for (const g of groups) {
      for (const chunk of g.html.split(/<hr\b[^>]*>/i)) {
        const link = [...chunk.matchAll(STORE_LINK)][0];
        if (!link) continue;
        const productId = link[2].toUpperCase();
        if (seen.has(productId)) continue;
        const t = text(chunk);
        const own = windowFrom(t, it.pubDate, base);
        if (new Date(own.end) <= now) continue;
        seen.add(productId);
        const trial = /\b(?:timed|free)?\s*trial\b/i.test(t);
        out.push({
          id: `fpd:${own.start.slice(0, 10)}:${productId}`,
          store: 'fpd',
          kind: 'try',
          productId,
          title: fpdTitle(chunk, link[1]),
          image: (chunk.match(/<img\b[^>]*\bsrc="([^"]+)"/i) || [])[1] || null,
          url: `https://www.xbox.com/games/store/x/${productId}`,
          post: it.link || null,
          start: own.start,
          end: own.end,
          // Free Play Days run Thursday to Sunday, California time.
          startDay: ptDay(own.start),
          endDay: ptDay(own.end),
          upcoming: new Date(own.start) > now,
          needs: g.all || trial ? null : 'gamepass',
          trial,
        });
      }
    }
  }
  return out;
}

// Whether your plans include what a game needs (PC Game Pass has no Free Play Days).
function hasPlan(needs, subscriptions = {}) {
  if (!needs) return true;
  const tier = subscriptions[needs];
  return needs === 'gamepass' ? !!tier && tier !== 'pc' : !!tier;
}

module.exports = { psWindow, monthWindow, pacific, parsePsList, parsePsBlog, parseFreePlayDays, splitTitles, cleanPsTitle, rssItems, hasPlan };
