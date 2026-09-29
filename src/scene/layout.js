import { MANDALA_GEOMETRY, MANDALA_SCENE_SCALE } from './geometry/mandala-geometry.js';
import { MANDALA_PLANET_LAYOUT } from './geometry/mandala-planets.js';
import { ACTIVATION_BLOCK_BOUNDS, ACTIVATION_COLUMN_REVEAL_DISTANCE } from './geometry/activation-layout.js';
import { STUDIO_FRAME } from './geometry/frames.js';

export const DAY_CONTROL_HEIGHT = 48;
const GAP = 4;
export const STUDIO_BOTTOM_INSET = DAY_CONTROL_HEIGHT + GAP;
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));

// CSS pixels throughout. The camera later converts these insets through the SVG
// screen matrix. Fit the full painted envelope, then move the shared scene a
// quarter of its resting gap toward the day line. Panel visibility is irrelevant.
export function computeStudioLayout({ width, height, side = 4, top = 112, bottom = STUDIO_BOTTOM_INSET }) {
  side = clamp(side, 0, width / 4);
  top = clamp(top, 0, height * .49);
  bottom = clamp(bottom, 0, height * .49);
  const area = { x: side, y: top, width: Math.max(1, width - 2 * side), height: Math.max(1, height - top - bottom) };
  const diameter = Math.min(area.width, area.height), scale = diameter / STUDIO_FRAME.bounds.width;
  const center = { x: width / 2, y: top + area.height / 2 }, r = diameter / 2;
  const project = ({ x, y, width, height }) => ({
    x: center.x + (x - MANDALA_GEOMETRY.centerX) * scale, y: center.y + (y - MANDALA_GEOMETRY.centerY) * scale,
    width: width * scale, height: height * scale,
  });
  // Enlarged source blocks and their outward journeys clear the planet lanes.
  // The shared envelope includes fixing marks and hit areas, not only text.
  const expanded = project({ ...ACTIVATION_BLOCK_BOUNDS,
    x: ACTIVATION_BLOCK_BOUNDS.x - ACTIVATION_COLUMN_REVEAL_DISTANCE, width: ACTIVATION_BLOCK_BOUNDS.width + 2 * ACTIVATION_COLUMN_REVEAL_DISTANCE });
  const showMandalaColumns = expanded.x >= area.x + GAP && expanded.x + expanded.width <= width - side - GAP;
  const footerY = height - DAY_CONTROL_HEIGHT - Math.max(0, bottom - STUDIO_BOTTOM_INSET);
  // Match the visible ring at Home, excluding its planet lanes. The CSS
  // extends only the invisible thumb area beyond these endpoints by 22px.
  const panelWidth = 2 * MANDALA_GEOMETRY.outerRadius * MANDALA_SCENE_SCALE * scale;
  const mandalaRadius = MANDALA_PLANET_LAYOUT.visualRadius * MANDALA_SCENE_SCALE * scale;
  const bottomOfMandala = center.y + mandalaRadius;
  // Move a quarter of the decorative envelope's gap toward the line, but leave
  // the full touch target clear. The visible backing occupies only 26px of it.
  const offsetY = Math.max(0, Math.min((footerY + 26 - bottomOfMandala) / 4, footerY - GAP - bottomOfMandala));
  area.y += offsetY;
  center.y += offsetY;
  const placement = 'bottom';
  const panel = { x: center.x - panelWidth / 2, y: footerY, width: panelWidth, height: DAY_CONTROL_HEIGHT };
  return { area, scale, center, radius: r, mandalaRadius, placement, panel, showMandalaColumns, insets: { side, top, bottom, offsetY } };
}

// A deterministic conversion of viewport insets into a camera fitting area.
// `project` converts a CSS-pixel point through the measured SVG screen matrix.
export function computeCameraFit(frame, rect, insets, project) {
  const { bounds, minScale } = frame, flexible = Boolean(insets) || minScale < .65;
  const side = Math.min(insets?.side ?? (rect.width < 700 ? 22 : 64), flexible ? rect.width / 4 : Infinity);
  const topInset = Math.min(insets?.top ?? (rect.width < 700 ? 128 : 86), flexible ? rect.height * (insets ? .49 : .3) : Infinity);
  const bottomInset = Math.min(insets?.bottom ?? 72, flexible ? rect.height * (insets ? .49 : .2) : Infinity);
  const offsetY = insets?.offsetY ?? 0;
  const top = project(rect.left + side, rect.top + topInset + offsetY);
  const bottom = project(rect.right - side, rect.bottom - bottomInset + offsetY);
  const area = { x: top.x, y: top.y, width: Math.max(flexible ? 1 : 100, bottom.x - top.x), height: Math.max(flexible ? 1 : 100, bottom.y - top.y) };
  const min = flexible ? Math.min(minScale, area.width / bounds.width, area.height / bounds.height) : minScale;
  return { area, min };
}
