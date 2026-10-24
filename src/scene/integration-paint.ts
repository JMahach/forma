import type { RenderState } from './render-state.ts';
import { INTEGRATION_ARMS, splitAtHalfLength, pointString, offsetPoints } from './geometry/drawing-geometry.ts';
import { STEM_POINTS } from './geometry/integration-geometry.ts';
import { paintGateActivation, CHANNEL_WIDTH, activationLaneColor } from './bodygraph-paint.ts';

// Shared color owner for static SVG, thumbnails and persistent scene updates.
// Each arm flows into its half-stem in ONE path. There is no butt-cut at the fork.
// Draw low priority first: red, black, dual. Empty arms never cover active paint.
export function integrationLayers(state: RenderState) {
  const halves = splitAtHalfLength(STEM_POINTS);
  const priority = (gate: number) => {
    const mask = state.overlaySources?.masks.get(gate) || 0;
    return state.overlaySources ? (mask & 12 ? 2 : 0) + (mask & 3 ? 1 : 0)
      : (state.personality.has(gate) ? 2 : 0) + (state.design.has(gate) ? 1 : 0);
  };
  const active = (gate: number) => priority(gate) > 0;
  const crosses = [20, 10].some(active) && [34, 57].some(active);
  return INTEGRATION_ARMS.filter(({ gate }) => active(gate)).map(arm => {
    const top = arm.gate === 20 || arm.gate === 10;
    const rank = priority(arm.gate);
    const points = top ? arm.points.map(p => [...p]) : [...arm.points].reverse().map(p => [...p]);
    if (crosses) {
      if (top) points.push(...halves[0].slice(1));
      else points.unshift(...halves[1].slice(0, -1));
    }
    // A tiny underlap closes raster antialiasing at the terminal meeting plane.
    // It does not widen the rails or change the curve/branch coordinates.
    const end = top ? points.length - 1 : 0;
    const neighbor = top ? end - 1 : 1;
    const a = points[end], b = points[neighbor], length = Math.hypot(a[0] - b[0], a[1] - b[1]);
    if (INTEGRATION_ARMS.filter(arm => active(arm.gate)).length > 1) points[end] = a.map((v, i) => v + (v - b[i]) / length * .035);
    return { gate: arm.gate, rank, points };
  }).sort((a, b) => a.rank - b.rank);
}
export function paintIntegrationLayers(state: RenderState) {
  const layers = integrationLayers(state);
  const mono = layers.filter(layer => layer.rank < 3).map(({ gate, rank, points }) =>
    `<g data-integration-layer="${gate}" data-rank="${rank}">${paintGateActivation(points, state, gate)}</g>`).join('');
  const dual = layers.filter(layer => layer.rank === 3);
  // Equal-priority dual branches share color passes: every red half is below
  // every black half, including where two different branches intersect.
  const lanes = [1, 0].map(lane => dual.map(({ gate, rank, points }) => {
    const width = lane === 0 ? CHANNEL_WIDTH.firstLane : CHANNEL_WIDTH.lane;
    const offset = lane === 0 ? -CHANNEL_WIDTH.firstLaneOffset : CHANNEL_WIDTH.laneOffset;
    const path = pointString(offsetPoints(points, offset));
    return `<g data-integration-layer="${gate}" data-rank="${rank}" data-lane="${lane}"><path d="${path}" fill="none" stroke="${activationLaneColor(state, lane)}" stroke-width="${width}" stroke-linecap="butt" stroke-linejoin="round" pointer-events="none"/></g>`;
  }).join('')).join('');
  return mono + lanes;
}
