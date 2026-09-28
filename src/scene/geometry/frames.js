import { MANDALA_GEOMETRY, MANDALA_SCENE_SCALE } from './mandala-geometry.js';
import { ACTIVATION_BLOCK_BOUNDS, ACTIVATION_COLUMN_REVEAL_DISTANCE } from './activation-layout.js';

// SVG-space bounds. CSS-pixel layout insets are owned by scene/layout.
export const DRAWING_BOUNDS = Object.freeze({ x: -52, y: 28, width: 744, height: 740 });
export const CHART_FRAME = Object.freeze({ bounds: DRAWING_BOUNDS, minScale: .65 });
export const MANDALA_FRAME = Object.freeze({
  bounds: Object.freeze({ x: ACTIVATION_BLOCK_BOUNDS.x - ACTIVATION_COLUMN_REVEAL_DISTANCE, y: -64,
    width: ACTIVATION_BLOCK_BOUNDS.width + 2 * ACTIVATION_COLUMN_REVEAL_DISTANCE, height: 924 }), minScale: .1,
});
const radius = (MANDALA_GEOMETRY.outerRadius + 7) * MANDALA_SCENE_SCALE;
export const STUDIO_FRAME = Object.freeze({
  bounds: Object.freeze({ x: MANDALA_GEOMETRY.centerX - radius, y: MANDALA_GEOMETRY.centerY - radius, width: radius * 2, height: radius * 2 }),
  minScale: .1,
});
