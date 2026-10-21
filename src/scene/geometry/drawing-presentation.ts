// One permanent studio geometry for the silhouette, chart, columns and arrows.
// Keep the approved proportions inside the wheel: chart point (320, 410)
// lands at (320, 398). Toggling decorations never changes this mapping.
export const DRAWING_SCALE = 1 / .96;
export const DRAWING_TRANSFORM = `matrix(${DRAWING_SCALE}, 0, 0, ${DRAWING_SCALE}, ${320 * (1 - DRAWING_SCALE)}, ${398 - 410 * DRAWING_SCALE})`;

// Width-only tuning: 1 is original, 1.2 is the previous step, 1.32 adds 10% to it.
// Keep paint, dual-source lanes and integration masks on the same scale.
const CHANNEL_WIDTH_SCALE = 1.32;
const channelWidth = (value: number) => Number((value * CHANNEL_WIDTH_SCALE).toFixed(3));
export const CHANNEL_WIDTH = Object.freeze({
  outline: channelWidth(6.4), paint: channelWidth(4.6),
  lane: channelWidth(2.3), laneOffset: channelWidth(1.2), halo: channelWidth(10),
});
