import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { CENTERS, GATES, CHANNELS } from '../src/scene/geometry/chart-geometry.js';
import { CENTERS as centerIds, GATES as gateIds, CHANNELS as channelIds, getDefinition } from '../src/domain/topology.js';
import { createCamera } from '../src/scene/camera.js';
import { DRAWING_BOUNDS } from '../src/scene/geometry/frames.js';

test('separating the geometry preserves every approved anchor, polygon and authored curve', () => {
  // Captured from the published version before the module split. This guards
  // even control points which individual visual intersection tests do not use.
  const geometry = {
    centers: CENTERS.map(({ id, points, labelX, labelY }) => ({ id, points, labelX, labelY })),
    gates: GATES.map(({ id, center, x, y }) => ({ id, center, x, y })),
    channels: CHANNELS.map(({ id, gates, curve, curves, path }) => ({ id, gates, curve, curves, path })),
  };
  assert.equal(createHash('sha256').update(JSON.stringify(geometry)).digest('hex'),
    '91a63cda6fd118bdffed446fc2a0da29e08f82b8d1557bc7ce16b8a5d7adaa73');
});

test('topology owns only identities and connections, independent of visual records', () => {
  for (const center of centerIds) assert.deepEqual(Object.keys(center), ['id']);
  for (const gate of gateIds) assert.deepEqual(Object.keys(gate), ['id', 'center']);
  for (const channel of channelIds) assert.deepEqual(Object.keys(channel), ['id', 'gates']);
  const definition = getDefinition({ design: [34], personality: [20] });
  assert.deepEqual(definition.channels, [{ id: '20-34', gates: [20, 34] }]);
  assert.deepEqual([...definition.centers], ['throat', 'sacral']);
  assert.notEqual(channelIds[0], CHANNELS[0]);
  assert.notEqual(gateIds[0], GATES[0]);
});

test('camera commands preserve each movement without rereading layout or needing DOM objects', () => {
  let measurements = 0;
  const updates = [];
  const camera = createCamera({
    measureFit() {
      measurements++;
      return { area: { x: 0, y: 0, width: 744, height: 740 }, min: .1 };
    },
    onChange(view, home) { updates.push({ view, home }); },
  });
  camera.reset();
  const home = camera.getFittedView();
  assert.deepEqual(home, { k: 1, x: -DRAWING_BOUNDS.x, y: -DRAWING_BOUNDS.y });
  const measuredAtHome = measurements;
  const startingCount = updates.length;
  camera.zoomAt({ x: 372, y: 370 }, 2);
  for (let i = 0; i < 12; i++) camera.pan(1, -1);
  assert.equal(updates.length - startingCount, 13, 'each command publishes its intermediate position');
  assert.equal(measurements, measuredAtHome, 'ordinary camera changes do not recompute fitting geometry');
  for (let i = startingCount + 1; i < updates.length; i++) {
    assert.equal(updates[i].view.x - updates[i - 1].view.x, 1);
    assert.equal(updates[i].view.y - updates[i - 1].view.y, -1);
    assert.deepEqual(updates[i].home, home);
  }
  updates.at(-1).view.x = 999;
  assert.notEqual(camera.getView().x, 999, 'published snapshots cannot change the live camera');
});
