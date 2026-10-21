// The native slider, painted rail, reference and return markers share endpoints.
// Other 44px controls and the thumb SVG's own coordinate system are independent.
export const TIMELINE_THUMB_SIZE = 44;
const TIMELINE_RAIL_INSET = TIMELINE_THUMB_SIZE / 2;

export function applyTimelineMetrics(element: HTMLElement) {
  element.style?.setProperty('--timeline-thumb-size', `${TIMELINE_THUMB_SIZE}px`);
  element.style?.setProperty('--timeline-rail-inset', `${TIMELINE_RAIL_INSET}px`);
}
