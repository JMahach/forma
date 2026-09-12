import test from 'node:test';
import assert from 'node:assert/strict';
import { CENTERS, GATES, CHANNELS, getGate, getCenter, getChannel } from '../src/bodygraph/graph-data.js';
import { renderBodygraph } from '../src/bodygraph/bodygraph.js';
import { INTEGRATION_ARMS, STEM_POINTS } from '../src/bodygraph/integration-geometry.js';

// The redesign may change coordinates and curves, but never the underlying graph.
const CENTER_GATES = {
  head: [61, 63, 64],
  ajna: [4, 11, 17, 24, 43, 47],
  throat: [8, 12, 16, 20, 23, 31, 33, 35, 45, 56, 62],
  g: [1, 2, 7, 10, 13, 15, 25, 46],
  heart: [21, 26, 40, 51],
  spleen: [18, 28, 32, 44, 48, 50, 57],
  solar: [6, 22, 30, 36, 37, 49, 55],
  sacral: [3, 5, 9, 14, 27, 29, 34, 42, 59],
  root: [19, 38, 39, 41, 52, 53, 54, 58, 60],
};
const CHANNEL_PAIRS = [
  '1-8', '2-14', '3-60', '4-63', '5-15', '6-59', '7-31', '9-52',
  '10-20', '10-34', '10-57', '11-56', '12-22', '13-33', '16-48', '17-62',
  '18-58', '19-49', '20-34', '20-57', '21-45', '23-43', '24-61', '25-51',
  '26-44', '27-50', '28-38', '29-46', '30-41', '32-54', '34-57', '35-36',
  '37-40', '39-55', '42-53', '47-64',
];
const INTEGRATION_GATES = [10, 20, 34, 57];
const ordinaryChannels = CHANNELS.filter(channel => !channel.gates.every(id => INTEGRATION_GATES.includes(id)));
const polygon = center => center.points.trim().split(/\s+/).map(point => point.split(',').map(Number));
const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const PRESERVED_26_44_PATH = 'M 164 576 C 198 520 216 510 260 510 C 340 510 434 524 434 463';
const CENTRAL_RAILS = [
  { x: 299, gates: [64, 47, 17, 62, 31, 7, 15, 5, 42, 53], channels: ['47-64', '17-62', '7-31', '5-15', '42-53'] },
  { x: 320, gates: [61, 24, 43, 23, 8, 1, 2, 14, 3, 60], channels: ['24-61', '23-43', '1-8', '2-14', '3-60'] },
  { x: 341, gates: [63, 4, 11, 56, 33, 13, 46, 29, 9, 52], channels: ['4-63', '11-56', '13-33', '29-46', '9-52'] },
];

function assertAligned(incoming, outgoing, label, minimum = 0.999) {
  const lengths = Math.hypot(...incoming) * Math.hypot(...outgoing);
  assert.ok(lengths > 0, `${label} has nonzero tangents`);
  const alignment = incoming.reduce((sum, value, axis) => sum + value * outgoing[axis], 0) / lengths;
  assert.ok(alignment >= minimum, `${label} has no kink: alignment=${alignment}`);
}

function assertSmoothJoins(curves, label) {
  for (let i = 1; i < curves.length; i++) {
    const before = curves[i - 1], after = curves[i];
    assert.deepEqual(before[3], after[0], `${label} has no gap between segments`);
    assertAligned(before[3].map((value, axis) => value - before[2][axis]),
      after[1].map((value, axis) => value - after[0][axis]), `${label} join ${i}`);
  }
}

function edgeDistance(point, a, b) {
  const d = b.map((value, axis) => value - a[axis]);
  const lengthSquared = d[0] ** 2 + d[1] ** 2;
  const fraction = lengthSquared ? Math.max(0, Math.min(1,
    d.reduce((sum, value, axis) => sum + (point[axis] - a[axis]) * value, 0) / lengthSquared)) : 0;
  return distance(point, a.map((value, axis) => value + fraction * d[axis]));
}

