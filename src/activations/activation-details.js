import { GATE_WIDTH, LINE_WIDTH, GATE_LONGITUDE_START } from '../domain/gate-wheel.js';
// Longitude subtraction can lose one floating-point unit around a full circle.
const BOUNDARY_EPSILON = Number.EPSILON * 360;

const percentWithin = (offset, width) => Math.max(0, Math.min(100, offset / width * 100));

// Human Design substructure: 6 lines, 6 colors, 6 tones, then 5 bases.
// https://jovianarchive.com/blogs/deeper-mechanics-system-theory/substructure-and-birth-time
// The saved gate is authoritative; this deliberately does not duplicate the wheel.
export function activationDetails(entry) {
  if (!entry || !Number.isFinite(entry.longitude)
      || !Number.isInteger(entry.gate) || entry.gate < 1 || entry.gate > 64
      || !Number.isInteger(entry.line) || entry.line < 1 || entry.line > 6) return null;

  const remainder = (entry.longitude - GATE_LONGITUDE_START) % 360;
  const position = remainder < 0 ? remainder + 360 : remainder;
  const gateIndex = Math.floor(position / GATE_WIDTH);
  const gateOffset = position - gateIndex * GATE_WIDTH;
  // Match calculator.py's line calculation before descending into substructure.
  const lineIndex = Math.min(5, Math.floor(gateOffset / LINE_WIDTH));
  if (lineIndex + 1 !== entry.line) return null;

  let width = LINE_WIDTH;
  let offset = gateOffset - lineIndex * width;
  const rows = [
    { key: 'gate', label: 'Ворота', value: entry.gate, percent: percentWithin(gateOffset, GATE_WIDTH) },
    { key: 'line', label: 'Линия', value: entry.line, percent: percentWithin(offset, width) }
  ];

  for (const [key, label, count] of [['color', 'Цвет', 6], ['tone', 'Тон', 6], ['base', 'База', 5]]) {
    const childWidth = width / count;
    const scaled = offset / childWidth;
    const nearest = Math.round(scaled);
    // Correct only floating-point noise at an internal boundary. In particular,
    // do not round percentages before partitioning or carry into a parent row.
    const atBoundary = nearest > 0 && nearest < count
      && Math.abs(offset - nearest * childWidth) <= BOUNDARY_EPSILON;
    const index = Math.max(0, Math.min(count - 1, atBoundary ? nearest : Math.floor(scaled)));
    offset = Math.max(0, Math.min(childWidth, offset - index * childWidth));
    width = childWidth;
    rows.push({ key, label, value: index + 1, percent: percentWithin(offset, width) });
  }
  return rows;
}
