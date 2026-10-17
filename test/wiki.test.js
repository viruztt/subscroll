const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('../src/providers/http');
const { Wiki, wanted, parseInfobox, pageNames, findFacts } = require('../src/wiki');

const METROID = `{{Short description|2002 video game}}
{{Infobox video game
| title = Metroid Fusion
| image = Metroid Fusion box.jpg
| developer = [[Nintendo Research & Development 1|Nintendo R&D1]]<ref>{{cite web|url=x}}</ref>
| publisher = {{Video game release|NA|[[Nintendo]]|JP|[[Nintendo]]}}
| director = [[Yoshio Sakamoto]]
| series = ''[[Metroid]]''
| platforms = [[Game Boy Advance]]
| released = {{Video game release|NA|November 17, 2002}}
| genre = [[Action-adventure game|Action-adventure]], [[Metroidvania]]
| modes = [[Single-player video game|Single-player]]
}}
'''''Metroid Fusion''''' is a 2002 [[action-adventure game]].`;

const PLAINLIST = `{{Infobox video game
|title=Banjo-Tooie
|developer={{Plainlist|
* [[Rare (company)|Rare]]
* [[4J Studios]] (Xbox 360)
}}
|publisher = {{ubl|[[Nintendo]] (N64)|[[Microsoft Game Studios]] (Xbox 360)}}
|genre=[[Platform game|Platform]]
}}`;

test('Wikipedia infobox: developer, publisher and genres, with links, refs and lists', () => {
  assert.deepStrictEqual(parseInfobox(METROID), { title: 'Metroid Fusion', developer: 'Nintendo R&D1', publisher: 'Nintendo', genres: ['Action-adventure', 'Metroidvania'] });
  assert.deepStrictEqual(parseInfobox(PLAINLIST), { title: 'Banjo-Tooie', developer: 'Rare, 4J Studios', publisher: 'Nintendo, Microsoft Game Studios', genres: ['Platform'] });
  assert.strictEqual(parseInfobox('{{Infobox video game series\n| developer = Bioware\n}}'), null);
  assert.strictEqual(parseInfobox('No infobox here'), null);
});

test('Wikipedia page names to try', () => {
  assert.deepStrictEqual(pageNames('DOOM Eternal Standard Edition', 2020), ['DOOM Eternal (2020 video game)', 'DOOM Eternal', 'DOOM Eternal (video game)']);
  assert.deepStrictEqual(pageNames('Hades™', null), ['Hades', 'Hades (video game)']);
});

const page = (title, text, extra = {}) => ({ title, revisions: [{ slots: { main: { content: text } } }], ...extra });

test('Wikipedia lookup: the game\'s own page, never a different one from a search', async () => {
  const asked = [];
  http.setFetch(async (url) => {
    const u = new URL(url);
    asked.push(u.searchParams.get('titles') || `search:${u.searchParams.get('gsrsearch')}`);
    const titles = u.searchParams.get('titles');
    const body = (pages) => ({ ok: true, status: 200, json: async () => ({ query: { pages } }) });
    if (titles === 'Hades|Hades (video game)') {
      return body([
        page('Hades', '{{Infobox deity\n| name = Hades\n}}'),
        page('Hades (video game)', '{{Infobox video game\n| developer = [[Supergiant Games]]\n| genre = [[Roguelike]], [[action role-playing game|Action role-playing]]\n}}', { thumbnail: { source: 'https://upload.wikimedia.org/hades.jpg' } }),
      ]);
    }
    if (titles === 'Metroid Fusion|Metroid Fusion (video game)') return body([page('Metroid Fusion', METROID), { title: 'Metroid Fusion (video game)', missing: true }]);
    if (titles) return body(titles.split('|').map((t) => ({ title: t, missing: true })));
    // A search finding only the console, not the game.
    return body([page('Sega Genesis', '{{Infobox information appliance\n}}', { index: 1 }), page('Gunstar Heroes (series)', '{{Infobox video game\n| developer = Treasure\n}}', { index: 2 })]);
  });
  const hades = await findFacts({ title: 'Hades', service: 'netflix' });
  assert.deepStrictEqual([hades.page, hades.developer, hades.genres, hades.image], ['Hades (video game)', 'Supergiant Games', ['Roguelike', 'Action role-playing'], 'https://upload.wikimedia.org/hades.jpg']);
  const fusion = await findFacts({ title: 'Metroid Fusion', service: 'nso', platforms: ['Game Boy Advance'] });
  assert.strictEqual(fusion.developer, 'Nintendo R&D1');
  assert.strictEqual(await findFacts({ title: 'Gunstar Heroes', service: 'nso', platforms: ['Sega Genesis'] }), null);
  assert.ok(asked.includes('search:Gunstar Heroes Sega Genesis video game'));
});

test('Wikipedia facts fill only what a list left out, and are cached', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-'));
  let calls = 0;
  const find = async (g) => {
    calls += 1;
    return g.title === 'Super Metroid' ? { url: 'u', developer: 'Nintendo R&D1', publisher: 'Nintendo', genres: ['Metroidvania'], image: 'https://w/sm.jpg' } : null;
  };
  const wiki = new Wiki(dir, { pauseMs: 0, find });
  const sm = { id: 'nso:snes:super-metroid', service: 'nso', title: 'Super Metroid', platforms: ['SNES'], genres: [], image: 'https://libretro/sm.png' };
  const other = { id: 'nso:snes:x', service: 'nso', title: 'Unknown', platforms: ['SNES'], genres: [] };
  await wiki.start([sm, other, sm]);
  assert.strictEqual(calls, 2);
  const filled = wiki.fill(sm);
  assert.deepStrictEqual([filled.developer, filled.genres, filled.image], ['Nintendo R&D1', ['Metroidvania'], 'https://libretro/sm.png']);
  await new Wiki(dir, { pauseMs: 0, find }).start([sm, other]);
  assert.strictEqual(calls, 2);
  const list = wanted([
    { id: 'a', service: 'gamepass', developer: 'X', genres: ['RPG'] },
    { id: 'b', service: 'nso', genres: [] },
    { id: 'c', service: 'gamepass', genres: [] },
    { id: 'd', service: 'applearcade', developer: 'Y', genres: [], image: null },
  ], { isMine: (g) => g.id !== 'd', markOf: (g) => (g.id === 'c' || g.id === 'a' ? 'completed' : 'none') });
  assert.deepStrictEqual(list.map((g) => g.id), ['c', 'b', 'd']);
});