function insidePolygon(point, points) {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const [ax, ay] = points[i], [bx, by] = points[j];
    if ((ay > point[1]) !== (by > point[1])
      && point[0] < (bx - ax) * (point[1] - ay) / (by - ay) + ax) inside = !inside;
  }
  return inside;
}

function samples(curve, count = 100) {
  return Array.from({ length: count + 1 }, (_, step) => {
    const t = step / count, u = 1 - t;
    return [0, 1].map(axis => u ** 3 * curve[0][axis] + 3 * u * u * t * curve[1][axis]
      + 3 * u * t * t * curve[2][axis] + t ** 3 * curve[3][axis]);
  });
}

function groups(markup, type) {
  return [...markup.matchAll(new RegExp(`<g\\s+data-type="${type}"\\s+data-id="([^"]+)"([^>]*)>([\\s\\S]*?)<\\/g>`, 'g'))]
    .map(([, id, attributes, content]) => ({ id, attributes, content }));
}

function strokePaths(content, color) {
  return [...content.matchAll(/<path\b([^>]*)\/>/g)]
    .map(([, attributes]) => attributes)
    .filter(attributes => attributes.includes(`stroke="${color}"`))
    .map(attributes => ({
      path: attributes.match(/\bd="([^"]+)"/)[1],
      width: Number(attributes.match(/stroke-width="([^"]+)"/)[1]),
    }));
}

function polylinePoints(path) {
  return [...path.matchAll(/[ML]\s*(-?[\d.]+)[,\s]+(-?[\d.]+)/g)]
    .map(([, x, y]) => [Number(x), Number(y)]);
}

function segmentCrossing(a, b, c, d) {
  const r = b.map((value, axis) => value - a[axis]), s = d.map((value, axis) => value - c[axis]);
  const cross = (u, v) => u[0] * v[1] - u[1] * v[0];
  const denominator = cross(r, s);
  if (Math.abs(denominator) < 1e-9) return null;
  const delta = c.map((value, axis) => value - a[axis]);
  const t = cross(delta, s) / denominator, u = cross(delta, r) / denominator;
  return t > 1e-6 && t < 1 - 1e-6 && u > 1e-6 && u < 1 - 1e-6
    ? a.map((value, axis) => value + t * r[axis]) : null;
}

test('canonical gate ownership and channel pairs survive every visual redesign', () => {
  assert.deepEqual(CENTERS.map(center => center.id).sort(), Object.keys(CENTER_GATES).sort());
  for (const [center, expected] of Object.entries(CENTER_GATES)) {
    assert.deepEqual(GATES.filter(gate => gate.center === center).map(gate => gate.id).sort((a, b) => a - b), expected,
      `${center} contains exactly its own gates, without omissions or additions`);
  }
  assert.deepEqual(CHANNELS.map(channel => channel.id).sort(), [...CHANNEL_PAIRS].sort());
});

test('three central rails align their own gates and fifteen separate straight canonical channels', () => {
  assert.equal(new Set(CENTRAL_RAILS.flatMap(rail => rail.gates)).size, 30);
  assert.equal(new Set(CENTRAL_RAILS.flatMap(rail => rail.channels)).size, 15);
  for (const rail of CENTRAL_RAILS) {
    for (const id of rail.gates) assert.equal(getGate(id).x, rail.x, `gate ${id} stays on the x=${rail.x} rail`);
    for (const id of rail.channels) {
      const channel = getChannel(id), endpoints = channel.gates.map(getGate);
      assert.equal(channel.curves.length, 1, `${id} is a single straight route`);
      assert.ok(channel.gates.every(gate => rail.gates.includes(gate)), `${id} connects only its real rail gates`);
      const curve = channel.curves[0], direction = Math.sign(endpoints[1].y - endpoints[0].y);
      for (const [index, point] of curve.entries()) {
        assert.equal(point[0], rail.x, `${id} has no sideways bow at control ${index}`);
        if (index) assert.ok((point[1] - curve[index - 1][1]) * direction > 0, `${id} is monotonic and cannot fold back`);
      }
    }
  }
  assert.equal(CENTRAL_RAILS[1].x - CENTRAL_RAILS[0].x, 21);
  assert.equal(CENTRAL_RAILS[2].x - CENTRAL_RAILS[1].x, 21);
});

