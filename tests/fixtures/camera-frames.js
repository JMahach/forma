// Alternative Home frames exercise the camera's general transition contract.
// The application itself uses the single STUDIO_FRAME in both drawing modes.
import { DRAWING_BOUNDS } from '../../src/scene/geometry/frames.js';
import { MANDALA_GEOMETRY, MANDALA_SCENE_SCALE } from '../../src/scene/geometry/mandala-geometry.js';

export const COMPACT_TEST_FRAME = Object.freeze({ bounds: DRAWING_BOUNDS, minScale: .1 });
const radius = (MANDALA_GEOMETRY.outerRadius + 7) * MANDALA_SCENE_SCALE;
export const EXPANDED_TEST_FRAME = Object.freeze({
  bounds: Object.freeze({ x: MANDALA_GEOMETRY.centerX - radius, y: MANDALA_GEOMETRY.centerY - radius,
    width: radius * 2, height: radius * 2 }),
  minScale: .1,
});
