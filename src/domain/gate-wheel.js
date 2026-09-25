// Shared longitude rules, independent of SVG, the DOM and selection state.
// server/calculator.py uses the same tropical wheel; parity tests guard the
// Python/JavaScript boundary. Intervals are half-open, with no display rounding.
export const GATE_ORDER = Object.freeze([
  41, 19, 13, 49, 30, 55, 37, 63, 22, 36, 25, 17, 21, 51, 42, 3,
  27, 24, 2, 23, 8, 20, 16, 35, 45, 12, 15, 52, 39, 53, 62, 56,
  31, 33, 7, 4, 29, 59, 40, 64, 47, 6, 46, 18, 48, 57, 32, 50,
  28, 44, 1, 43, 14, 34, 9, 5, 26, 11, 10, 58, 38, 54, 61, 60,
]);
export const GATE_LONGITUDE_START = 302;
export const GATE_WIDTH = 360 / GATE_ORDER.length;
export const LINE_WIDTH = GATE_WIDTH / 6;

export function normalizeLongitude(longitude) {
  const remainder = longitude % 360;
  const value = remainder < 0 ? remainder + 360 : remainder;
  // Avoid negative zero, and a rounded 360 for subnormal negative inputs.
  return value === 0 || value === 360 ? 0 : value;
}

export function gatePositionAtLongitude(longitude) {
  if (!Number.isFinite(longitude)) throw new TypeError('Longitude must be a finite number');
  longitude = normalizeLongitude(longitude);
  const offset = normalizeLongitude(longitude - GATE_LONGITUDE_START);
  const index = Math.floor(offset / GATE_WIDTH);
  const line = Math.min(6, Math.floor((offset - index * GATE_WIDTH) / LINE_WIDTH) + 1);
  return { longitude, gate: GATE_ORDER[index], line };
}