test('rail alignment adjusts only the intended inner rows and preserves integration anchors', () => {
  for (const id of [47, 24, 4]) assert.equal(getGate(id).y, 156, `Ajna top gate ${id} keeps disc clearance`);
  for (const id of [17, 11]) assert.equal(getGate(id).y, 176.5, `Ajna lower gate ${id} stays distinct from the top row`);
  for (const id of [62, 23, 56]) assert.equal(getGate(id).y, 266.5, `throat top gate ${id} clears the side gates`);
  for (const [id, position] of [[10, [282.6, 436]], [20, [284, 302]], [34, [284, 566]], [57, [141, 563]]]) {
    const gate = getGate(id);
    assert.deepEqual([gate.x, gate.y], position, `integration gate ${id} was not moved by the rail alignment`);
  }
});

test('throat, sacral and root are ten percent narrower without changing their height or vertical position', () => {
  const previousVerticalBounds = { throat: [256, 352], sacral: [528, 624], root: [660, 756] };
  for (const [id, verticalBounds] of Object.entries(previousVerticalBounds)) {
    const points = polygon(getCenter(id));
    const xs = points.map(point => point[0]), ys = points.map(point => point[1]);
    const left = Math.min(...xs), right = Math.max(...xs), top = Math.min(...ys), bottom = Math.max(...ys);
    assert.ok(Math.abs(right - left - 93.6) < 1e-9, `${id} width is104 ×0.9`);
    assert.equal(bottom - top, 96, `${id} retains its height`);
    assert.equal((left + right) / 2, 320, `${id} stays centered onx320`);
    assert.deepEqual([top, bottom], verticalBounds, `${id} stays at the same height in the graph`);
  }
});

test('throat gates follow their own bottom, left and right edges in the requested order', () => {
  const boundary = polygon(getCenter('throat'));
  const xs = boundary.map(point => point[0]), ys = boundary.map(point => point[1]);
  const left = Math.min(...xs), right = Math.max(...xs), top = Math.min(...ys), bottom = Math.max(...ys);
  const expected = { bottom: [31, 8, 33], left: [16, 20], right: [35, 12, 45] };
  for (const [edge, ids] of Object.entries(expected)) {
    const gates = ids.map(getGate);
    const fixedAxis = edge === 'bottom' ? 'y' : 'x', varyingAxis = edge === 'bottom' ? 'x' : 'y';
    for (const gate of gates) {
      assert.equal(gate[fixedAxis], gates[0][fixedAxis], `${ids.join('/')} share the ${edge} edge row`);
      const clearances = { left: gate.x - left, right: right - gate.x, top: gate.y - top, bottom: bottom - gate.y };
      assert.equal(clearances[edge], Math.min(...Object.values(clearances)), `gate ${gate.id} belongs visually to ${edge}, not another edge`);
    }
    for (let i = 1; i < gates.length; i++) {
      assert.ok(gates[i][varyingAxis] > gates[i - 1][varyingAxis], `${ids.join('/')} follow their edge in order`);
    }
  }
  assert.equal(getGate(8).x, (left + right) / 2, 'gate 8 is centered in the lower throat row');
});

test('G center is uniformly enlarged by ten percent while staying on its previous center', () => {
  const points = polygon(getCenter('g'));
  const xs = points.map(point => point[0]), ys = points.map(point => point[1]);
  const width = Math.max(...xs) - Math.min(...xs), height = Math.max(...ys) - Math.min(...ys);
  assert.ok(Math.abs(width - 123.2) < 1e-9, 'G width is 112 × 1.1');
  assert.ok(Math.abs(height - 123.2) < 1e-9, 'G height is 112 × 1.1');
  assert.equal((Math.min(...xs) + Math.max(...xs)) / 2, 320);
  assert.equal((Math.min(...ys) + Math.max(...ys)) / 2, 436);
});

