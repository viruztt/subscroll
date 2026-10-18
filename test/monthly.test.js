const test = require('node:test');
const assert = require('node:assert');
const { psWindow, pacific, parsePsList, parsePsBlog, parseFreePlayDays, cleanPsTitle, hasPlan } = require('../src/monthly');

test('PS Plus months run from first Tuesday to first Tuesday, Pacific morning', () => {
  // October 2026: games from Tuesday 6 October to Tuesday 3 November.
  assert.deepStrictEqual(psWindow(new Date('2026-10-18T12:00:00Z')), { month: '2026-10', start: '2026-10-06T16:00:00.000Z', end: '2026-11-03T17:00:00.000Z', startDay: '2026-10-06', endDay: '2026-11-02' });
  // Before the first Tuesday, September's games are still the current ones.
  assert.strictEqual(psWindow(new Date('2026-10-05T12:00:00Z')).month, '2026-09');
  assert.strictEqual(psWindow(new Date('2026-12-20T12:00:00Z'), 1).month, '2027-01');
  assert.strictEqual(pacific(2026, 0, 10, 23, 59), '2026-01-11T07:59:00.000Z');
  assert.strictEqual(pacific(2026, 6, 10, 23, 59), '2026-07-11T06:59:00.000Z');
  assert.strictEqual(cleanPsTitle('EARTH DEFENSE FORCE: WORLD BROTHERS 2　PS4 & PS5'), 'EARTH DEFENSE FORCE: WORLD BROTHERS 2');
});

test('parsePsList: this month\'s games with the claim window', () => {
  const list = [{ catalogKey: 'E', games: [{ conceptId: 10008165, name: 'EDF　PS4 & PS5', conceptUrl: 'https://store.playstation.com/en-gb/concept/10008165', imageUrl: 'https://img/edf.png' }] }, { catalogKey: 'F', games: [] },
    { catalogKey: 'H', games: [{ conceptId: 234014, name: 'Hunt: Showdown 1896' }, { conceptId: 234014, name: 'Hunt: Showdown 1896 – Starter Pack for PlayStation®Plus' }] }];
  const [g, ...rest] = parsePsList(list, { now: new Date('2026-10-18T12:00:00Z') });
  assert.deepStrictEqual(rest.map((x) => x.title), ['Hunt: Showdown 1896']);
  assert.deepStrictEqual(g, {
    id: 'psplus:2026-10:10008165', store: 'psplus', title: 'EDF', image: 'https://img/edf.png',
    url: 'https://store.playstation.com/en-gb/concept/10008165', start: '2026-10-06T16:00:00.000Z', end: '2026-11-03T17:00:00.000Z', startDay: '2026-10-06', endDay: '2026-11-02', upcoming: false, needs: 'psplus',
  });
});

const rss = (items) => `<?xml version="1.0"?><rss><channel><title>Blog</title>${items.join('')}</channel></rss>`;
const item = ({ title, date, link = 'https://example.com/post', html = '', cats = [], image }) => `<item><title>${title}</title><link>${link}</link><pubDate>${date}</pubDate>${cats.map((c) => `<category><![CDATA[${c}]]></category>`).join('')}${image ? `<media:content url="${image}" medium="image"/>` : ''}<content:encoded><![CDATA[${html}]]></content:encoded></item>`;

test('parsePsBlog: next month\'s announced games', () => {
  const xml = rss([
    item({ title: 'PlayStation Plus Monthly Games for November: Stray, Hogwarts Legacy, and Hot Wheels Unleashed 2', date: 'Wed, 28 Oct 2026 16:00:00 +0000', link: 'https://blog.playstation.com/2026/10/28/ps-plus-november/', image: 'https://blog/nov.jpg' }),
    item({ title: 'PlayStation Plus Monthly Games for October: F1 25, Hunt: Showdown 1896, Earth Defense Force: World Brothers 2', date: 'Wed, 30 Sep 2026 16:00:00 +0000' }),
    item({ title: 'PlayStation Plus Game Catalog for October', date: 'Wed, 07 Oct 2026 16:00:00 +0000' }),
    item({ title: 'PlayStation Plus Monthly Games for January: Next Year Game', date: 'Wed, 30 Dec 2026 16:00:00 +0000' }),
  ]);
  const games = parsePsBlog(xml, { now: new Date('2026-10-29T12:00:00Z') });
  assert.deepStrictEqual(games.map((g) => [g.title, g.month, g.upcoming]), [
    ['Stray', '2026-11', true], ['Hogwarts Legacy', '2026-11', true], ['Hot Wheels Unleashed 2', '2026-11', true],
    ['F1 25', '2026-10', false], ['Hunt: Showdown 1896', '2026-10', false], ['Earth Defense Force: World Brothers 2', '2026-10', false],
    ['Next Year Game', '2027-01', true],
  ]);
  assert.strictEqual(games[0].start, '2026-11-03T17:00:00.000Z');
  assert.strictEqual(games[0].image, 'https://blog/nov.jpg');
  assert.strictEqual(games[0].url, 'https://blog.playstation.com/2026/10/28/ps-plus-november/');
});

