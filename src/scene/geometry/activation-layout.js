import { PLANETS } from '../../domain/planets.js';
import { MANDALA_GEOMETRY, MANDALA_SCENE_SCALE } from './mandala-geometry.js';
import { DRAWING_SCALE } from './drawing-presentation.js';
import { MANDALA_PLANET_LAYOUT } from './mandala-planets.js';

export const ACTIVATION_COLUMN_REVEAL_DISTANCE = 244;

// The chart, incremental painter and loading illustration share these anchors.
export const ACTIVATION_COLUMN_LAYOUT = Object.freeze({
  x: Object.freeze({ design: -32, personality: 584 }),
  width: 108,
  firstRowY: 118, rowStep: 48,
  glyphOffsetX: 8, valueOffsetX: 34,
  headingY: 76, headingOffsetX: -2, ruleY: 88,
  headingWidths: Object.freeze({ 'Дизайн': 58, 'Личность': 74, 'Транзит': 58 }),
});
export const activationRowY = index => ACTIVATION_COLUMN_LAYOUT.firstRowY + index * ACTIVATION_COLUMN_LAYOUT.rowStep;
export const activationHeadingX = source => ACTIVATION_COLUMN_LAYOUT.x[source] + ACTIVATION_COLUMN_LAYOUT.headingOffsetX;

// Overlay sources use the same row anchors. Normal dual columns gain a wider
// gap; beside the mandala their original envelope determines visibility/frames.
export const OVERLAY_ACTIVATION_COLUMN_LAYOUT = Object.freeze({
  single: Object.freeze({ valueX: Object.freeze([ACTIVATION_COLUMN_LAYOUT.valueOffsetX]), natalOffsetX: 0,
    fontSize: 24, textX: 0, rectX: -6, hitWidth: 68, glyphX: ACTIVATION_COLUMN_LAYOUT.glyphOffsetX, glyphSize: 26,
    headingWidth: null, captionX: Object.freeze([40, 88]), captionSize: 9 }),
  dual: Object.freeze({ valueX: Object.freeze([22, 72]), natalOffsetX: 0,
    fontSize: 18, textX: 1, rectX: -2, hitWidth: 38, glyphX: 6, glyphSize: 23,
    headingWidth: 109, captionX: Object.freeze([40, 88]), captionSize: 9 }),
  'dual-wide': Object.freeze({ valueX: Object.freeze([22, 80]), natalOffsetX: -14,
    fontSize: 20, textX: 1, rectX: -2, hitWidth: 44, glyphX: 6, glyphSize: 23,
    headingWidth: 123, captionX: Object.freeze([40, 100]), captionSize: 10 }),
});

export function overlayActivationColumnLayout(side, { single, showMandala, label }) {
  const layout = single ? 'single' : showMandala ? 'dual' : 'dual-wide';
  const metrics = OVERLAY_ACTIVATION_COLUMN_LAYOUT[layout];
  const x = ACTIVATION_COLUMN_LAYOUT.x[side] + (side === 'design' ? metrics.natalOffsetX : 0);
  const headingSize = 16;
  return { x, layout, single, transform: activationBlockTransform(side),
    headingX: x + ACTIVATION_COLUMN_LAYOUT.headingOffsetX, headingY: ACTIVATION_COLUMN_LAYOUT.headingY,
    ruleY: ACTIVATION_COLUMN_LAYOUT.ruleY, headingSize,
    headingTop: ACTIVATION_COLUMN_LAYOUT.headingY - headingSize, headingHeight: headingSize * 1.5,
    headingWidth: metrics.headingWidth ?? ACTIVATION_COLUMN_LAYOUT.headingWidths[label] ?? ACTIVATION_COLUMN_LAYOUT.headingWidths['Личность'],
    captionX: metrics.captionX.map(offset => x + offset), captionY: 96, captionSize: metrics.captionSize,
    glyphX: metrics.glyphX, glyphSize: metrics.glyphSize,
    values: metrics.valueX.map(x => ({ x, fontSize: metrics.fontSize, textX: metrics.textX,
      rectX: metrics.rectX, hitWidth: metrics.hitWidth, hitY: -20, hitHeight: 40, hitRadius: 4 })),
  };
}