test('26–44 retains its approved curve controls with only gate 44 lowered alongside the spleen', () => {
  assert.equal(getChannel('26-44').path, PRESERVED_26_44_PATH);
  const markup = renderBodygraph();
  const channels = groups(markup, 'channel');
  assert.equal(channels[0].id, '26-44', 'the unchanged channel still paints underneath other channels');
  assert.ok(channels[0].content.includes(`d="${PRESERVED_26_44_PATH}"`));
});

test('50–27 and 6–59 are straight mirrored horizontal connections after lowering the side centers', () => {
  const left = getChannel('27-50'), right = getChannel('6-59');
  assert.equal(getGate(50).y, 588);
  assert.equal(getGate(6).y, 588);
  assert.equal(getGate(27).y, 588);
  assert.equal(getGate(59).y, 588);
  for (const channel of [left, right]) {
    const [start, end] = channel.gates.map(getGate);
    for (const curve of channel.curves) for (const point of curve) {
      assert.equal(point[1], 588, `${channel.id} has no vertical bend`);
      assert.ok(point[0] >= Math.min(start.x, end.x) && point[0] <= Math.max(start.x, end.x), `${channel.id} cannot overshoot its gates`);
    }
  }
  const leftEnds = left.gates.map(getGate).map(gate => [640 - gate.x, gate.y]);
  const rightEnds = right.gates.map(getGate).map(gate => [gate.x, gate.y]);
  assert.deepEqual(leftEnds, rightEnds);
});

test('each gate disc fits inside its own center and cannot overlap another gate disc', () => {
  for (const gate of GATES) {
    const point = [gate.x, gate.y], boundary = polygon(getCenter(gate.center));
    assert.ok(insidePolygon(point, boundary), `gate ${gate.id} is inside ${gate.center}`);
    const clearance = Math.min(...boundary.map((a, i) => edgeDistance(point, a, boundary[(i + 1) % boundary.length])));
    assert.ok(clearance >= 9.5, `gate ${gate.id} disc must fit in ${gate.center}, clearance=${clearance}`);
  }
  for (let i = 0; i < GATES.length; i++) for (let j = i + 1; j < GATES.length; j++) {
    assert.ok(distance([GATES[i].x, GATES[i].y], [GATES[j].x, GATES[j].y]) >= 20,
      `gate discs ${GATES[i].id} and ${GATES[j].id} remain distinct`);
  }
});

test('rendered gate labels and disc anchors exactly match their topology coordinates', () => {
  const markup = renderBodygraph({ personality: GATES.map(gate => gate.id), design: GATES.map(gate => gate.id) });
  const rendered = groups(markup, 'gate');
  assert.equal(rendered.length, 64);
  assert.equal(new Set(rendered.map(gate => gate.id)).size, 64);
  for (const { id, attributes, content } of rendered) {
    const gate = getGate(id);
    assert.ok(attributes.includes(`transform="translate(${gate.x} ${gate.y})"`), `gate ${id} anchor`);
    assert.equal((content.match(/class="bg-gate-disc"/g) || []).length, 1, `gate ${id} has one disc`);
    const labels = [...content.matchAll(/<text\b[^>]*>([^<]*)<\/text>/g)].map(match => match[1]);
    assert.deepEqual(labels, [id], `gate ${id} has exactly its own number`);
  }
});

test('all channel curves terminate at their own gates and multi-curve joins are smooth', () => {
  for (const channel of CHANNELS) {
    const [start, end] = channel.gates.map(getGate);
    assert.deepEqual(channel.curves[0][0], [start.x, start.y], `${channel.id} starts at ${start.id}`);
    assert.deepEqual(channel.curves.at(-1).at(-1), [end.x, end.y], `${channel.id} ends at ${end.id}`);
    for (const curve of channel.curves) {
      assert.equal(curve.length, 4);
      assert.ok(curve.flat().every(Number.isFinite), `${channel.id} has finite controls`);
    }
    assertSmoothJoins(channel.curves, channel.id);
  }
});

