import { GATE_ORDER, GATE_LONGITUDE_START, GATE_WIDTH } from '../../domain/gate-wheel.js';

export const MANDALA_GEOMETRY = Object.freeze({
  centerX: 320, centerY: 398, outerRadius: 373.8, innerRadius: 340.2,
  labelRadius: 357, rayRadius: 331.8,
});
// Keep the established ring-to-body proportions without shrinking the body on
// toggle. Only the decorative wheel receives the inverse of the old .84 scale.
export const MANDALA_SCENE_SCALE = 1 / .84;
export const MANDALA_SCENE_TRANSFORM = `translate(${MANDALA_GEOMETRY.centerX} ${MANDALA_GEOMETRY.centerY}) scale(${MANDALA_SCENE_SCALE}) translate(${-MANDALA_GEOMETRY.centerX} ${-MANDALA_GEOMETRY.centerY})`;

const format = value => Number(value.toFixed(3));

// This is a display orientation, not another astronomical calculation:
// 0° is left, 90° bottom, 180° right and 270° top, as in the reference wheel.
export function mandalaPoint(longitude, radius = MANDALA_GEOMETRY.outerRadius) {
  const angle = longitude * Math.PI / 180;
  return [
    MANDALA_GEOMETRY.centerX - radius * Math.cos(angle),
    MANDALA_GEOMETRY.centerY + radius * Math.sin(angle),
  ].map(format);
}

export const mandalaPointString = (longitude, radius) => mandalaPoint(longitude, radius).join(' ');
export const MANDALA_CENTER = `${MANDALA_GEOMETRY.centerX} ${MANDALA_GEOMETRY.centerY}`;
export function sectorPath(start, end, inner, outer) {
  return `M ${mandalaPointString(start, inner)} L ${mandalaPointString(start, outer)} A ${outer} ${outer} 0 0 0 ${mandalaPointString(end, outer)} L ${mandalaPointString(end, inner)} A ${inner} ${inner} 0 0 1 ${mandalaPointString(start, inner)} Z`;
}
export function fanPath(start, end) {
  const radius = MANDALA_GEOMETRY.rayRadius;
  return `M ${MANDALA_CENTER} L ${mandalaPointString(start, radius)} A ${radius} ${radius} 0 0 0 ${mandalaPointString(end, radius)} Z`;
}
export const MANDALA_SECTORS = Object.freeze(GATE_ORDER.map((gate, index) => {
  const start = GATE_LONGITUDE_START + index * GATE_WIDTH;
  const end = start + GATE_WIDTH;
  const middle = (start + end) / 2;
  return Object.freeze({
    gate, start, end, middle,
    ring: sectorPath(start, end, MANDALA_GEOMETRY.innerRadius, MANDALA_GEOMETRY.outerRadius),
    halfRings: [
      sectorPath(start, middle, MANDALA_GEOMETRY.innerRadius, MANDALA_GEOMETRY.outerRadius),
      sectorPath(middle, end, MANDALA_GEOMETRY.innerRadius, MANDALA_GEOMETRY.outerRadius),
    ],
    fan: fanPath(start, end), halfFans: [fanPath(start, middle), fanPath(middle, end)],
    separator: `M ${mandalaPointString(start, MANDALA_GEOMETRY.innerRadius)} L ${mandalaPointString(start, MANDALA_GEOMETRY.outerRadius)}`,
    label: mandalaPoint(middle, MANDALA_GEOMETRY.labelRadius),
  });
}));
