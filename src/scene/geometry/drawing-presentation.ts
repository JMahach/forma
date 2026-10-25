// One permanent studio geometry for the silhouette, chart, columns and arrows.
// Keep the approved proportions inside the wheel: chart point (320, 410)
// lands at (320, 398). Toggling decorations never changes this mapping.
export const DRAWING_SCALE = 1 / .96;
export const DRAWING_TRANSFORM = `matrix(${DRAWING_SCALE}, 0, 0, ${DRAWING_SCALE}, ${320 * (1 - DRAWING_SCALE)}, ${398 - 410 * DRAWING_SCALE})`;

// Width-only tuning: the approved 1.32 baseline is enlarged another 25% to 1.65.
// Keep paint, dual-source lanes and integration masks on the same scale.
const CHANNEL_WIDTH_SCALE = 1.65;
const channelWidth = (value: number) => Number((value * CHANNEL_WIDTH_SCALE).toFixed(3));
export const CHANNEL_WIDTH = Object.freeze({
  outline: channelWidth(6.4), paint: channelWidth(4.6),
  lane: channelWidth(2.3), laneOffset: channelWidth(1.2), halo: channelWidth(10),
  // First source (black) fills the middle gap with a small overlap beneath red.
  // Width and offset move together, keeping its outer edge in the same place.
  firstLane: channelWidth(2.5), firstLaneOffset: channelWidth(1.1),
});

// Shared by center rendering and visible channel-boundary measurement.
export const CENTER_STROKE = 1.25;

export type HighlightStyle = 'glow' | 'outline';
export const channelHighlightWidth = (style: HighlightStyle = 'outline') => style === 'glow' ? CHANNEL_WIDTH.outline : CHANNEL_HIGHLIGHT_WIDTH;

// JointJS Mask-style exterior ring: preserve the figure, then leave a gap.
// Native SVG masks subtract the inner footprint from the larger blue stroke.
export const HIGHLIGHT_OUTLINE = Object.freeze({ channelGap: .75, centerGap: 1.25, width: 2 });
export const CHANNEL_HIGHLIGHT_INNER_WIDTH = Number((CHANNEL_WIDTH.outline + HIGHLIGHT_OUTLINE.channelGap * 2).toFixed(3));
export const CHANNEL_HIGHLIGHT_WIDTH = Number((CHANNEL_HIGHLIGHT_INNER_WIDTH + HIGHLIGHT_OUTLINE.width * 2).toFixed(3));

// Approved precise-circle gate marker; hit area stays independent.
export const GATE_MARKER = Object.freeze({
  radius: 8.4, hitRadius: 12.5, highlightWidth: 1.15, fontSize: 10.4, fontWeight: 560,
  fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
});