test('ordinary rendered channel outlines use the exact topology route and avoid unrelated centers', () => {
  const markup = renderBodygraph();
  const rendered = groups(markup, 'channel');
  for (const channel of ordinaryChannels) {
    const content = rendered.find(item => item.id === channel.id)?.content;
    assert.ok(content?.includes(`class="bg-channel-outline" d="${channel.path}"`), `${channel.id} renders its topology route`);
    const owners = channel.gates.map(id => getGate(id).center);
    for (const center of CENTERS.filter(center => !owners.includes(center.id))) {
      const boundary = polygon(center);
      for (const point of channel.curves.flatMap(curve => samples(curve))) {
        assert.ok(!insidePolygon(point, boundary), `${channel.id} must not cross through ${center.id}`);
      }
    }
  }
});

test('red and black halves belong to the correct endpoint and dual activations stay in parallel lanes', () => {
  for (const channel of ordinaryChannels) {
    const [first, second] = channel.gates.map(getGate);
    const singleMarkup = renderBodygraph({ personality: [first.id], design: [second.id] });
    const single = groups(singleMarkup, 'channel').find(item => item.id === channel.id).content;
    const black = strokePaths(single, '#202020'), red = strokePaths(single, '#c32d35');
    assert.equal(black.length, 1, `${channel.id} has one black half`);
    assert.equal(red.length, 1, `${channel.id} has one red half`);
    const blackPoints = polylinePoints(black[0].path), redPoints = polylinePoints(red[0].path);
    assert.deepEqual(blackPoints[0], [first.x, first.y], `${channel.id} black starts at personality gate`);
    assert.deepEqual(redPoints.at(-1), [second.x, second.y], `${channel.id} red ends at design gate`);
    assert.deepEqual(blackPoints.at(-1), redPoints[0], `${channel.id} color halves meet without a gap`);

    const dualMarkup = renderBodygraph({ personality: channel.gates, design: channel.gates });
    const dual = groups(dualMarkup, 'channel').find(item => item.id === channel.id).content;
    const blackLanes = strokePaths(dual, '#202020'), redLanes = strokePaths(dual, '#c32d35');
    assert.equal(blackLanes.length, 2);
    assert.equal(redLanes.length, 2);
    for (let half = 0; half < 2; half++) {
      assert.equal(blackLanes[half].width, redLanes[half].width, `${channel.id} both sources have equal lane width`);
      assert.ok(blackLanes[half].width < black[0].width, `${channel.id} dual lanes are not drawn over each other`);
      const blackPoints = polylinePoints(blackLanes[half].path), redPoints = polylinePoints(redLanes[half].path);
      assert.equal(blackPoints.length, redPoints.length);
      for (let i = 0; i < blackPoints.length; i++) {
        const separation = distance(blackPoints[i], redPoints[i]);
        assert.ok(Math.abs(separation - 3.168) < 0.015, `${channel.id} dual lanes stay separated at sample ${i}`);
      }
      const endpoint = half ? blackPoints.length - 1 : 0;
      const center = blackPoints[endpoint].map((value, axis) => (value + redPoints[endpoint][axis]) / 2);
      const gate = half ? second : first;
      assert.ok(distance(center, [gate.x, gate.y]) < 0.015, `${channel.id} dual lanes center on gate ${gate.id}`);
    }
  }
});

