const { getJson } = require('./http');

// Nintendo publishes no machine-readable list of its retro library
// ("Nintendo Classics"). The Wikipedia article keeps a table per system,
// updated as games are added, so that's the live source. The curated
// scripts/nintendo-source.txt builds the bundled fallback.
const WIKI_URL = 'https://en.wikipedia.org/w/api.php?action=parse&page=Nintendo_Classics' +
  '&prop=text&format=json&formatversion=2&redirects=1';
const WIKI_PAGE = 'https://en.wikipedia.org/wiki/Nintendo_Classics';

// Table caption or section heading -> [system name used in ids, tier].
// Order matters: "Game Boy Advance" before "Game Boy", "SNES" before "NES".
const SYSTEMS = [
  [/game boy advance|\bgba\b/i, 'Game Boy Advance', 'expansion'],
  [/game boy/i, 'Game Boy', 'base'],
  [/super nintendo|\bsnes\b|super nes/i, 'SNES', 'base'],
  [/\bnes\b|nintendo entertainment system/i, 'NES', 'base'],
  [/nintendo 64|\bn64\b/i, 'N64', 'expansion'],
  [/genesis|mega drive/i, 'Sega Genesis', 'expansion'],
  [/virtual boy/i, 'Virtual Boy', 'expansion'],
  [/gamecube/i, 'GameCube (Switch 2)', 'expansion'],
];

const slug = (s) => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

function makeGame(system, tier, title, addedOn = null) {
  return {
    id: `nso:${slug(system)}:${slug(title)}`,
    service: 'nso',
    title,
    image: null,
    platforms: [system],
    tiers: [tier],
    leavingSoon: false,
    genres: [],
    releaseDate: null,
    addedOn,
    storeUrl: null,
  };
}

// ---- curated fallback ----
function parseSource(text) {
  const games = [];
  let system = null;
  let tier = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || (line.startsWith('#') && !line.startsWith('###'))) continue;
    if (line.startsWith('###')) {
      [system, tier] = line.slice(3).split('|').map((s) => s.trim());
      continue;
    }
    if (system) games.push(makeGame(system, tier, line));
  }
  return games;
}

// ---- Wikipedia ----
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—' };

function cellText(html) {
  return html
    .replace(/<sup[\s\S]*?<\/sup>/gi, '') // footnote markers
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<span[^>]*display:\s*none[\s\S]*?<\/span>/gi, '') // hidden sort keys
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&([a-z]+);/gi, (m, n) => ENTITIES[n.toLowerCase()] ?? m)
    .replace(/\s+/g, ' ')
    .trim();
}

const attrNum = (attrs, name) => {
  const m = attrs.match(new RegExp(`${name}\\s*=\\s*["']?(\\d+)`, 'i'));
  return m ? Number(m[1]) : 1;
};

// Turns a table's HTML into a grid of cell texts, expanding rowspan/colspan
// so a date shared by several rows repeats on each of them.
function tableGrid(tableHtml) {
  const grid = [];
  const pending = []; // column -> { text, left }
  const rows = tableHtml.split(/<tr[\s>]/i).slice(1);
  for (const rowHtml of rows) {
    const body = rowHtml.split(/<\/tr>/i)[0];
    const cells = [...body.matchAll(/<(th|td)(\s[^>]*)?>([\s\S]*?)(?=<t[hd][\s>]|$)/gi)]
      .map((m) => ({ header: m[1].toLowerCase() === 'th', attrs: m[2] || '', text: cellText(m[3].replace(/<\/t[hd]>\s*$/i, '')) }));
    const row = [];
    let col = 0;
    const fillPending = () => {
      while (pending[col] && pending[col].left > 0) {
        row[col] = pending[col].text;
        pending[col].left -= 1;
        col += 1;
      }
    };
    for (const cell of cells) {
      fillPending();
      const span = attrNum(cell.attrs, 'colspan');
      const rowspan = attrNum(cell.attrs, 'rowspan');
      for (let i = 0; i < span; i++) {
        row[col] = cell.text;
        if (rowspan > 1) pending[col] = { text: cell.text, left: rowspan - 1 };
        col += 1;
      }
    }
    fillPending();
    grid.push({ cells: row, allHeaders: cells.length > 0 && cells.every((c) => c.header) });
  }
  return grid;
}

function systemFor(label) {
  const hit = SYSTEMS.find(([re]) => re.test(label));
  return hit ? { system: hit[1], tier: hit[2] } : null;
}

function toIsoDate(text) {
  const t = Date.parse(`${text} UTC`);
  return Number.isNaN(t) ? null : new Date(t).toISOString().slice(0, 10);
}

function parseWikipedia(html) {
  const games = [];
  const seen = new Set();
  const tableRe = /<table[^>]*class="[^"]*wikitable[^"]*"[^>]*>([\s\S]*?)<\/table>/gi;
  for (const m of html.matchAll(tableRe)) {
    const captionMatch = m[1].match(/<caption[^>]*>([\s\S]*?)<\/caption>/i);
    const headings = [...html.slice(0, m.index).matchAll(/<h[23][^>]*>([\s\S]*?)<\/h[23]>/gi)];
    const label = captionMatch ? cellText(captionMatch[1]) : headings.length ? cellText(headings[headings.length - 1][1]) : '';
    const sys = systemFor(label);
    if (!sys) continue;

    const grid = tableGrid(m[1]);
    const headerRow = grid.find((r) => r.allHeaders);
    if (!headerRow) continue;
    const cols = headerRow.cells.map((c) => (c || '').toLowerCase());
    const gameCol = cols.findIndex((c) => c === 'game' || c === 'title' || c.startsWith('game'));
    const dateCol = cols.findIndex((c) => c.includes('date'));
    const westCol = cols.findIndex((c) => c.includes('na') && c.includes('pal'));
    if (gameCol === -1) continue;

    for (const row of grid) {
      if (row.allHeaders) continue;
      const title = (row.cells[gameCol] || '').trim();
      if (!title) continue;
      // Skip games only offered in Japan.
      if (westCol !== -1 && /^no\b/i.test(row.cells[westCol] || '')) continue;
      const game = makeGame(sys.system, sys.tier, title, dateCol !== -1 ? toIsoDate(row.cells[dateCol] || '') : null);
      if (seen.has(game.id)) continue;
      seen.add(game.id);
      game.storeUrl = WIKI_PAGE;
      games.push(game);
    }
  }
  return games;
}

async function fetchLive() {
  const data = await getJson(WIKI_URL, {
    headers: { 'Api-User-Agent': 'SubscriptionCatalogue/0.1 (desktop app)' },
  });
  const games = parseWikipedia(data.parse ? data.parse.text : '');
  // A page rewrite could break parsing; refuse a list that's clearly wrong
  // so the refresh keeps the previous library instead of wiping it.
  const systems = new Set(games.map((g) => g.platforms[0]));
  if (games.length < 150 || systems.size < 5) {
    throw new Error(`Wikipedia list looks incomplete (${games.length} games, ${systems.size} systems)`);
  }
  return games;
}

module.exports = { parseSource, parseWikipedia, tableGrid, fetchLive, slug };
