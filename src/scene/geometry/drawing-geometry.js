import { CHANNELS, getGate, getChannel } from './chart-geometry.js';
import { INTEGRATION_IDS } from '../../domain/topology.js';
import { INTEGRATION_ARMS as ARM_GEOMETRY, STEM_POINTS, sampleBezier } from './integration-geometry.js';

// Geometry-only preparation: cached paths never depend on selection or paint.
export const pointString = (points) => points.map(([x, y], index) => `${index ? 'L' : 'M'}${x.toFixed(2)},${y.toFixed(2)}`).join(' ');

// Small true corner radii soften the silhouette without distorting the polygons
// or moving the gate anchors. Geometry remains independent of activation data.
export function roundedCenter(points, radius = 6) {
  const vertices = points.split(' ').map(pair => pair.split(',').map(Number));
  const toward = (from, to) => {
    const length = Math.hypot(to[0] - from[0], to[1] - from[1]);
    const distance = Math.min(radius, length / 4);
    return from.map((value, axis) => value + (to[axis] - value) / length * distance);
  };
  return vertices.map((vertex, index) => {
    const entry = toward(vertex, vertices[(index + vertices.length - 1) % vertices.length]);
    const exit = toward(vertex, vertices[(index + 1) % vertices.length]);
    return `${index ? 'L' : 'M'} ${entry.join(' ')} Q ${vertex.join(' ')} ${exit.join(' ')}`;
  }).join(' ') + ' Z';
}

export function splitAtHalfLength(points) {
  const distinct = items => items.filter((point, index) => !index
    || Math.hypot(point[0] - items[index - 1][0], point[1] - items[index - 1][1]) > 1e-7);
  const lengths = points.slice(1).map((point, index) => Math.hypot(point[0] - points[index][0], point[1] - points[index][1]));
  const midpoint = lengths.reduce((sum, length) => sum + length, 0) / 2;
  let distance = 0;
  for (let index = 0; index < lengths.length; index += 1) {
    if (distance + lengths[index] >= midpoint) {
      const fraction = lengths[index] ? (midpoint - distance) / lengths[index] : 0;
      const middle = points[index].map((value, axis) => value + (points[index + 1][axis] - value) * fraction);
      // An exact sampled midpoint must occur only once. Duplicate points create
      // a zero-length normal and pinch the red/black lanes at their seam.
      return [distinct([...points.slice(0, index + 1), middle]), distinct([middle, ...points.slice(index + 1)])];
    }
    distance += lengths[index];
  }
  return [points, points.slice(-1)];
}

export function offsetPoints(points, offset) {
  return points.map(([x, y], index) => {
    const before = points[Math.max(0, index - 1)], after = points[Math.min(points.length - 1, index + 1)];
    const dx = after[0] - before[0], dy = after[1] - before[1];
    const length = Math.hypot(dx, dy) || 1;
    return [x - dy / length * offset, y + dx / length * offset];
  });
}

// Ordinary channels use two halves; integration uses its own arms and stem.
// Geometry is cached, so selection changes do not resample these curves.
export const channelHalves = new Map(CHANNELS.filter(channel => !INTEGRATION_IDS.has(channel.id)).map((channel) => [channel.id, splitAtHalfLength(
  channel.curves.flatMap((curve, index) => sampleBezier(curve).slice(index ? 1 : 0))
)]));
// 26–44 crosses the central routes behind every other channel, including integration.
export const paintOrder = [CHANNELS.find(channel => channel.id === '26-44'), ...CHANNELS.filter(channel => channel.id !== '26-44')];

// Integration is a shared anatomical stem with two spaced branch attachments.
// There is no central dot, radial menu, or additional Center.
export const INTEGRATION_ARMS = ARM_GEOMETRY.map(arm => ({ ...arm, points: sampleBezier(arm.curve) }));
export const STEM_PATH = pointString(STEM_POINTS);
export const INTEGRATION_PATH = [...INTEGRATION_ARMS.map(({ path }) => path), STEM_PATH].join(' ');
// Ownership is a side of the existing outer curve, not an expanded neighbor
// stroke. Inner arms can meet the physical channel without leaking to its far side.
export const INTEGRATION_INNER_SIDE = `${getChannel('20-57').path} L ${getGate(57).x} 820 L 640 820 L 640 0 L ${getGate(20).x} 0 Z`;
export const INTEGRATION_OUTER_SIDE = `${getChannel('20-57').path} L ${getGate(57).x} 820 L 0 820 L 0 0 L ${getGate(20).x} 0 Z`;
export const integrationOuterOwnership = [20, 57].map(gate => {
  const neighbor = INTEGRATION_ARMS.find(arm => arm.gate === (gate === 20 ? 10 : 34));
  const boundary = gate === 20 ? 0 : 820;
  // On the inner/right side, stop at the neighboring branch rather than
  // reappearing beyond it. The outer/left side stays free until the paint cut.
  return { gate, path: `${neighbor.path} L 0 ${neighbor.end[1]} L 0 ${boundary} L 640 ${boundary} L 640 ${neighbor.curve[0][1]} Z` };
});
export const integrationEndPlanes = INTEGRATION_ARMS.filter(({ gate }) => gate === 20 || gate === 57).map(arm => {
  // Match the actual, two-decimal sampled black/red paint, including its last
  // segment normal. The authored cubic has a slightly different end tangent.
  const [before, end] = arm.points.slice(-2).map(point => point.map(value => Number(value.toFixed(2))));
  const dx = end[0] - before[0], dy = end[1] - before[1], length = Math.hypot(dx, dy);
  const tangent = [dx / length, dy / length], normal = [-tangent[1], tangent[0]], extent = 2000;
  const point = (side, back) => end.map((value, axis) => value + side * extent * normal[axis] - back * extent * tangent[axis]);
  return { gate: arm.gate, polygon: [point(-1, 0), point(1, 0), point(1, 1), point(-1, 1)].map(p => p.map(value => value.toFixed(6)).join(',')).join(' ') };
});

export function integrationRoute(gates) {
  const first = INTEGRATION_ARMS.find(({ gate }) => gate === gates[0]);
  const second = INTEGRATION_ARMS.find(({ gate }) => gate === gates[1]);
  // Separate subpaths preserve the authored curves without inventing a rounded
  // reversal join at a fork. Only routes crossing the node include its stem.
  return [first.path, second.path, ...(first.end !== second.end ? [STEM_PATH] : [])].join(' ');
}
