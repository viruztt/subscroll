const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('../src/providers/http');
const blog = require('../src/providers/psblog');

const B = 'https://blog.playstation.com';

// Shapes from real posts: 2023 onwards (titles in bold paragraphs), 2022
// (titles as headings, with Essential's monthly games too) and the relaunch.
const POST_2025 = `<h1>PlayStation Plus Game Catalog for December: Assassin&#8217;s Creed Mirage, Skate Story and more</h1>
<p class="wp-block-paragraph">This month's lineup is available to play December 16.</p>
<h2 class="wp-block-heading"><strong>PlayStation Plus Extra and Premium | Game Catalog</strong></h2>
<p class="wp-block-paragraph"><strong>Assassin&#8217;s Creed Mirage | PS5, PS4&nbsp;</strong></p>
<p class="wp-block-paragraph">Experience the story of Basim, a cunning street thief.</p>
<p class="wp-block-paragraph"><strong>Ratchet &#038; Clank: Rift Apart | PS5</strong></p>
<h2 class="wp-block-heading"><strong>PlayStation Plus Premium</strong></h2>
<p class="wp-block-paragraph"><strong>Sly 2: Band of Thieves | PS4, PS5</strong></p>`;
const POST_2022 = `<h2 class="wp-block-heading"><strong>PlayStation Plus Essential | Monthly Games</strong></h2>
<h2 class="wp-block-heading">Need for Speed Heat | PS4</h2>
<h2 class="wp-block-heading"><strong>PlayStation Plus Extra | Game Catalog</strong></h2>
<h2 class="wp-block-heading">Far Cry 5 | PS4</h2>
<h2 class="wp-block-heading"><strong>PlayStation Plus Premium | Classics</strong></h2>
<h2 class="wp-block-heading">Jak and Daxter: The Precursor Legacy | PS4</h2>`;
const LAUNCH = '<ul><li>Bloodborne | FromSoftware, PS4</li><li>Demon&#8217;s Souls | Bluepoint Games, Japan Studio, PS5</li></ul>';

test('PS Blog: game titles from each kind of post', () => {
  assert.deepStrictEqual(blog.parsePost(POST_2025).map((x) => x.title), ['Assassin’s Creed Mirage', 'Ratchet & Clank: Rift Apart', 'Sly 2: Band of Thieves']);
  // Essential's monthly games are left out.
  assert.deepStrictEqual(blog.parsePost(POST_2022).map((x) => x.title), ['Far Cry 5', 'Jak and Daxter: The Precursor Legacy']);
  assert.deepStrictEqual(blog.parsePost(LAUNCH).map((x) => x.title), ['Bloodborne', 'Demon’s Souls']);
});

test('PS Blog: games join on the third Tuesday of the month the post is for', () => {
  assert.strictEqual(blog.joinedFor(`${B}/2025/12/10/playstation-plus-game-catalog-for-december-assassins-creed-mirage/`), '2025-12-16');
  assert.strictEqual(blog.joinedFor(`${B}/2024/12/11/playstation-plus-game-catalog-lineup-for-december-the-crew-2/`), '2024-12-17');
  // Posted at the end of August for September.
  assert.strictEqual(blog.joinedFor(`${B}/2022/08/31/playstation-plus-monthly-games-and-game-catalog-lineup-for-september-revealed/`), '2022-09-20');
  // Posted in December for January.
  assert.strictEqual(blog.joinedFor(`${B}/2026/12/30/playstation-plus-game-catalog-for-january-x/`), '2027-01-19');
  assert.strictEqual(blog.joinedFor(`${B}/2022/05/16/all-new-playstation-plus-game-lineup-assassins-creed-valhalla-join-the-service/`), '2022-06-13');
  assert.strictEqual(blog.joinedFor(`${B}/2025/12/02/playstation-plus-monthly-games-for-december/`), null);
});

test('PS Blog: finds posts through the sitemaps, reads each once, and dates games', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'psblog-'));
  const dec24 = `${B}/2024/12/11/playstation-plus-game-catalog-for-december-x/`;
  const dec25 = `${B}/2025/12/10/playstation-plus-game-catalog-for-december-y/`;
  const pages = {
    [`${B}/wp-sitemap.xml`]: `<sitemapindex><sitemap><loc>${B}/wp-sitemap-posts-post-2021.xml</loc></sitemap><sitemap><loc>${B}/wp-sitemap-posts-2024.xml</loc></sitemap><sitemap><loc>${B}/wp-sitemap-posts-2025.xml</loc></sitemap><sitemap><loc>${B}/wp-sitemap-posts-recent.xml</loc></sitemap></sitemapindex>`,
    [`${B}/wp-sitemap-posts-2024.xml`]: `<urlset><url><loc>${dec24}</loc></url><url><loc>${B}/2024/12/02/some-other-post/</loc></url></urlset>`,
    [`${B}/wp-sitemap-posts-2025.xml`]: `<urlset><url><loc>${dec25}</loc></url></urlset>`,
    [`${B}/wp-sitemap-posts-recent.xml`]: '<urlset></urlset>',
    [dec24]: '<p><strong>The Crew 2 | PS4</strong></p><p><strong>Assassin&#8217;s Creed Mirage | PS5, PS4</strong></p>',
    [dec25]: POST_2025,
  };
  const asked = [];
  http.setFetch(async (url) => {
    asked.push(url);
    if (!(url in pages)) return { ok: false, status: 404 };
    return { ok: true, text: async () => pages[url] };
  });
  try {
    assert.strictEqual(await blog.update(dir, { delayMs: 0, now: new Date('2026-10-21T12:00:00Z') }), true);
    assert.ok(!asked.some((u) => u.includes('2021')), 'years before the relaunch are skipped');
    const dates = blog.joinDates(blog.load(dir), '2026-10-21');
    // A game in two posts: the latest stay.
    assert.strictEqual(blog.lookup(dates, "Assassin's Creed Mirage"), '2025-12-16');
    assert.strictEqual(blog.lookup(dates, 'The Crew™ 2'), '2024-12-17');
    // Close names: the store's longer title starts with the blog's.
    assert.strictEqual(blog.lookup(dates, 'Ratchet & Clank: Rift Apart PS5'), '2025-12-16');
    assert.strictEqual(blog.lookup(dates, 'Gran Turismo 7'), null);
    // Adds dates only where there's none.
    const games = blog.apply([{ title: 'The Crew 2' }, { title: 'Sly 2: Band of Thieves', addedOn: '2026-08-18' }], dir, '2026-10-21');
    assert.deepStrictEqual(games.map((g) => g.addedOn), ['2024-12-17', '2026-08-18']);
    // Next time: past years' sitemaps and read posts aren't asked again.
    asked.length = 0;
    assert.strictEqual(await blog.update(dir, { delayMs: 0, now: new Date('2026-10-22T12:00:00Z') }), false);
    assert.deepStrictEqual(asked, [`${B}/wp-sitemap.xml`, `${B}/wp-sitemap-posts-recent.xml`]);
    assert.strictEqual(blog.due(dir, Date.parse('2026-10-22T13:00:00Z')), false);
  } finally {
    http.setFetch((...a) => globalThis.fetch(...a));
  }
});
