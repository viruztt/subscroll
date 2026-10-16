const test = require('node:test');
const assert = require('node:assert');
const { genresOf, fitsLength } = require('../renderer/genres');

test('Store genres map onto one list', () => {
  assert.deepStrictEqual(genresOf({ service: 'gamepass', genres: ['Role playing', 'Action & adventure'] }), ['Action & adventure', 'RPG']);
  assert.deepStrictEqual(genresOf({ service: 'psplus', genres: ['Role_playing_games', 'Horror'] }), ['RPG', 'Horror']);
  assert.deepStrictEqual(genresOf({ service: 'netflix', genres: ['Puzzle', 'Board'] }), ['Puzzle', 'Card & board']);
  assert.deepStrictEqual(genresOf({ service: 'gamepass', genres: ['Multi-player Online Battle Arena'] }), ['Strategy']);
  assert.deepStrictEqual(genresOf({ service: 'psplus', genres: ['Unique'] }), []);
});

test('Switch Online games are Retro, and merged games combine genres', () => {
  assert.deepStrictEqual(genresOf({ service: 'nso', genres: [] }), ['Retro']);
  const merged = { offers: [{ service: 'gamepass', genres: ['Shooter'] }, { service: 'psplus', genres: ['Horror'] }] };
  assert.deepStrictEqual(genresOf(merged), ['Shooter', 'Horror']);
});

test('Length filter uses main-story hours and skips games without a time', () => {
  assert.ok(fitsLength(4.5, 'under5'));
  assert.ok(fitsLength(8, 'under10'));
  assert.ok(!fitsLength(12, 'under10'));
  assert.ok(fitsLength(20, '10to20'));
  assert.ok(fitsLength(55, 'over40'));
  assert.ok(!fitsLength(null, 'under10'));
  assert.ok(fitsLength(null, 'all'));
});
