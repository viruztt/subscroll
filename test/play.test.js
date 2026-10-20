const test = require('node:test');
const assert = require('node:assert');
const { playActions, allowed } = require('../renderer/play');

test('playActions: Steam first, by whether it is installed', () => {
  const g = { service: 'gamepass', id: 'gamepass:9NBLGGH4R315', platforms: ['console', 'pc'], steam: { appid: 1145360 } };
  assert.deepStrictEqual(playActions(g, { installed: true }).map((a) => [a.label, a.url, !!a.primary]), [
    ['▶ Play on Steam', 'steam://run/1145360', true],
    ['Open in the Xbox app', 'msxbox://game/?productId=9NBLGGH4R315', false],
  ]);
  assert.strictEqual(playActions(g, { installed: false })[0].url, 'steam://install/1145360');
  assert.strictEqual(playActions(g)[0].url, 'steam://nav/games/details/1145360');
});

test('playActions: Xbox app only for PC lists, PlayStation Store page, nothing for Switch', () => {
  const merged = { offers: [
    { service: 'gamepass', id: 'gamepass:9AAAAAAAAAAA', platforms: ['console'] },
    { service: 'eaplay', id: 'eaplay:9BBBBBBBBBBB', platforms: ['pc'] },
    { service: 'psplus', id: 'psplus:123', storeUrl: 'https://store.playstation.com/en-gb/concept/123' },
  ] };
  assert.deepStrictEqual(playActions(merged).map((a) => a.url), ['msxbox://game/?productId=9BBBBBBBBBBB', 'https://store.playstation.com/en-gb/concept/123']);
  assert.deepStrictEqual(playActions({ service: 'gamepass', id: 'gamepass:9AAAAAAAAAAA', platforms: ['console'] }), []);
  assert.deepStrictEqual(playActions({ service: 'nso', id: 'nso:mario', platforms: ['switch'] }), []);
});

test('playActions: an Xbox 360 game merged with its PC release opens the PC one', () => {
  const { mergeDuplicates } = require('../src/catalog');
  const [alice] = mergeDuplicates([
    { service: 'gamepass', id: 'gamepass:BSNZHRCKC13J', title: 'Alice: Madness Returns', platforms: ['console'], tiers: ['ultimate'] },
    { service: 'gamepass', id: 'gamepass:9NPVC7S5ZZ7R', title: 'Alice: Madness Returns', platforms: ['pc'], tiers: ['pc'] },
  ]);
  assert.strictEqual(alice.id, 'gamepass:BSNZHRCKC13J');
  assert.strictEqual(alice.pcId, 'gamepass:9NPVC7S5ZZ7R');
  assert.strictEqual(playActions(alice)[0].url, 'msxbox://game/?productId=9NPVC7S5ZZ7R');
  const [pcFirst] = mergeDuplicates([
    { service: 'gamepass', id: 'gamepass:9NPVC7S5ZZ7R', title: 'X', platforms: ['pc', 'console'], tiers: ['pc'] },
    { service: 'gamepass', id: 'gamepass:BSNZHRCKC13J', title: 'X', platforms: ['console'], tiers: ['ultimate'] },
  ]);
  assert.strictEqual(pcFirst.pcId, undefined);
});

test('allowed: only Steam, Xbox app and web links open', () => {
  assert.ok(allowed('steam://run/570'));
  assert.ok(allowed('msxbox://game/?productId=9NBLGGH4R315'));
  assert.ok(allowed('https://store.playstation.com/x'));
  assert.ok(!allowed('steam://run/570 && calc'));
  assert.ok(!allowed('steam://exec/cmd'));
  assert.ok(!allowed('file:///C:/Windows/system32/calc.exe'));
  assert.ok(!allowed('msxbox://game/?productId=9NBL;x'));
});