// Both source blocks grow outward from their inner edge and the heading baseline,
// then rise together to align their last numbers with gate 41's hover rim.
// All values use the chart's SVG coordinates; the camera remains independent.
export const ACTIVATION_BLOCK_SCALE = 1.09;
export const ACTIVATION_BLOCK_LIFT = 15.75;
const PIVOT_Y = ACTIVATION_COLUMN_LAYOUT.headingY;
const PIVOT_X = Object.freeze({ design: 212, personality: 428 });

// Start between the full mandala envelope and glyphs, then leave the requested
// extra breathing room before each planet. Both source columns share this slot.
const planetTargetLeft = -8;
const ringRight = MANDALA_GEOMETRY.centerX + MANDALA_PLANET_LAYOUT.visualRadius * MANDALA_SCENE_SCALE;
const planetLeft = PIVOT_X.personality + (ACTIVATION_COLUMN_LAYOUT.x.personality + planetTargetLeft - PIVOT_X.personality)
  * ACTIVATION_BLOCK_SCALE + ACTIVATION_COLUMN_REVEAL_DISTANCE;
const filterCenter = ((ringRight + planetLeft) / 2 - ACTIVATION_COLUMN_REVEAL_DISTANCE - PIVOT_X.personality)
  / ACTIVATION_BLOCK_SCALE + PIVOT_X.personality - ACTIVATION_COLUMN_LAYOUT.x.personality;
export const ACTIVATION_PLANET_FILTER_LAYOUT = Object.freeze({
  centerX: Number((filterCenter - 5).toFixed(3)), size: 13.5,
  hitLeft: planetTargetLeft - 33.5, hitWidth: 28,
});

export function activationBlockTransform(source) {
  const x = PIVOT_X[source];
  return `translate(${x} ${PIVOT_Y - ACTIVATION_BLOCK_LIFT}) scale(${ACTIVATION_BLOCK_SCALE}) translate(${-x} ${-PIVOT_Y})`;
}

// Conservative envelope includes row hit areas and fixing marks on both sides.
// Mandala separation is applied outside this scale, by its existing motion layer.
const left = PIVOT_X.design + (ACTIVATION_COLUMN_LAYOUT.x.design + Math.min(-20, ACTIVATION_PLANET_FILTER_LAYOUT.hitLeft) - PIVOT_X.design) * ACTIVATION_BLOCK_SCALE;
const columnRight = Math.max(ACTIVATION_COLUMN_LAYOUT.width, ...['single', 'dual'].map(layout => {
  const metrics = OVERLAY_ACTIVATION_COLUMN_LAYOUT[layout];
  return metrics.valueX.at(-1) + metrics.rectX + metrics.hitWidth;
}));
const right = PIVOT_X.personality + (ACTIVATION_COLUMN_LAYOUT.x.personality + columnRight - PIVOT_X.personality) * ACTIVATION_BLOCK_SCALE;
const top = Math.min(PIVOT_Y, activationRowY(0)) - 20;
const bottom = Math.max(ACTIVATION_COLUMN_LAYOUT.ruleY, activationRowY(PLANETS.length - 1) + 22);
export const ACTIVATION_BLOCK_BOUNDS = Object.freeze({
  x: left, y: PIVOT_Y + (top - PIVOT_Y) * ACTIVATION_BLOCK_SCALE - ACTIVATION_BLOCK_LIFT,
  width: right - left, height: (bottom - top) * ACTIVATION_BLOCK_SCALE,
});

// Include the enlarged mandala columns and their complete hit areas.
// This shared horizontal span affects visibility/navigation, never Home size.
const expandedLeft = left - ACTIVATION_COLUMN_REVEAL_DISTANCE;
const expandedRight = right + ACTIVATION_COLUMN_REVEAL_DISTANCE;
const mandalaX = x => MANDALA_GEOMETRY.centerX + (x - MANDALA_GEOMETRY.centerX) * DRAWING_SCALE;
export const MANDALA_COLUMN_SPAN = Object.freeze({
  left: mandalaX(expandedLeft),
  right: mandalaX(expandedRight),
});
