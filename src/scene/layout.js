import { MANDALA_GEOMETRY, MANDALA_SCENE_SCALE } from './geometry/mandala-geometry.js';
import { MANDALA_PLANET_LAYOUT } from './geometry/mandala-planets.js';
import { MANDALA_COLUMN_SPAN } from './geometry/activation-layout.js';
import { STUDIO_FRAME } from './geometry/frames.js';

export const DAY_CONTROL_HEIGHT = 48;
export const DAY_CONTROL_TOP_CLEARANCE = 20;
const GAP = 4;
const RETURNS_SHEET_REFERENCE_WIDTH = 1126;
// The backing is compact; the existing 44px range target remains unchanged.
const TIMELINE_INLINE_HEIGHT = 40.8, TIMELINE_STACKED_HEIGHT = 74.8;
const TIMELINE_SIDE_CONTROL_WIDTH = 160, TIMELINE_CONTROL_GAP = 10;
const TIMELINE_MIN_RAIL_WIDTH = 240;
export const STUDIO_BOTTOM_INSET = DAY_CONTROL_HEIGHT + GAP;
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));

// CSS pixels throughout. The camera later converts these insets through the SVG
// screen matrix. Fit the full painted envelope, then move the shared scene a
// quarter of its resting gap toward the day line. Panel visibility is irrelevant.
export function computeStudioLayout({ width, height, side = 4, top = 112, bottom = STUDIO_BOTTOM_INSET, footerHeight = null, safeBottom = 0 }) {
  side = clamp(side, 0, width / 4);
  top = clamp(top, 0, height * .49);
  bottom = clamp(bottom, 0, height * .49);
  const cameraBottom = Math.min(bottom + DAY_CONTROL_TOP_CLEARANCE, height * .49);
  const headingClearance = cameraBottom - bottom;
  const area = { x: side, y: top, width: Math.max(1, width - 2 * side), height: Math.max(1, height - top - cameraBottom) };
  const diameter = Math.min(area.width, area.height), scale = diameter / STUDIO_FRAME.bounds.width;
  const center = { x: width / 2, y: top + area.height / 2 }, r = diameter / 2;
  // Enlarged source blocks and their outward journeys clear the planet lanes.
  // Include the final content scale so neither column is clipped.
  const columnLeft = center.x + (MANDALA_COLUMN_SPAN.left - MANDALA_GEOMETRY.centerX) * scale;
  const columnRight = center.x + (MANDALA_COLUMN_SPAN.right - MANDALA_GEOMETRY.centerX) * scale;
  const showMandalaColumns = columnLeft >= area.x + GAP && columnRight <= width - side - GAP;
  const footerY = footerHeight == null ? height - DAY_CONTROL_HEIGHT - Math.max(0, bottom - STUDIO_BOTTOM_INSET) : height - safeBottom - DAY_CONTROL_HEIGHT;
  // Match the visible ring at Home, excluding its planet lanes. The CSS
  // extends only the invisible thumb area beyond these endpoints by 22px.
  const panelWidth = 2 * MANDALA_GEOMETRY.outerRadius * MANDALA_SCENE_SCALE * scale;
  const mandalaRadius = MANDALA_PLANET_LAYOUT.visualRadius * MANDALA_SCENE_SCALE * scale;
  const bottomOfMandala = center.y + mandalaRadius;
  // Move a quarter of the decorative envelope's gap toward the line, but leave
  // the full touch target clear. The visible backing occupies only 26px of it.
  const offsetY = Math.max(0, Math.min((footerY + 26 - bottomOfMandala) / 4, (footerHeight == null ? footerY - headingClearance : height - footerHeight) - GAP - bottomOfMandala));
  area.y += offsetY;
  center.y += offsetY;
  const placement = 'bottom';
  const panel = { x: center.x - panelWidth / 2, y: footerY, width: panelWidth, height: DAY_CONTROL_HEIGHT };
  return { area, scale, center, radius: r, mandalaRadius, placement, panel, showMandalaColumns, insets: { side, top, bottom: cameraBottom, offsetY } };
}

// Decide from the full studio, even with the drawer closed. Reading the
// already narrowed canvas here would make the placement feed back on itself.
export function returnsPlacement(options, { phone = false, reserve = 0 } = {}) {
  // The author supplied a narrow-window reference at approximately 1126 CSS px.
  // Beyond that boundary, the full mandala still has to fit at the same scale.
  if (phone || options.width <= RETURNS_SHEET_REFERENCE_WIDTH || !(reserve > 0) || options.width <= reserve) return 'sheet';
  const full = computeStudioLayout(options);
  const beside = computeStudioLayout({ ...options, width: options.width - reserve });
  return beside.scale + 1e-9 >= full.scale ? 'side' : 'sheet';
}

// The dock belongs to the full studio, independently of the mandala diameter.
// Only the chronicle's two period fields can require a second row.
export function computeTimelineDock({ width, height, side = 4, safeBottom = 0, kind = 'day', controlWidth = TIMELINE_SIDE_CONTROL_WIDTH }) {
  const gutter = Math.max(24, side);
  const periodSpace = controlWidth + TIMELINE_CONTROL_GAP;
  const inline = kind !== 'chronicle' || width >= 2 * (gutter + periodSpace) + TIMELINE_MIN_RAIL_WIDTH;
  const dockHeight = (inline ? TIMELINE_INLINE_HEIGHT : TIMELINE_STACKED_HEIGHT) + safeBottom;
  const actionGutter = Math.max(0, side - 4), actionSize = 44 * .9, actionWidth = 24;
  const railInset = kind === 'returns' ? actionGutter + actionWidth + 2
    : gutter + (kind === 'chronicle' && inline ? periodSpace : 0);
  return { kind, mode: inline ? 'inline' : 'stacked', height: dockHeight, gutter, actionGutter, actionSize, actionWidth, controlWidth,
    rail: { x: railInset, y: height - safeBottom - DAY_CONTROL_HEIGHT, width: Math.max(1, width - 2 * railInset), height: DAY_CONTROL_HEIGHT } };
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
