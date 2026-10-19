const { getJson } = require('./http');
const { tableGrid, cellText, toIsoDate } = require('./nintendo');

// Antstream Arcade streams retro games on PC, Xbox and phones. Antstream
// publishes no list, so, as with Switch Online, Wikipedia's "Antstream"
// article is the live source: a table per original system, with each game's
// title, publisher, original release year and the date it joined Antstream.
const WIKI_URL = 'https://en.wikipedia.org/w/api.php?action=parse&page=Antstream' +
  '&prop=text&format=json&formatversion=2&redirects=1';
const WIKI_PAGE = 'https://en.wikipedia.org/wiki/Antstream';
// Windows, Xbox consoles ('console', as Game Pass writes it) and phones.
const PLATFORMS = ['PC', 'console', 'Mobile'];

const slug = (s) => String(s).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

// "August 2024" or "April 13, 2023" -> ISO date (the 1st when there's no day).
function addedDate(text) {
  const s = String(text || '').trim();
  if (/^[A-Za-z]+ \d{4}$/.test(s)) return toIsoDate(`1 ${s}`);
  return toIsoDate(s);
}

function parseWikipedia(html, today = new Date().toISOString().slice(0, 10)) {
  const games = [];
  const seen = new Set();
  const tableRe = /<table[^>]*class="[^"]*wikitable[^"]*"[^>]*>([\s\S]*?)<\/table>/gi;
  for (const m of String(html || '').matchAll(tableRe)) {
    const caption = m[1].match(/<caption[^>]*>([\s\S]*?)<\/caption>/i);
    const headings = [...html.slice(0, m.index).matchAll(/<h[234][^>]*>([\s\S]*?)<\/h[234]>/gi)];
    const system = (caption ? cellText(caption[1]) : headings.length ? cellText(headings[headings.length - 1][1]) : '').replace(/\s*\[edit\]\s*$/i, '');
    const grid = tableGrid(m[1]);
    const header = grid.find((r) => r.allHeaders);
    if (!header) continue;
    const cols = header.cells.map((c) => String(c || '').toLowerCase());
    const titleCol = cols.findIndex((c) => /\btitle\b|\bgame\b/.test(c));
    // Only the game tables: they say when each game joined Antstream.
    const addedCol = cols.findIndex((c) => c.includes('release date') || c.includes('added'));
    if (titleCol === -1 || addedCol === -1) continue;
    const pubCol = cols.findIndex((c) => c.includes('publisher'));
    const origCol = cols.findIndex((c) => c.includes('original'));
    for (const row of grid.filter((r) => !r.allHeaders)) {
      const title = (row.cells[titleCol] || '').trim();
      if (!title) continue;
      const id = `antstream:${slug(system || 'game')}:${slug(title)}`;
      if (seen.has(id)) continue;
      seen.add(id);
      const added = addedDate(row.cells[addedCol]);
      const year = (String(row.cells[origCol] || '').match(/\b(19|20)\d{2}\b/) || [])[0];
      const game = {
        id,
        service: 'antstream',
        title,
        image: null,
        platforms: PLATFORMS,
        system: system || null,
        tiers: ['any'],
        leavingSoon: false,
        genres: [],
        releaseDate: null,
        releaseYear: year ? Number(year) : null,
        addedOn: added && added <= today ? added : null,
        storeUrl: WIKI_PAGE,
      };
      if (added && added > today) game.comingOn = added;
      if (pubCol !== -1 && row.cells[pubCol]) game.publisher = row.cells[pubCol];
      games.push(game);
    }
  }
  return games;
}

async function fetchLive() {
  const data = await getJson(WIKI_URL, { headers: { 'Api-User-Agent': 'Subscroll/0.4 (desktop app)' } });
  const games = parseWikipedia(data.parse ? data.parse.text : '');
  const systems = new Set(games.map((g) => g.system));
  if (games.length < 300 || systems.size < 4) {
    throw new Error(`Wikipedia list looks incomplete (${games.length} games, ${systems.size} systems)`);
  }
  return games;
}

module.exports = { fetchLive, parseWikipedia, addedDate, WIKI_PAGE };
