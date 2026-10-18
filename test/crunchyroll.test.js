const test = require('node:test');
const assert = require('node:assert');
const { normalizeVault, cleanName } = require('../src/providers/crunchyroll');

test('Crunchyroll Game Vault: games from its App Store account, names cleaned', () => {
  const games = normalizeVault({ results: [
    { wrapperType: 'artist', artistName: 'Crunchyroll, LLC' },
    { wrapperType: 'software', trackId: 329913454, trackName: 'Crunchyroll', primaryGenreName: 'Entertainment', genres: ['Entertainment'] },
    { wrapperType: 'software', trackId: 6745589513, trackName: 'Crunchyroll: Phantom Breaker', primaryGenreName: 'Games', genres: ['Games', 'Action'], artworkUrl512: 'https://img/pb.png', trackViewUrl: 'https://apps.apple.com/us/app/id6745589513?uo=4', releaseDate: '2025-06-01T07:00:00Z', description: 'A fighting game with a long enough description to be used as the first paragraph.' },
  ] });
  assert.deepStrictEqual(games.map((g) => [g.id, g.service, g.title, g.tiers, g.platforms]), [['crunchyroll:6745589513', 'crunchyroll', 'Phantom Breaker', ['megafan'], ['Mobile']]]);
  assert.strictEqual(games[0].storeUrl, 'https://apps.apple.com/us/app/id6745589513');
  assert.strictEqual(cleanName('Battle Chasers: Nightwar Crunchyroll Edition'), 'Battle Chasers: Nightwar');
});
