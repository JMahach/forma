import { DRAWING_BOUNDS } from './gestures.js';
import { MANDALA_GEOMETRY, MANDALA_SCENE_SCALE } from './mandala.js';
import { ACTIVATION_BLOCK_BOUNDS } from '../activations/activation-layout.js';

// Phone chrome remains a presentation detail; geometry never branches on it.
export const PHONE_LAYOUT_QUERY = '(max-width: 699px), (pointer: coarse) and (max-width: 1099px) and (max-height: 500px)';
const radius = (MANDALA_GEOMETRY.outerRadius + 7) * MANDALA_SCENE_SCALE;
export const PHONE_MANDALA_FRAME = Object.freeze({
  bounds: Object.freeze({ x: 320 - radius, y: 398 - radius, width: radius * 2, height: radius * 2 }),
  minScale: .1,
});
export const PHONE_CHART_FRAME = Object.freeze({ bounds: DRAWING_BOUNDS, minScale: .1 });
export const STUDIO_FRAME = PHONE_MANDALA_FRAME;
export const DAY_CONTROL_HEIGHT = 48;
const GAP = 8;
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));

// CSS pixels throughout. The camera later converts these insets through the SVG
// screen matrix. Keep the established fit size, then move the shared scene a
// quarter of its resting gap toward the day line. Panel visibility is irrelevant.
export function computeStudioLayout({ width, height, side = 12, top = 112, bottom = 64 }) {
  side = clamp(side, 0, width / 4);
  top = clamp(top, 0, height * .49);
  bottom = clamp(bottom, 0, height * .49);
  const area = { x: side, y: top, width: Math.max(1, width - 2 * side), height: Math.max(1, height - top - bottom) };
  const diameter = Math.min(area.width, area.height), scale = diameter / STUDIO_FRAME.bounds.width;
  const center = { x: width / 2, y: top + area.height / 2 }, r = diameter / 2;
  const project = ({ x, y, width, height }) => ({
    x: center.x + (x - 320) * scale, y: center.y + (y - 398) * scale,
    width: width * scale, height: height * scale,
  });
  // Enlarged source blocks plus the two existing 228-unit column journeys.
  // The shared envelope includes fixing marks and hit areas, not only text.
  const expanded = project({ ...ACTIVATION_BLOCK_BOUNDS,
    x: ACTIVATION_BLOCK_BOUNDS.x - 228, width: ACTIVATION_BLOCK_BOUNDS.width + 456 });
  const showMandalaColumns = expanded.x >= area.x + GAP && expanded.x + expanded.width <= width - side - GAP;
  const footerY = height - DAY_CONTROL_HEIGHT - Math.max(0, bottom - 64);
  // Match the visible ring at Home, excluding its cursor clearance. The CSS
  // extends only the invisible thumb area beyond these endpoints by 22px.
  const panelWidth = 2 * MANDALA_GEOMETRY.outerRadius * MANDALA_SCENE_SCALE * scale;
  const offsetY = Math.max(0, (footerY + 26 - (center.y + panelWidth / 2)) / 4);
  area.y += offsetY;
  center.y += offsetY;
  const placement = 'bottom';
  const panel = { x: center.x - panelWidth / 2, y: footerY, width: panelWidth, height: DAY_CONTROL_HEIGHT };
  return { area, scale, center, radius: r, placement, panel, showMandalaColumns, insets: { side, top, bottom, offsetY } };
}

export function createStudioLayout({ canvas, panels, drawing = null, readStyle = element => getComputedStyle(element),
  media = globalThis.matchMedia(PHONE_LAYOUT_QUERY) }) {
  const phone = () => media.matches;
  let current;
  function refresh() {
    const rect = canvas.getBoundingClientRect(), style = readStyle(canvas);
    current = computeStudioLayout({ width: rect.width, height: rect.height,
      side: parseFloat(style.scrollPaddingLeft) || 12,
      top: parseFloat(style.scrollPaddingTop) || 112,
      bottom: parseFloat(style.scrollPaddingBottom) || 64 });
    canvas.dataset.layout = phone() ? 'phone' : 'desktop';
    canvas.dataset.mandalaColumns = current.showMandalaColumns ? 'visible' : 'hidden';
    const { panel, placement } = current;
    for (const element of panels) {
      element.dataset.placement = placement;
      element.style.left = `${panel.x}px`;
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
    get mandalaTop() { return current.center.y - current.panel.width / 2; },
    frame() { return STUDIO_FRAME; },
    refresh,
    insets() { return current.insets; },
  };
}
