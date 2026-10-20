export const DAY_CONTROL_HEIGHT = 48;
export const DAY_CONTROL_TOP_CLEARANCE = 20;
const GAP = 4;
const RETURNS_SHEET_REFERENCE_WIDTH = 1126;
// The backing is compact; the existing 44px range target remains unchanged.
export const TIMELINE_BAR_HEIGHT = 40.8;
// Keep the complete focus/error frame and a quiet gap above the rail backing.
export const TIMELINE_DATE_HEIGHT = 44;
export const TIMELINE_WITH_DATES_HEIGHT = TIMELINE_BAR_HEIGHT + TIMELINE_DATE_HEIGHT + GAP;
const TIMELINE_SIDE_CONTROL_WIDTH = 160;
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));

// Both side panels share one space decision. On a phone or when the chart
// would have less than 320px, the panels overlay the unchanged canvas instead.
export function computeSidePanelLayout({ width, phone = false, left = false, right = false, leftWidth = 0, rightWidth = 0 }) {
  const leftSpace = left ? Math.max(0, leftWidth) : 0;
  const rightSpace = right ? Math.max(0, rightWidth) : 0;
  const remaining = width - leftSpace - rightSpace;
  return !phone && remaining >= 320
    ? { mode: 'side', left: leftSpace, right: rightSpace, width: remaining }
    : { mode: 'overlay', left: 0, right: 0, width };
}

// CSS pixels throughout. The camera later converts these insets through the SVG
// screen matrix. Fit the full painted envelope at the same scale in every mode.
// Center it naturally; use available headroom only to clear the potential footer.
export function computeStudioLayout({ footprint, width, height, side = 4, top = 112, bottom = TIMELINE_BAR_HEIGHT, footerHeight = TIMELINE_WITH_DATES_HEIGHT }) {
  side = clamp(side, 0, width / 4);
  top = clamp(top, 0, height * .49);
  bottom = clamp(bottom, 0, height * .49);
  const cameraBottom = Math.min(bottom + DAY_CONTROL_TOP_CLEARANCE, height * .49);
  const area = { x: side, y: top, width: Math.max(1, width - 2 * side), height: Math.max(1, height - top - cameraBottom) };
  const diameter = Math.min(area.width, area.height), scale = diameter / footprint.frame.bounds.width;
  const center = { x: width / 2, y: top + area.height / 2 };
  // Enlarged source blocks and their outward journeys clear the planet lanes.
  // Include the final content scale so neither column is clipped.
  const columnLeft = center.x + footprint.columns.left * scale;
  const columnRight = center.x + footprint.columns.right * scale;
  const showMandalaColumns = columnLeft >= area.x + GAP && columnRight <= width - side - GAP;
  const mandalaRadius = footprint.radius * scale;
  const bottomOfMandala = center.y + mandalaRadius;
  // A second row never changes scale or pushes Home against the top when it
  // already fits. The open space between dates leaves the outer planets visible.
  const offsetY = Math.max(top - (center.y - mandalaRadius), Math.min(0, height - footerHeight - GAP - bottomOfMandala));
  area.y += offsetY;
  center.y += offsetY;
  return { area, scale, center, mandalaRadius, columns: { left: columnLeft, right: columnRight }, showMandalaColumns, insets: { side, top, bottom: cameraBottom, offsetY } };
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

// Every mode shares the current free chart area. The natural rail length still
// comes from full-studio Home calculations; only the available width limits it.
// Dates stay above the backing, independently of live zoom or timeline mode.
export function computeTimelineDock({ width, height, chartWidth, side = 4, safeBottom = 0, kind = 'day', controlWidth = TIMELINE_SIDE_CONTROL_WIDTH, area = { x: 0, width } }) {
  const gutter = Math.max(side, Math.min(24, (area.width - 2 * controlWidth) / 2));
  const railWidth = Math.max(1, Math.min(area.width - 2 * gutter, chartWidth));
  const railLeft = area.x + (area.width - railWidth) / 2;
  const inline = kind !== 'chronicle';
  const backingHeight = TIMELINE_BAR_HEIGHT + safeBottom;
  const dockHeight = inline ? backingHeight : TIMELINE_WITH_DATES_HEIGHT + safeBottom;
  return { kind, mode: inline ? 'inline' : 'stacked', height: dockHeight, backingHeight, gutter, controlWidth,
    dates: { x: area.x + gutter, y: height - safeBottom - TIMELINE_WITH_DATES_HEIGHT,
      width: Math.max(1, area.width - 2 * gutter), height: TIMELINE_DATE_HEIGHT },
    rail: { x: railLeft, y: height - safeBottom - DAY_CONTROL_HEIGHT, width: railWidth, height: DAY_CONTROL_HEIGHT } };
}
