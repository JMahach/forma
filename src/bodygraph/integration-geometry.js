import { getGate, getChannel } from './graph-data.js';

export const INTEGRATION_IDS = new Set(['10-20', '20-34', '20-57', '10-34', '10-57', '34-57']);
const mix = (a, b, t) => a.map((value, axis) => value + (b[axis] - value) * t);
function split(curve, t) {
  const a = mix(curve[0], curve[1], t), b = mix(curve[1], curve[2], t), c = mix(curve[2], curve[3], t);
  const d = mix(a, b, t), e = mix(b, c, t), middle = mix(d, e, t);
  return [[curve[0], a, d, middle], [middle, e, c, curve[3]]];
}
export const sampleBezier = curve => Array.from({ length: 49 }, (_, i) => {
  const t = i / 48, u = 1 - t;
  return [0, 1].map(axis => u ** 3 * curve[0][axis] + 3 * u * u * t * curve[1][axis]
    + 3 * u * t * t * curve[2][axis] + t ** 3 * curve[3][axis]);
});

// Split one outer contour into a shared curved stem. Its complete 20–57 route
// exactly mirrors 12–22, with no overlaid channels or changes in curvature.
const [upper, remainder] = split(getChannel('20-57').curve, 0.60);
const [stem, lower] = split(remainder, (0.77 - 0.60) / (1 - 0.60));
export const STEM_POINTS = sampleBezier(stem);

function branch(gate, end, stemTangent, backwards = false) {
  const { x, y } = getGate(gate);
  const length = Math.hypot(...stemTangent);
  const direction = stemTangent.map(value => value / length);
  const lastControl = end.map((value, axis) => value + direction[axis] * (backwards ? 36 : -28));
  return [[x, y], [x - (backwards ? 64 : 54), y], lastControl, end];
}
const top = STEM_POINTS[0], bottom = STEM_POINTS.at(-1);
const topTangent = stem[1].map((value, axis) => value - stem[0][axis]);
const bottomTangent = stem[3].map((value, axis) => value - stem[2][axis]);

export const INTEGRATION_ARMS = [
  { gate: 20, end: top, curve: upper, reversePaint: false },
  { gate: 10, end: top, curve: branch(10, top, topTangent), reversePaint: false },
  { gate: 34, end: bottom, curve: branch(34, bottom, bottomTangent, true), reversePaint: true },
  { gate: 57, end: bottom, curve: [...lower].reverse(), reversePaint: true },
].map(arm => ({ ...arm, curves: [arm.curve], path: `M ${arm.curve[0].join(' ')} C ${arm.curve.slice(1).flat().join(' ')}` }));
