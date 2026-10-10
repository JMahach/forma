import { MANDALA_GEOMETRY, MANDALA_SCENE_SCALE } from './geometry/mandala-geometry.js';
import { MANDALA_PLANET_LAYOUT } from './geometry/mandala-planets.js';
import { MANDALA_COLUMN_SPAN } from './geometry/activation-layout.js';
import { STUDIO_FRAME } from './geometry/frames.js';

export const DAY_CONTROL_HEIGHT = 48;
export const DAY_CONTROL_TOP_CLEARANCE = 20;
const GAP = 4;
const RETURNS_SHEET_REFERENCE_WIDTH = 1126;
// The backing is compact; the existing 44px range target remains unchanged.
export const TIMELINE_BAR_HEIGHT = 40.8;
// Keep the complete focus/error frame and a quiet gap above the rail backing.
export const TIMELINE_DATE_HEIGHT = 44;
export const TIMELINE_WITH_DATES_HEIGHT = TIMELINE_BAR_HEIGHT + TIMELINE_DATE_HEIGHT + GAP;
// Clear the native slider thumb target, which extends 22px beyond the rail.
const TIMELINE_SIDE_CONTROL_WIDTH = 160, TIMELINE_CONTROL_GAP = 24;
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));

// CSS pixels throughout. The camera later converts these insets through the SVG
// screen matrix. Fit the full painted envelope at the same scale in every mode.
// Center it naturally; use available headroom only to clear the potential footer.
export function computeStudioLayout({ width, height, side = 4, top = 112, bottom = TIMELINE_BAR_HEIGHT, footerHeight = TIMELINE_WITH_DATES_HEIGHT }) {
  side = clamp(side, 0, width / 4);
  top = clamp(top, 0, height * .49);
  bottom = clamp(bottom, 0, height * .49);
  const cameraBottom = Math.min(bottom + DAY_CONTROL_TOP_CLEARANCE, height * .49);
  const area = { x: side, y: top, width: Math.max(1, width - 2 * side), height: Math.max(1, height - top - cameraBottom) };
  const diameter = Math.min(area.width, area.height), scale = diameter / STUDIO_FRAME.bounds.width;
  const center = { x: width / 2, y: top + area.height / 2 };
  // Enlarged source blocks and their outward journeys clear the planet lanes.
  // Include the final content scale so neither column is clipped.
  const columnLeft = center.x + (MANDALA_COLUMN_SPAN.left - MANDALA_GEOMETRY.centerX) * scale;
  const columnRight = center.x + (MANDALA_COLUMN_SPAN.right - MANDALA_GEOMETRY.centerX) * scale;
  const showMandalaColumns = columnLeft >= area.x + GAP && columnRight <= width - side - GAP;
  const mandalaRadius = MANDALA_PLANET_LAYOUT.visualRadius * MANDALA_SCENE_SCALE * scale;
  const bottomOfMandala = center.y + mandalaRadius;
  // A second row never changes scale or pushes Home against the top when it
  // already fits. The open space between dates leaves the outer planets visible.
  const offsetY = Math.max(top - (center.y - mandalaRadius), Math.min(0, height - footerHeight - GAP - bottomOfMandala));
  area.y += offsetY;
  center.y += offsetY;
  return { area, scale, center, mandalaRadius, showMandalaColumns, insets: { side, top, bottom: cameraBottom, offsetY } };
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

// Every mode reserves the same date columns. If they cannot fit beside the
// Home mandala envelope, dates move above. Their outer edges cap the rail.
export function computeTimelineDock({ width, height, mandalaWidth, side = 4, safeBottom = 0, kind = 'day', controlWidth = TIMELINE_SIDE_CONTROL_WIDTH }) {
  const gutter = Math.max(24, side);
  const available = width - 2 * (gutter + controlWidth + TIMELINE_CONTROL_GAP);
  const railWidth = Math.max(1, Math.min(width - 2 * gutter, Math.max(mandalaWidth, available)));
  const inline = kind !== 'chronicle' || available >= mandalaWidth;
  const backingHeight = TIMELINE_BAR_HEIGHT + safeBottom;
  const dockHeight = inline ? backingHeight : TIMELINE_WITH_DATES_HEIGHT + safeBottom;
  return { kind, mode: inline ? 'inline' : 'stacked', height: dockHeight, backingHeight, gutter, controlWidth,
    rail: { x: (width - railWidth) / 2, y: height - safeBottom - DAY_CONTROL_HEIGHT, width: railWidth, height: DAY_CONTROL_HEIGHT } };
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
  // Navigation includes the full fixed surface, including its white margins.
  // Fitting insets only position the drawing within that field.
  const first = project(rect.left, rect.top), last = project(rect.right, rect.bottom);
  const viewport = { x: first.x, y: first.y, width: last.x - first.x, height: last.y - first.y };
  return { area, min, viewport };
}
