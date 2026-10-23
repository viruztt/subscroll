const test = require('node:test');
const assert = require('node:assert');
const Share = require('../renderer/share');

const items = [
  { title: 'Hollow Knight', where: 'Game Pass', stars: 5 },
  { title: 'Super_Metroid [SNES]', where: 'Switch Online', stars: 0 },
];

test('Share: a text list, plain or Markdown', () => {
  assert.strictEqual(Share.text(items, { heading: 'My To play list', footer: 'Made with Subscroll' }),
    'My To play list\n\n• Hollow Knight (Game Pass) ★★★★★\n• Super_Metroid [SNES] (Switch Online)\n\nMade with Subscroll');
  const md = Share.text(items, { heading: 'Games I completed', markdown: true, where: false });
  assert.strictEqual(md, '## Games I completed\n\n- **Hollow Knight** ★★★★★\n- **Super\\_Metroid \\[SNES\\]**');
  assert.strictEqual(Share.text(items, { stars: false, where: false }), '• Hollow Knight\n• Super_Metroid [SNES]');
});

test('Share: fewer games get bigger covers, and the picture stops at 48', () => {
  assert.strictEqual(Share.layout(3).cols, 3);
  assert.strictEqual(Share.layout(8).cols, 5);
  const big = Share.layout(100);
  assert.deepStrictEqual([big.cols, big.rows, big.shown, big.more], [6, 8, 48, 52]);
  assert.ok(big.height < 3200);
  assert.ok(Share.layout(1).tile > Share.layout(30).tile);
});