test('integration is drawn once with exactly four arms and six logical connections', () => {
  const markup = renderBodygraph({ personality: INTEGRATION_GATES, design: INTEGRATION_GATES });
  assert.equal((markup.match(/data-junction="integration"/g) || []).length, 1);
  const arms = [...markup.matchAll(/<g class="bg-integration-arm" data-arm="(\d+)"[^>]*>([\s\S]*?)<\/g>/g)];
  assert.deepEqual(arms.map(match => Number(match[1])).sort((a, b) => a - b), INTEGRATION_GATES);
  const channels = groups(markup, 'channel').filter(item => item.attributes.includes('data-integration="true"'));
  assert.equal(channels.length, 6);
  for (const channel of channels) assert.doesNotMatch(channel.content, /class="bg-channel-outline"/, 'integration connections must not paint six duplicate routes');
  for (const [, gateId, content] of arms) {
    const black = strokePaths(content, '#202020'), red = strokePaths(content, '#c32d35');
    assert.equal(black.length, 1, `integration gate ${gateId} has one black lane`);
    assert.equal(red.length, 1, `integration gate ${gateId} has one red lane`);
    const endpoint = INTEGRATION_ARMS.find(arm => arm.gate === Number(gateId)).reversePaint ? -1 : 0;
    const a = polylinePoints(black[0].path).at(endpoint), b = polylinePoints(red[0].path).at(endpoint);
    const gate = getGate(gateId);
    assert.ok(distance(a.map((value, axis) => (value + b[axis]) / 2), [gate.x, gate.y]) < 0.015,
      `integration arm ${gateId} starts at its gate`);
  }
});

test('integration branches meet a single stem tangentially and clear unrelated centers', () => {
  assert.deepEqual(INTEGRATION_ARMS.map(arm => arm.gate).sort((a, b) => a - b), INTEGRATION_GATES);
  assert.ok(STEM_POINTS.length >= 2);
  assert.ok(distance(STEM_POINTS[0], STEM_POINTS.at(-1)) > 20, 'the shared stem is not collapsed into a point');
  assert.ok(STEM_POINTS.flat().every(Number.isFinite));
  for (const arm of INTEGRATION_ARMS) {
    const gate = getGate(arm.gate);
    const curves = arm.curves || [arm.curve], lastCurve = curves.at(-1);
    assert.deepEqual(curves[0][0], [gate.x, gate.y], `arm ${gate.id} begins at its own gate`);
    assert.deepEqual(lastCurve[3], arm.end, `arm ${gate.id} ends at the stem`);
    assertSmoothJoins(curves, `integration arm ${gate.id}`);
    const atStart = distance(STEM_POINTS[0], arm.end) < 1e-9;
    assert.ok(atStart || distance(STEM_POINTS.at(-1), arm.end) < 1e-9, `arm ${gate.id} connects to an existing stem junction`);
    const tangent = lastCurve[3].map((value, axis) => value - lastCurve[2][axis]);
    const neighbor = atStart ? STEM_POINTS.find(point => distance(point, arm.end) > 1e-9)
      : [...STEM_POINTS].reverse().find(point => distance(point, arm.end) > 1e-9);
    const stemTangent = neighbor.map((value, axis) => value - arm.end[axis]);
    assertAligned(tangent, stemTangent, `arm ${gate.id} joins the curved stem`, 0.998);
    for (const center of CENTERS.filter(center => center.id !== gate.center)) {
      const boundary = polygon(center);
      for (const point of curves.flatMap(curve => samples(curve))) {
        assert.ok(!insidePolygon(point, boundary), `arm ${gate.id} must not enter ${center.id}`);
        const clearance = Math.min(...boundary.map((a, i) => edgeDistance(point, a, boundary[(i + 1) % boundary.length])));
        assert.ok(clearance >= 8, `arm ${gate.id} needs selection clearance from ${center.id}: ${clearance}`);
      }
    }
  }
  for (const center of CENTERS) {
    const boundary = polygon(center);
    for (const point of STEM_POINTS) {
      assert.ok(!insidePolygon(point, boundary), `shared stem must not enter ${center.id}`);
      const clearance = Math.min(...boundary.map((a, i) => edgeDistance(point, a, boundary[(i + 1) % boundary.length])));
      assert.ok(clearance >= 8, `shared stem needs selection clearance from ${center.id}: ${clearance}`);
    }
  }
});

