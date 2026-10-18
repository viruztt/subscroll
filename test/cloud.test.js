const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('../src/providers/http');
const { Cloud, parseCloud } = require('../src/cloud');

const sample = { games: [
  { id: 'HALO', streamable: true, product_ids: ['9NP1P1WFS0LB'], base_product_id: '9NP1P1WFS0LB', tiers: { essential: 'purchase', premium: 'included', starter: 'purchase', ultimate: 'included' } },
  { id: 'NEW', streamable: true, product_ids: ['9NEWGAME0001', '9NEWGAME0002'], tiers: { essential: 'unavailable', premium: 'unavailable', ultimate: 'included' } },
  { id: 'BYOG', streamable: true, product_ids: ['9OWNIT000001'], tiers: { essential: 'purchase', premium: 'purchase', ultimate: 'purchase' } },
  { id: 'F2P', streamable: true, product_ids: ['9FREE0000001'], tiers: { essential: 'free', premium: 'free', ultimate: 'free' } },
  { id: 'OFF', streamable: false, product_ids: ['9OFF00000001'], tiers: { ultimate: 'included' } },
] };

test('parseCloud: Game Pass tiers that can stream each product', () => {
  const c = parseCloud(sample);
  assert.deepStrictEqual(c['9NP1P1WFS0LB'], { tiers: ['premium', 'ultimate'], own: true, free: false });
  assert.deepStrictEqual(c['9NEWGAME0002'].tiers, ['ultimate']);
  assert.deepStrictEqual(c['9OWNIT000001'], { tiers: [], own: true, free: false });
  assert.deepStrictEqual(c['9FREE0000001'].tiers, ['essential', 'premium', 'ultimate']);
  assert.strictEqual(c['9OFF00000001'], undefined);
});

test('Cloud: fetched once a day and added to Xbox games by product id', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-'));
  let asked = 0;
  http.setFetch(async () => { asked += 1; return { ok: true, status: 200, json: async () => sample }; });
  const cloud = new Cloud(dir);
  assert.ok(cloud.due());
  assert.strictEqual(await cloud.refresh(), 5);
  assert.strictEqual(asked, 1);
  const again = new Cloud(dir);
  assert.ok(!again.due());
  assert.deepStrictEqual(again.fill({ id: 'gamepass:9np1p1wfs0lb', service: 'gamepass' }).cloud.tiers, ['premium', 'ultimate']);
  // A Windows edition folded into the console one still counts.
  assert.ok(again.fill({ id: 'eaplay:9XXXX', altIds: ['eaplay:9NEWGAME0001'], service: 'eaplay' }).cloud);
  assert.strictEqual(again.fill({ id: 'psplus:123', service: 'psplus' }).cloud, undefined);
  assert.strictEqual(again.fill({ id: 'gamepass:9NOPE', service: 'gamepass' }).cloud, undefined);
});