// Shaped like Xbox Wire's Free Play Days posts.
const card = (id, slug, title, img) => `<div class="ms-product-badge"><a href="https://www.microsoft.com/en-us/store/apps/${slug}/${id}"><img src="${img}" alt=""></a><h2>${title}</h2><span class="price">$59.99</span><a class="mspb-link" href="https://www.microsoft.com/en-us/store/apps/${slug}/${id}">Get it now</a></div>`;
const fpdHtml = `<p>Play <strong><em>Crusader Kings III</em></strong> and more with Game Pass Ultimate, Premium, and Essential from <strong>Thursday</strong>, <strong>October 15</strong> until <strong>Sunday</strong> ,<strong>October 18</strong>.</p>
<h2 class="wp-block-heading">How to Start Playing</h2><p>Go to the <a href="https://www.xbox.com/en-US/games/free-play-days">Free Play Days collection</a>.</p>
<h2 class="wp-block-heading">Free Play Days (Game Pass Membership Required)</h2><hr class="wp-block-separator">
<p><strong><a href="https://www.xbox.com/en-US/games/store/crusader-kings-iii/9mz8rzsd0nfq">Crusader Kings III</a></strong><br>Rule a dynasty.</p>${card('9mz8rzsd0nfq', 'crusader-kings-iii', 'Crusader Kings III (XBOX Series X|S)', 'https://img/ck3.jpg')}<hr>
<p><strong><a href="https://www.xbox.com/en-US/games/store/nba-2k27/9n3d82tff6c4">NBA 2K27</a></strong><br>Play beginning Friday, October 16 at 12pm PDT until Sunday, October 18. Save 50% until November 1.</p>${card('9n3d82tff6c4', 'nba-2k27', 'NBA 2K27 (XBOX Series X|S)', 'https://img/nba.jpg')}<hr>
<h2 class="wp-block-heading">Free Play Days For All</h2><hr class="wp-block-separator">
<p><strong><a href="https://www.xbox.com/en-GB/games/store/the-alters/9n0p25wjhm8c">The Alters</a></strong><br>A free 3-hour timed trial, no Game Pass required.</p>${card('9n0p25wjhm8c', 'the-alters', 'The Alters', 'https://img/alters.jpg')}<hr>
<h2 class="wp-block-heading">Keep the Fun Going</h2><p>Buy at a discount.</p>`;

test('parseFreePlayDays: this weekend\'s games, who can play, and when', () => {
  const xml = rss([
    item({ title: 'Free Play Days &#8211; NBA 2K27, Crusader Kings III and The Alters', date: 'Thu, 15 Oct 2026 15:01:00 +0000', link: 'https://news.xbox.com/en-us/2026/10/15/free-play-days-10-15-2026/', cats: ['Free Play Days', 'Xbox Game Pass'], html: fpdHtml }),
    item({ title: 'Free Play Days &#8211; Old Weekend', date: 'Thu, 08 Oct 2026 15:00:00 +0000', cats: ['Free Play Days'], html: '<p>From Thursday, October 8 until Sunday, October 11.</p><h2>Free Play Days (Game Pass Membership Required)</h2><hr><p><a href="https://www.xbox.com/en-US/games/store/screamer/9NKQG4Z00XBG">Screamer</a></p><hr>' }),
    item({ title: 'This Week on Xbox', date: 'Fri, 16 Oct 2026 15:00:00 +0000', html: '<p><a href="https://www.xbox.com/en-US/games/store/x/9AAAAAAAAAAA">Other</a></p>' }),
  ]);
  const games = parseFreePlayDays(xml, { now: new Date('2026-10-16T12:00:00Z') });
  assert.deepStrictEqual(games.map((g) => [g.title, g.productId, g.needs, g.trial, g.upcoming]), [
    ['Crusader Kings III', '9MZ8RZSD0NFQ', 'gamepass', false, false],
    ['NBA 2K27', '9N3D82TFF6C4', 'gamepass', false, true],
    ['The Alters', '9N0P25WJHM8C', null, true, false],
  ]);
  const [ck, nba] = games;
  assert.strictEqual(ck.start, '2026-10-15T07:01:00.000Z');
  assert.strictEqual(ck.end, '2026-10-19T06:59:00.000Z');
  assert.deepStrictEqual([ck.startDay, ck.endDay], ['2026-10-15', '2026-10-18']);
  assert.strictEqual(ck.image, 'https://img/ck3.jpg');
  assert.strictEqual(ck.url, 'https://www.xbox.com/games/store/x/9MZ8RZSD0NFQ');
  assert.strictEqual(ck.kind, 'try');
  assert.strictEqual(nba.start, '2026-10-16T19:00:00.000Z');
  assert.strictEqual(nba.end, '2026-10-19T06:59:00.000Z');
  // Once the weekend is over, nothing is left.
  assert.deepStrictEqual(parseFreePlayDays(xml, { now: new Date('2026-10-19T08:00:00Z') }), []);
});

test('hasPlan: any plan of the service, but PC Game Pass has no Free Play Days', () => {
  assert.ok(hasPlan(null, {}));
  assert.ok(hasPlan('psplus', { psplus: 'essential' }));
  assert.ok(!hasPlan('psplus', { gamepass: 'ultimate' }));
  assert.ok(hasPlan('gamepass', { gamepass: 'essential' }));
  assert.ok(!hasPlan('gamepass', { gamepass: 'pc' }));
});
