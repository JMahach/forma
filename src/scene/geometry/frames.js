import { MANDALA_GEOMETRY, MANDALA_SCENE_SCALE } from './mandala-geometry.js';
import { MANDALA_PLANET_LAYOUT } from './mandala-planets.js';
import { MANDALA_COLUMN_SPAN } from './activation-layout.js';

// SVG-space bounds. CSS-pixel layout insets are owned by scene/layout.
export const DRAWING_BOUNDS = Object.freeze({ x: -52, y: 28, width: 744, height: 740 });
export const CHART_FRAME = Object.freeze({ bounds: DRAWING_BOUNDS, minScale: .65 });
// One stable Home contains the complete painted planet envelope.
// Screen-space clearance belongs to layout insets, not an extra scaled rim.
// The frame does not depend on which longitudes happen to be active today.
const radius = MANDALA_PLANET_LAYOUT.visualRadius * MANDALA_SCENE_SCALE;
export const STUDIO_FRAME = Object.freeze({
  bounds: Object.freeze({ x: MANDALA_GEOMETRY.centerX - radius, y: MANDALA_GEOMETRY.centerY - radius, width: radius * 2, height: radius * 2 }),
  minScale: .1,
});
export const MANDALA_FRAME = Object.freeze({
  bounds: Object.freeze({ x: MANDALA_COLUMN_SPAN.left,
    y: STUDIO_FRAME.bounds.y,
    width: MANDALA_COLUMN_SPAN.right - MANDALA_COLUMN_SPAN.left,
    height: STUDIO_FRAME.bounds.height }), minScale: .1,
});
