const test = require('node:test');
const assert = require('node:assert');
const { parsePlayPass } = require('../src/providers/playpass');
const { parseLuna, dayOf, imageOf } = require('../src/providers/luna');

const row = (title, genre, appId, extra = {}) => {
  const r = [title, genre, appId, 'icon-' + appId, ['shot-' + appId, 3], 'Dev', null, 1, 4.5, 100, 1000, [], null, null, 3, '2026-10-04', '2015-02-11', null, null, 0, 0];
  for (const [i, v] of Object.entries(extra)) r[i] = v;
  return r;
};
const ppPage = (games) => `<html><script id="data" type="application/json">${JSON.stringify({
  genres: ['Adventure', 'Puzzle', 'Apps'], regions: [{ code: 'US' }, { code: 'GB' }, { code: 'DE' }],
  games, meta: { trackingSince: '2026-10-04' },
})}</script></html>`;

test('Play Pass: games only, offered in your country, regional editions and join dates', () => {
  const html = ppPage([
    row('LIMBO', 0, 'com.playdead.limbo.full'),
    row('FlipaClip', 2, 'com.vblast.flipaclip'),
    row('US only', 1, 'us.only', { 12: [1, 2] }),
    row('Layton', 1, 'com.layton.us', { 13: { 1: 'com.layton.eu' }, 15: '2026-11-01' }),
    row('Left', 1, 'left', { 7: 0 }),
  ]);
  const gb = parsePlayPass(html, { region: 'GB' });
  assert.deepStrictEqual(gb.map((g) => g.title), ['LIMBO', 'Layton']);
  assert.strictEqual(gb[0].image, 'https://play-lh.googleusercontent.com/icon-com.playdead.limbo.full');
  assert.strictEqual(gb[0].addedOn, null);
  assert.deepStrictEqual(gb[0].genres, ['Adventure']);
  assert.strictEqual(gb[1].storeUrl, 'https://play.google.com/store/apps/details?id=com.layton.eu');
  assert.strictEqual(gb[1].id, 'playpass:com.layton.us');
  assert.strictEqual(gb[1].addedOn, '2026-11-01');
  // Not offered in your country: the fallback country's list.
  assert.deepStrictEqual(parsePlayPass(html, { region: 'MN', fallback: 'GB' }).map((g) => g.id), gb.map((g) => g.id));
  assert.strictEqual(parsePlayPass(html, { region: 'US' }).length, 3);
});

const now = new Date('2026-10-18T12:00:00Z');
const card = (id, title, label, img = `https://images.igdb.com/igdb/image/upload/t_cover_big/${id}.jpg`) =>
  `<div><a href="/game/${id}"><img alt="${title}" src="${img}"/></a><a href="/game/${id}"><h3>${title}<span>(2026)</span></h3></a>${label ? `<p>${label}</p>` : ''}</div>`;
const lunaPage = `<html><body><h2>New Releases</h2>${card(1, 'Star Wars: Galactic Racer', 'Added: Oct 6')}
<h2>Leaving Soon</h2>${card(2, 'Old Game', 'Leaves: Oct 31')}
<h2>Coming Soon (1)</h2>${card(3, 'Next Game', 'Arrives: Nov 3')}
<h2>Available Games (3)</h2><table><tr><td>${card(1, 'Star Wars: Galactic Racer', '')}</td></tr><tr><td>${card(2, 'Old Game', '')}</td></tr>
<tr><td><a href="/game/4"><img alt="" src="https://gamescriptions.com/_next/image?url=https%3A%2F%2Fimages.gamescriptions.com%2Fgames%2F0_Space.png&amp;w=3840&amp;q=75"/></a><a href="/game/4">Space Metal Mania(2026)</a> Cloud Only</td></tr></table></body></html>`;

test('Luna: games with added, leaving and arriving dates', () => {
  const games = parseLuna(lunaPage, { tier: 'premium', now });
  const by = Object.fromEntries(games.map((g) => [g.title, g]));
  assert.deepStrictEqual(Object.keys(by).sort(), ['Next Game', 'Old Game', 'Space Metal Mania', 'Star Wars: Galactic Racer']);
  assert.strictEqual(by['Star Wars: Galactic Racer'].addedOn, '2026-10-06');
  assert.strictEqual(by['Old Game'].leavesOn, '2026-10-31');
  assert.strictEqual(by['Old Game'].leavingSoon, true);
  assert.strictEqual(by['Next Game'].comingOn, '2026-11-03');
  assert.strictEqual(by['Space Metal Mania'].image, 'https://images.gamescriptions.com/games/0_Space.png');
  assert.deepStrictEqual(by['Space Metal Mania'].tiers, ['premium']);
  assert.strictEqual(by['Star Wars: Galactic Racer'].id, 'luna:1');
  // Dates without a year: added in the past, leaving ahead.
  assert.strictEqual(dayOf('Dec 20', 'added', now), '2025-12-20');
  assert.strictEqual(dayOf('Jan 5', 'leaves', now), '2027-01-05');
  assert.strictEqual(imageOf('<p>no image</p>'), null);
});
