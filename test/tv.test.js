const test = require('node:test');
const assert = require('node:assert');
const TV = require('../renderer/tv');

test('Controller mode: moving around the grid', () => {
  // 10 tiles, 4 wide: rows 0-3, 4-7, 8-9.
  assert.strictEqual(TV.move(0, 'left', 4, 10), 0);
  assert.strictEqual(TV.move(3, 'right', 4, 10), 3);
  assert.strictEqual(TV.move(1, 'down', 4, 10), 5);
  assert.strictEqual(TV.move(5, 'up', 4, 10), 1);
  // Down from a tile with nothing below goes to the last tile.
  assert.strictEqual(TV.move(6, 'down', 4, 10), 9);
  assert.strictEqual(TV.move(9, 'down', 4, 10), 9);
  assert.strictEqual(TV.move(9, 'right', 4, 10), 9);
  assert.strictEqual(TV.move(0, 'down', 4, 0), -1);
});

test('Controller mode: a press is one action, held directions repeat', () => {
  const r = new TV.Repeater();
  assert.deepStrictEqual(r.step(new Set(['ok', 'down']), 0), ['ok', 'down']);
  assert.deepStrictEqual(r.step(new Set(['ok', 'down']), 200), []);
  assert.deepStrictEqual(r.step(new Set(['ok', 'down']), 400), ['down']);
  assert.deepStrictEqual(r.step(new Set(['ok', 'down']), 450), []);
  assert.deepStrictEqual(r.step(new Set(['ok', 'down']), 520), ['down']);
  // Let go and press again: one more.
  assert.deepStrictEqual(r.step(new Set(), 600), []);
  assert.deepStrictEqual(r.step(new Set(['ok']), 610), ['ok']);
});

test('Controller mode: gamepad buttons and sticks, keys', () => {
  const buttons = Array.from({ length: 17 }, () => ({ pressed: false, value: 0 }));
  buttons[0] = { pressed: true, value: 1 };
  buttons[5] = { pressed: true, value: 1 };
  const pad = { connected: true, buttons, axes: [-0.9, 0.1, 0, 0] };
  assert.deepStrictEqual([...TV.padActions(pad)].sort(), ['left', 'nextTab', 'ok']);
  assert.strictEqual(TV.keyAction({ key: 'Enter' }), 'ok');
  assert.strictEqual(TV.keyAction({ key: 'E' }), 'nextTab');
  assert.strictEqual(TV.keyAction({ key: 'f', ctrlKey: true }), null);
});
