export type ColumnSide = 'left' | 'right';
import { PLANETS } from '../../domain/planets.ts';
import { MANDALA_GEOMETRY, MANDALA_SCENE_SCALE } from './mandala-geometry.ts';
import { DRAWING_SCALE } from './drawing-presentation.ts';
import { MANDALA_PLANET_LAYOUT } from './mandala-planets.ts';

export const ACTIVATION_COLUMN_REVEAL_DISTANCE = 244;

// The chart, incremental painter and loading illustration share these anchors.
export const ACTIVATION_COLUMN_LAYOUT = Object.freeze({
  x: Object.freeze({ left: -48, right: 600 }),
  width: 108, panelRightPadding: 10,
  firstRowY: 118, rowStep: 48,
  glyphOffsetX: 8, valueOffsetX: 34,
  headingY: 76, headingOffsetX: -2, ruleY: 88,
  headingWidths: Object.freeze<Record<string, number>>({ 'Дизайн': 58, 'Личность': 74, 'Транзит': 58 }),
});
export const activationRowY = (index: number) => ACTIVATION_COLUMN_LAYOUT.firstRowY + index * ACTIVATION_COLUMN_LAYOUT.rowStep;
export const activationHeadingX = (columnSide: ColumnSide) => ACTIVATION_COLUMN_LAYOUT.x[columnSide] + ACTIVATION_COLUMN_LAYOUT.headingOffsetX;

// Ordinary rows and single overlay rows share the same presentation metrics.
export const ACTIVATION_ROW_LAYOUT = Object.freeze({
  valueX: Object.freeze([ACTIVATION_COLUMN_LAYOUT.valueOffsetX]),
  fontSize: 24, textX: 0, rectX: -10, hitWidth: 72,
  glyphX: ACTIVATION_COLUMN_LAYOUT.glyphOffsetX, glyphSize: 26,
});

// Equal-width number targets meet at the next column anchor.
const adjacentValues = (valueX: number[]) => ({ valueX: Object.freeze(valueX), hitWidth: valueX[1] - valueX[0] });

// Overlay sources use the same row anchors. Normal dual values have a wider
// text spacing; beside the mandala their envelope determines visibility/frames.
const OVERLAY_ACTIVATION_COLUMN_LAYOUT = Object.freeze({
  single: Object.freeze({ ...ACTIVATION_ROW_LAYOUT, leftOffsetX: 0,
    headingWidth: null, captionX: Object.freeze([40, 88]), captionSize: 9 }),
  dual: Object.freeze({ ...adjacentValues([22, 72]), leftOffsetX: 0,
    fontSize: 18, textX: 1, rectX: -2, glyphX: 6, glyphSize: 23,
    headingWidth: 109, captionX: Object.freeze([40, 88]), captionSize: 9 }),
  'dual-wide': Object.freeze({ ...adjacentValues([22, 80]), leftOffsetX: -14,
    fontSize: 20, textX: 1, rectX: -2, glyphX: 6, glyphSize: 23,
    headingWidth: 123, captionX: Object.freeze([40, 100]), captionSize: 10 }),
});

// Every row is fully tiled by equal-height targets. Planet glyphs keep their
// optical correction independently of the common hit and highlight geometry.
export function activationTargetLayout(fontSize: number = ACTIVATION_ROW_LAYOUT.fontSize) {
  const hitHeight = ACTIVATION_COLUMN_LAYOUT.rowStep;
  return { hitY: -hitHeight / 2, hitHeight, hitRadius: 10 };
}
export function activationPlanetLayout(metrics: { valueX: readonly number[]; fontSize: number; glyphX: number; glyphSize: number; rectX: number } = ACTIVATION_ROW_LAYOUT) {
  const rectX = -8, hitWidth = metrics.valueX[0] + metrics.rectX - rectX;
  return { ...activationTargetLayout(metrics.fontSize), rectX,
    hitWidth, x: metrics.glyphX, y: 2, fontSize: metrics.glyphSize };
}

// Reserve caption clearance while ordinary columns retain their original baselines.
const OVERLAY_DUAL_ROW_OFFSET = 12;

export function overlayActivationColumnLayout(columnSide: ColumnSide, { single, showMandala, label }: { single: boolean; showMandala?: boolean; label: string }) {
  const layout = single ? 'single' : showMandala ? 'dual' : 'dual-wide';
  const metrics = OVERLAY_ACTIVATION_COLUMN_LAYOUT[layout];
  const x = ACTIVATION_COLUMN_LAYOUT.x[columnSide] + (columnSide === 'left' ? metrics.leftOffsetX : 0);
  const headingSize = 16;
  return { x, layout, single, rowOffset: single ? 0 : OVERLAY_DUAL_ROW_OFFSET, transform: activationBlockTransform(columnSide),
    headingX: x + ACTIVATION_COLUMN_LAYOUT.headingOffsetX, headingY: ACTIVATION_COLUMN_LAYOUT.headingY,
    ruleY: ACTIVATION_COLUMN_LAYOUT.ruleY, headingSize,
    headingTop: ACTIVATION_COLUMN_LAYOUT.headingY - headingSize, headingHeight: headingSize * 1.5,
    headingWidth: metrics.headingWidth ?? ACTIVATION_COLUMN_LAYOUT.headingWidths[label] ?? ACTIVATION_COLUMN_LAYOUT.headingWidths['Личность'],
    headingViewportWidth: metrics.headingWidth ?? ACTIVATION_COLUMN_LAYOUT.width,
    captionX: metrics.captionX.map(offset => x + offset), captionY: 101, captionSize: metrics.captionSize,
    planet: activationPlanetLayout(metrics),
    values: metrics.valueX.map(x => ({ x, fontSize: metrics.fontSize, textX: metrics.textX,
      rectX: metrics.rectX, hitWidth: metrics.hitWidth, ...activationTargetLayout(metrics.fontSize) })),
  };
}

