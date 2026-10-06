import { computeStudioLayout, STUDIO_BOTTOM_INSET } from './layout.js';
import { STUDIO_FRAME } from './geometry/frames.js';

// Phone chrome is presentation, not a branch in camera or chart geometry.
export const PHONE_LAYOUT_QUERY = '(max-width: 699px), (pointer: coarse) and (max-width: 1099px) and (max-height: 500px)';

export function createStudioLayout({ canvas, panels, drawing = null, art = null, readStyle = element => getComputedStyle(element),
  media = globalThis.matchMedia(PHONE_LAYOUT_QUERY) }) {
  const phone = () => media.matches;
  let current;
  function refresh() {
    const rect = canvas.getBoundingClientRect(), style = readStyle(canvas), offsetLeft = canvas.offsetLeft || 0;
    current = computeStudioLayout({ width: rect.width, height: rect.height,
      side: parseFloat(style.scrollPaddingLeft) || 4,
      top: parseFloat(style.scrollPaddingTop) || 112,
      bottom: parseFloat(style.scrollPaddingBottom) || STUDIO_BOTTOM_INSET });
    canvas.dataset.layout = phone() ? 'phone' : 'desktop';
    canvas.dataset.mandalaColumns = current.showMandalaColumns ? 'visible' : 'hidden';
    if (art) {
      // Its STUDIO_FRAME viewBox uses the camera's exact fitting rectangle,
      // including the shared vertical shift and responsive safe-area insets.
      const { x, y, width, height } = current.area;
      Object.assign(art.style, { left: `${x}px`, top: `${y}px`, width: `${width}px`, height: `${height}px`, visibility: 'visible' });
    }
    const { panel, placement } = current;
    const left = `${panel.x + offsetLeft}px`;
    for (const element of panels) {
      element.dataset.placement = placement;
      element.style.left = left;
      element.style.top = `${panel.y}px`;
      element.style.width = `${panel.width}px`;
    }
    if (drawing) {
      // The small control surface covers only its own footprint. A footer-wide
      // clip would unnecessarily erase the zoomed drawing on either side.
      // The canvas's existing drawer clip remains responsible for side drawers.
      drawing.style.clipPath = 'none';
    }
    return current;
  }
  refresh();
  return {
    get phone() { return phone(); },
    get showMandalaColumns() { return current.showMandalaColumns; },
    get placement() { return current.placement; },
    get mandalaTop() { return current.center.y - current.mandalaRadius; },
    frame() { return STUDIO_FRAME; },
    refresh,
    insets() { return current.insets; },
  };
}
