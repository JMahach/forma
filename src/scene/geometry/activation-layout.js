export const ACTIVATION_COLUMN_REVEAL_DISTANCE = 244;

// Both source blocks grow outward from their inner edge and the heading baseline,
// then rise together to align their last numbers with gate 41's hover rim.
// All values use the chart's SVG coordinates; the camera remains independent.
export const ACTIVATION_BLOCK_SCALE = 1.09;
export const ACTIVATION_BLOCK_LIFT = 15.75;
const PIVOT_Y = 76;
const PIVOT_X = Object.freeze({ design: 212, personality: 428 });

export function activationBlockTransform(source) {
  const x = PIVOT_X[source];
  return `translate(${x} ${PIVOT_Y - ACTIVATION_BLOCK_LIFT}) scale(${ACTIVATION_BLOCK_SCALE}) translate(${-x} ${-PIVOT_Y})`;
}

// Conservative envelope includes row hit areas and fixing marks on both sides.
// Mandala separation is applied outside this scale, by its existing motion layer.
const left = PIVOT_X.design + (-52 - PIVOT_X.design) * ACTIVATION_BLOCK_SCALE;
const right = PIVOT_X.personality + (692 - PIVOT_X.personality) * ACTIVATION_BLOCK_SCALE;
export const ACTIVATION_BLOCK_BOUNDS = Object.freeze({
  x: left, y: PIVOT_Y + (56 - PIVOT_Y) * ACTIVATION_BLOCK_SCALE - ACTIVATION_BLOCK_LIFT,
  width: right - left, height: (716 - 56) * ACTIVATION_BLOCK_SCALE,
});