test('integration arms do not cross each other away from the shared stem junctions', () => {
  const routes = INTEGRATION_ARMS.map(arm => ({ gate: arm.gate,
    points: (arm.curves || [arm.curve]).flatMap(curve => samples(curve, 80)) }));
  for (let a = 0; a < routes.length; a++) for (let b = a + 1; b < routes.length; b++) {
    const first = routes[a], second = routes[b];
    for (let i = 1; i < first.points.length; i++) for (let j = 1; j < second.points.length; j++) {
      const crossing = segmentCrossing(first.points[i - 1], first.points[i], second.points[j - 1], second.points[j]);
      if (!crossing) continue;
      const junctionDistance = Math.min(distance(crossing, STEM_POINTS[0]), distance(crossing, STEM_POINTS.at(-1)));
      assert.ok(junctionDistance <= 8, `arms ${first.gate}/${second.gate} cross outside their shared junction at ${crossing}`);
    }
  }
});

test('black and red integration lanes keep their side across the curved stem joins', () => {
  const markup = renderBodygraph({ personality: INTEGRATION_GATES, design: INTEGRATION_GATES });
  const region = markup.slice(markup.indexOf('data-junction="integration"'), markup.indexOf('<g class="bodygraph-centers">'));
  const paths = [...region.matchAll(/<path\b([^>]*)\/>/g)].map(([, attributes]) => attributes)
    .filter(attributes => attributes.includes('stroke="#202020"') || attributes.includes('stroke="#c32d35"'))
    .map(attributes => polylinePoints(attributes.match(/\bd="([^"]+)"/)[1]));
  assert.equal(paths.length, 12, 'four dual-color arms and two dual-color stem halves');
  for (const [index, arm] of INTEGRATION_ARMS.entries()) {
    const branchEnd = arm.reversePaint ? 0 : -1;
    const stemIndex = arm.reversePaint ? 10 : 8;
    const stemEnd = arm.reversePaint ? -1 : 0;
    for (const color of [0, 1]) {
      const gap = distance(paths[index * 2 + color].at(branchEnd), paths[stemIndex + color].at(stemEnd));
      assert.ok(gap <= 0.12, `arm ${arm.gate} keeps ${color ? 'red' : 'black'} on the same side, seam=${gap}`);
    }
  }
  for (const color of [0, 1]) assert.ok(distance(paths[8 + color].at(-1), paths[10 + color][0]) <= 0.02,
    'the two colored stem halves meet without a pinch or swap');
});

test('branch 34 crosses 26–44 only once at a clear angle without following it', () => {
  const arm = INTEGRATION_ARMS.find(arm => arm.gate === 34);
  const branch = arm.curves.flatMap(curve => samples(curve, 200));
  const channel = getChannel('26-44').curves.flatMap(curve => samples(curve, 200));
  const crossings = [];
  for (let i = 1; i < branch.length; i++) for (let j = 1; j < channel.length; j++) {
    const point = segmentCrossing(branch[i - 1], branch[i], channel[j - 1], channel[j]);
    if (!point) continue;
    const a = branch[i].map((value, axis) => value - branch[i - 1][axis]);
    const b = channel[j].map((value, axis) => value - channel[j - 1][axis]);
    const alignment = Math.abs(a[0] * b[0] + a[1] * b[1]) / (Math.hypot(...a) * Math.hypot(...b));
    const angle = Math.acos(Math.min(1, alignment)) * 180 / Math.PI;
    crossings.push({ point, angle });
  }
  assert.equal(crossings.length, 1, 'one overpass, with 26–44 underneath');
  assert.ok(crossings[0].angle >= 60, `the crossing is distinct, angle=${crossings[0].angle}`);
  let closeRun = 0;
  for (let i = 1; i < branch.length; i++) {
    const nearest = Math.min(...channel.slice(1).map((end, j) => edgeDistance(branch[i], channel[j], end)));
    if (nearest < 8.448) closeRun += distance(branch[i], branch[i - 1]);
  }
  assert.ok(closeRun < 20, `the branch does not visually merge with 26–44 over a long run: ${closeRun}`);
});

test('outer 16–48 and 35–36 channels are exact mirrored curves', () => {
  const left = getChannel('16-48').curves, right = getChannel('35-36').curves;
  assert.equal(left.length, right.length);
  for (let i = 0; i < left.length; i++) for (let j = 0; j < 4; j++) {
    assert.ok(Math.abs(left[i][j][0] + right[i][j][0] - 640) < 1e-9, `curve ${i} point ${j} mirrors across x320`);
    assert.equal(left[i][j][1], right[i][j][1]);
  }
});

test('displayed integration route 20–57 follows the mirrored 12–22 sweep without shortcutting the stem', () => {
  const markup = renderBodygraph();
  const path = markup.match(/<path class="bg-integration-focus" data-highlight-channel="20-57" d="([^"]+)"/)?.[1];
  assert.ok(path, 'the 20–57 focus route is present in the separate integration highlight layer');
  const route = polylinePoints(path);
  const mirrored = getChannel('12-22').curves.flatMap(curve => samples(curve, 400)).map(([x, y]) => [640 - x, y]);
  for (const point of route) {
    const gap = Math.min(...mirrored.slice(1).map((end, i) => edgeDistance(point, mirrored[i], end)));
    assert.ok(gap <= 0.06, `20–57 shares the opposite outer channel's exact sweep: deviation=${gap}`);
  }
  assert.ok(route.length >= 40, 'the whole curved stem participates in the route');
});

