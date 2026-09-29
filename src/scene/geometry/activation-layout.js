import { PLANETS } from '../../domain/planets.js';

export const ACTIVATION_COLUMN_REVEAL_DISTANCE = 244;

// The chart, incremental painter and loading illustration share these anchors.
export const ACTIVATION_COLUMN_LAYOUT = Object.freeze({
  x: Object.freeze({ design: -32, personality: 584 }),
  firstRowY: 118, rowStep: 48,
  headingY: 76, headingOffsetX: -2, ruleY: 88,
  headingWidths: Object.freeze({ 'Дизайн': 58, 'Личность': 74, 'Транзит': 58 }),
});
export const activationRowY = index => ACTIVATION_COLUMN_LAYOUT.firstRowY + index * ACTIVATION_COLUMN_LAYOUT.rowStep;
export const activationHeadingX = source => ACTIVATION_COLUMN_LAYOUT.x[source] + ACTIVATION_COLUMN_LAYOUT.headingOffsetX;

// Both source blocks grow outward from their inner edge and the heading baseline,
// then rise together to align their last numbers with gate 41's hover rim.
// All values use the chart's SVG coordinates; the camera remains independent.
export const ACTIVATION_BLOCK_SCALE = 1.09;
export const ACTIVATION_BLOCK_LIFT = 15.75;
const PIVOT_Y = ACTIVATION_COLUMN_LAYOUT.headingY;
const PIVOT_X = Object.freeze({ design: 212, personality: 428 });

export function activationBlockTransform(source) {
  const x = PIVOT_X[source];
  return `translate(${x} ${PIVOT_Y - ACTIVATION_BLOCK_LIFT}) scale(${ACTIVATION_BLOCK_SCALE}) translate(${-x} ${-PIVOT_Y})`;
}

// Conservative envelope includes row hit areas and fixing marks on both sides.
// Mandala separation is applied outside this scale, by its existing motion layer.
const left = PIVOT_X.design + (ACTIVATION_COLUMN_LAYOUT.x.design - 20 - PIVOT_X.design) * ACTIVATION_BLOCK_SCALE;
const right = PIVOT_X.personality + (ACTIVATION_COLUMN_LAYOUT.x.personality + 108 - PIVOT_X.personality) * ACTIVATION_BLOCK_SCALE;
const top = Math.min(PIVOT_Y, activationRowY(0)) - 20;
const bottom = Math.max(ACTIVATION_COLUMN_LAYOUT.ruleY, activationRowY(PLANETS.length - 1) + 22);
export const ACTIVATION_BLOCK_BOUNDS = Object.freeze({
  x: left, y: PIVOT_Y + (top - PIVOT_Y) * ACTIVATION_BLOCK_SCALE - ACTIVATION_BLOCK_LIFT,
  width: right - left, height: (bottom - top) * ACTIVATION_BLOCK_SCALE,
});
