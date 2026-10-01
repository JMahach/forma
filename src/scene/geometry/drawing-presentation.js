// One permanent studio geometry for the silhouette, chart, columns and arrows.
// Keep the approved proportions inside the wheel: chart point (320, 410)
// lands at (320, 398). Toggling decorations never changes this mapping.
export const DRAWING_SCALE = 1 / .96;
export const DRAWING_TRANSFORM = `matrix(${DRAWING_SCALE}, 0, 0, ${DRAWING_SCALE}, ${320 * (1 - DRAWING_SCALE)}, ${398 - 410 * DRAWING_SCALE})`;