// Both column blocks grow outward from their inner edge and the heading baseline,
// then rise together to align their last numbers with gate 41's hover rim.
// All values use the chart's SVG coordinates; the camera remains independent.
export const ACTIVATION_BLOCK_SCALE = 1.09;
const ACTIVATION_BLOCK_LIFT = 15.75;
const PIVOT_Y = ACTIVATION_COLUMN_LAYOUT.headingY;
const PIVOT_X = Object.freeze({ left: 212, right: 428 });

// Start between the full mandala envelope and glyphs, then leave the requested
// extra breathing room before each planet. Both columns share this slot.
const planetTargetLeft = -8;
const ringRight = MANDALA_GEOMETRY.centerX + MANDALA_PLANET_LAYOUT.visualRadius * MANDALA_SCENE_SCALE;
const planetLeft = PIVOT_X.right + (ACTIVATION_COLUMN_LAYOUT.x.right + planetTargetLeft - PIVOT_X.right)
  * ACTIVATION_BLOCK_SCALE + ACTIVATION_COLUMN_REVEAL_DISTANCE;
const filterCenter = ((ringRight + planetLeft) / 2 - ACTIVATION_COLUMN_REVEAL_DISTANCE - PIVOT_X.right)
  / ACTIVATION_BLOCK_SCALE + PIVOT_X.right - ACTIVATION_COLUMN_LAYOUT.x.right;
export const ACTIVATION_PLANET_FILTER_LAYOUT = Object.freeze({
  centerX: Number((filterCenter - 5).toFixed(3)), size: 13.5,
  hitLeft: planetTargetLeft - 33.5, hitWidth: 28,
});

export function activationBlockTransform(columnSide: ColumnSide) {
  const x = PIVOT_X[columnSide];
  return `translate(${x} ${PIVOT_Y - ACTIVATION_BLOCK_LIFT}) scale(${ACTIVATION_BLOCK_SCALE}) translate(${-x} ${-PIVOT_Y})`;
}

// Conservative envelope includes complete frame strokes, row hit areas and fixing marks.
// Mandala separation is applied outside this scale, by its existing motion layer.
const left = PIVOT_X.left + (ACTIVATION_COLUMN_LAYOUT.x.left + Math.min(-20, ACTIVATION_PLANET_FILTER_LAYOUT.hitLeft) - PIVOT_X.left) * ACTIVATION_BLOCK_SCALE;
const columnRight = Math.max(ACTIVATION_COLUMN_LAYOUT.width, ...(['single', 'dual', 'dual-wide'] as const).map(layout => {
  const metrics = OVERLAY_ACTIVATION_COLUMN_LAYOUT[layout];
  return metrics.valueX.at(-1)! + metrics.rectX + metrics.hitWidth;
}));
const right = PIVOT_X.right + (ACTIVATION_COLUMN_LAYOUT.x.right + columnRight + ACTIVATION_COLUMN_LAYOUT.panelRightPadding + 1 - PIVOT_X.right) * ACTIVATION_BLOCK_SCALE;
const top = Math.min(PIVOT_Y, activationRowY(0)) - 23;
const bottom = Math.max(ACTIVATION_COLUMN_LAYOUT.ruleY, activationRowY(PLANETS.length - 1)
  + OVERLAY_DUAL_ROW_OFFSET + ACTIVATION_COLUMN_LAYOUT.rowStep / 2 + 5);
export const ACTIVATION_BLOCK_BOUNDS = Object.freeze({
  x: left, y: PIVOT_Y + (top - PIVOT_Y) * ACTIVATION_BLOCK_SCALE - ACTIVATION_BLOCK_LIFT,
  width: right - left, height: (bottom - top) * ACTIVATION_BLOCK_SCALE,
});

// Include the enlarged mandala columns and their complete hit areas.
// This shared horizontal span affects visibility/navigation, never Home size.
const expandedLeft = left - ACTIVATION_COLUMN_REVEAL_DISTANCE;
const expandedRight = right + ACTIVATION_COLUMN_REVEAL_DISTANCE;
const mandalaX = (x: number) => MANDALA_GEOMETRY.centerX + (x - MANDALA_GEOMETRY.centerX) * DRAWING_SCALE;
export const MANDALA_COLUMN_SPAN = Object.freeze({
  left: mandalaX(expandedLeft),
  right: mandalaX(expandedRight),
});