test('integration channel focus routes preserve both gate arms and their shared connection', () => {
  const markup = renderBodygraph();
  for (const channel of CHANNELS.filter(channel => channel.gates.every(id => INTEGRATION_GATES.includes(id)))) {
    const path = markup.match(new RegExp(`<path class="bg-integration-focus" data-highlight-channel="${channel.id}" d="([^"]+)"`))?.[1];
    assert.ok(path, `${channel.id} has a focus route in the separate integration highlight layer`);
    const parts = path.match(/M[^M]+/g).map(part => part.trim());
    const arms = channel.gates.map(gate => INTEGRATION_ARMS.find(arm => arm.gate === gate));
    for (const [index, gateId] of channel.gates.entries()) {
      const gate = getGate(gateId);
      assert.equal(parts[index], arms[index].path, `${channel.id} preserves the complete arm of gate ${gateId}`);
      assert.deepEqual(polylinePoints(parts[index])[0], [gate.x, gate.y], `${channel.id} reaches gate ${gateId}`);
    }
    const crossesStem = arms[0].end !== arms[1].end;
    assert.equal(parts.length, crossesStem ? 3 : 2, `${channel.id} uses only its own components`);
    if (crossesStem) {
      const points = polylinePoints(parts[2]);
      assert.equal(points.length, STEM_POINTS.length);
      for (const [index, point] of points.entries()) {
        assert.ok(distance(point, STEM_POINTS[index]) < 0.01, `${channel.id} follows the unchanged connecting stem`);
      }
    } else {
      assert.deepEqual(arms[0].end, arms[1].end, `${channel.id} meets at the same attachment`);
    }
  }
});

test('an integration activation never colors a different gate arm', () => {
  for (const activeGate of INTEGRATION_GATES) for (const source of ['personality', 'design']) {
    const markup = renderBodygraph({ [source]: [activeGate] });
    const arms = [...markup.matchAll(/<g class="bg-integration-arm" data-arm="(\d+)"[^>]*>([\s\S]*?)<\/g>/g)];
    for (const [, gateId, content] of arms) {
      const black = strokePaths(content, '#202020'), red = strokePaths(content, '#c32d35');
      const isActive = Number(gateId) === activeGate;
      assert.equal(black.length, Number(isActive && source === 'personality'), `personality belongs only to arm ${activeGate}`);
      assert.equal(red.length, Number(isActive && source === 'design'), `design belongs only to arm ${activeGate}`);
    }
  }
});
