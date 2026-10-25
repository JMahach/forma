import { CHANNELS, getGate, getChannel, getCenter } from './chart-geometry.ts';
import { CENTER_STROKE } from './drawing-presentation.ts';
import { INTEGRATION_IDS } from '../../domain/topology.ts';
import { INTEGRATION_ARMS as ARM_GEOMETRY, STEM_POINTS, sampleBezier } from './integration-geometry.ts';

// Geometry-only preparation: cached paths never depend on selection or paint.
export const pointString = (points: number[][]) => points.map(([x, y], index) => `${index ? 'L' : 'M'}${x.toFixed(2)},${y.toFixed(2)}`).join(' ');

// Small true corner radii soften the silhouette without distorting the polygons
// or moving the gate anchors. Geometry remains independent of activation data.
function roundedCenterCorners(points: string, radius = 6) {
  const vertices = points.split(' ').map(pair => pair.split(',').map(Number));
  const toward = (from: number[], to: number[]) => {
    const length = Math.hypot(to[0] - from[0], to[1] - from[1]);
    const distance = Math.min(radius, length / 4);
    return from.map((value, axis) => value + (to[axis] - value) / length * distance);
  };
  return vertices.map((vertex, index) => {
    const entry = toward(vertex, vertices[(index + vertices.length - 1) % vertices.length]);
    const exit = toward(vertex, vertices[(index + 1) % vertices.length]);
    return { entry, vertex, exit };
  });
}

export function roundedCenter(points: string, radius = 6) {
  return roundedCenterCorners(points, radius).map(({ entry, vertex, exit }, index) =>
    `${index ? 'L' : 'M'} ${entry.join(' ')} Q ${vertex.join(' ')} ${exit.join(' ')}`
  ).join(' ') + ' Z';
}

function splitAtLength(points: number[][], midpoint: number) {
  const distinct = (items: number[][]) => items.filter((point, index) => !index
    || Math.hypot(point[0] - items[index - 1][0], point[1] - items[index - 1][1]) > 1e-7);
  const lengths = points.slice(1).map((point, index) => Math.hypot(point[0] - points[index][0], point[1] - points[index][1]));
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

export function splitAtHalfLength(points: number[][]) {
  const length = points.slice(1).reduce((sum, point, index) =>
    sum + Math.hypot(point[0] - points[index][0], point[1] - points[index][1]), 0);
  return splitAtLength(points, length / 2);
}

// Intersect a vertical rail with the same rounded silhouette that is rendered.
// Sampling only the small corners also handles the G-center's rounded tips;
// using the raw diamond vertices would leave its middle channels unequal.
function centerVerticalBounds(points: string, x: number) {
  const outline = roundedCenterCorners(points).flatMap(({ entry, vertex, exit }) =>
    Array.from({ length: 33 }, (_, index) => {
      const t = index / 32, u = 1 - t;
      return [0, 1].map(axis => u * u * entry[axis] + 2 * u * t * vertex[axis] + t * t * exit[axis]);
    }));
  const crossings = outline.flatMap((a, index) => {
    const b = outline[(index + 1) % outline.length], dx = b[0] - a[0], dy = b[1] - a[1];
    if (Math.abs(dx) < 1e-9) return [];
    const t = (x - a[0]) / dx;
    if (t < 0 || t > 1) return [];
    // Include the visible center stroke; a diagonal side covers more of a
    // vertical rail than a horizontal side with the same stroke width.
    const strokeY = CENTER_STROKE / 2 * Math.hypot(dx, dy) / Math.abs(dx);
    return [{ y: a[1] + t * dy, strokeY }];
  });
  return [Math.min(...crossings.map(({ y, strokeY }) => y - strokeY)),
    Math.max(...crossings.map(({ y, strokeY }) => y + strokeY))];
}

function splitChannel(channel: typeof CHANNELS[number]) {
  const points = channel.curves.flatMap((curve, index) => sampleBezier(curve).slice(index ? 1 : 0));
  const [start, end] = channel.gates.map(id => getGate(id)!);
  // Only the six straight G ↔ throat/sacral routes change their division.
  // Other channels and the separate integration geometry keep their seams.
  const centers = [start.center, end.center];
  if (start.x !== end.x || !centers.includes('g')
    || !centers.some(center => center === 'throat' || center === 'sacral')) return splitAtHalfLength(points);
  const down = end.y > start.y;
  const startEdge = centerVerticalBounds(getCenter(start.center)!.points, start.x)[down ? 1 : 0];
  const endEdge = centerVerticalBounds(getCenter(end.center)!.points, end.x)[down ? 0 : 1];
  return splitAtLength(points, Math.abs((startEdge + endEdge) / 2 - start.y));
}

export function offsetPoints(points: number[][], offset: number) {
  return points.map(([x, y], index) => {
    const before = points[Math.max(0, index - 1)], after = points[Math.min(points.length - 1, index + 1)];
    const dx = after[0] - before[0], dy = after[1] - before[1];
    const length = Math.hypot(dx, dy) || 1;
    return [x - dy / length * offset, y + dx / length * offset];
  });
}

// Ordinary channels use two halves; integration uses its own arms and stem.
// Geometry is cached, so selection changes do not resample these curves.
export const channelHalves = new Map(CHANNELS.filter(channel => !INTEGRATION_IDS.has(channel.id))
  .map(channel => [channel.id, splitChannel(channel)]));
// 26–44 crosses the central routes behind every other channel, including integration.
export const paintOrder = [CHANNELS.find(channel => channel.id === '26-44')!, ...CHANNELS.filter(channel => channel.id !== '26-44')];

// Integration is a shared anatomical stem with two spaced branch attachments.
// There is no central dot, radial menu, or additional Center.
export const INTEGRATION_ARMS = ARM_GEOMETRY.map(arm => ({ ...arm, points: sampleBezier(arm.curve) }));
export const STEM_PATH = pointString(STEM_POINTS);
export const INTEGRATION_PATH = [...INTEGRATION_ARMS.map(({ path }) => path), STEM_PATH].join(' ');
// Ownership is a side of the existing outer curve, not an expanded neighbor
// stroke. Inner arms can meet the physical channel without leaking to its far side.
export const INTEGRATION_INNER_SIDE = `${getChannel('20-57')!.path} L ${getGate(57)!.x} 820 L 640 820 L 640 0 L ${getGate(20)!.x} 0 Z`;
export const INTEGRATION_OUTER_SIDE = `${getChannel('20-57')!.path} L ${getGate(57)!.x} 820 L 0 820 L 0 0 L ${getGate(20)!.x} 0 Z`;
export const integrationOuterOwnership = [20, 57].map(gate => {
  const neighbor = INTEGRATION_ARMS.find(arm => arm.gate === (gate === 20 ? 10 : 34))!;
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
  const point = (side: number, back: number) => end.map((value, axis) => value + side * extent * normal[axis] - back * extent * tangent[axis]);
  return { gate: arm.gate, polygon: [point(-1, 0), point(1, 0), point(1, 1), point(-1, 1)].map(p => p.map(value => value.toFixed(6)).join(',')).join(' ') };
});

export function integrationRoute(gates: readonly number[]) {
  const first = INTEGRATION_ARMS.find(({ gate }) => gate === gates[0])!;
  const second = INTEGRATION_ARMS.find(({ gate }) => gate === gates[1])!;
  // Separate subpaths preserve the authored curves without inventing a rounded
  // reversal join at a fork. Only routes crossing the node include its stem.
  return [first.path, second.path, ...(first.end !== second.end ? [STEM_PATH] : [])].join(' ');
}
