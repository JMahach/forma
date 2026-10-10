import { localDateAt, startOfLocalDate } from './day-timeline.js';

const DAY = 86400000, HOUR = 3600000, TICK_GAP = 40, EDGE_GAP = 12, MAX_TICKS = 24;
const pad = value => String(value).padStart(2, '0');
const isoDate = (year, month = 1, day = 1) => `${String(year).padStart(4, '0')}-${pad(month)}-${pad(day)}`;

function intervals(span) {
  if (span < DAY) return [1, 2, 3, 6, 12, 24].map(step => ({ unit: 'hour', step }));
  if (span < 60 * DAY) return [1, 2, 7, 14, 28, 56].map(step => ({ unit: 'day', step }));
  if (span < 548 * DAY) return [1, 2, 3, 6, 12, 24].map(step => ({ unit: 'month', step }));
  return [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000].map(step => ({ unit: 'year', step }));
}

function boundaries({ unit, step }, fromUtc, toUtc, firstDate, timeZone) {
  const [year, month] = firstDate.split('-').map(Number), result = [];
  let startIndex = null, endIndex = null;
  function append(utc, gridIndex) {
    if (utc === fromUtc) startIndex = gridIndex;
    if (utc === toUtc) endIndex = gridIndex;
    if (utc > fromUtc && utc < toUtc) result.push({ utc, gridIndex });
    return utc >= toUtc;
  }
  if (unit === 'hour') {
    const start = startOfLocalDate(firstDate, timeZone), duration = step * HOUR;
    for (let index = Math.ceil((fromUtc - start) / duration), utc = start + index * duration;
      utc <= toUtc; index++, utc += duration) append(utc, index);
  } else if (unit === 'year' || unit === 'month') {
    let index = unit === 'year' ? year : year * 12 + month - 1;
    index = Math.ceil(index / step) * step;
    for (; result.length <= 32; index += step) {
      const date = unit === 'year' ? isoDate(index) : isoDate(Math.floor(index / 12), index % 12 + 1);
      const boundary = startOfLocalDate(date, timeZone);
      if (!Number.isFinite(boundary) || append(boundary, index / step)) break;
    }
  } else {
    // Date ordinals choose calendar days, while the shared converter finds
    // their actual UTC boundary (a DST day need not contain 24 hours).
    const first = Date.parse(`${firstDate}T00:00:00Z`) / DAY;
    const origin = step >= 7 ? 4 : 0; // Monday, 5 January 1970, for whole weeks.
    for (let index = origin + Math.ceil((first - origin) / step) * step; result.length <= 32; index += step) {
      const date = new Date(index * DAY).toISOString().slice(0, 10);
      const boundary = startOfLocalDate(date, timeZone);
      if (!Number.isFinite(boundary)) break;
      // A skipped local date lands on the next existing date. Keep the tick,
      // but only name it as a regular boundary if that actual date fits the grid.
      const actualDate = timeZone === 'UTC' ? date : localDateAt(boundary, timeZone);
      const gridIndex = (Date.parse(`${actualDate}T00:00:00Z`) / DAY - origin) / step;
      if (append(boundary, Number.isInteger(gridIndex) ? gridIndex : null)) break;
    }
  }
  return { interior: result, startIndex, endIndex };
}

// The two outer ticks represent the exact inclusive bounds. Intermediate
// ticks use local calendar boundaries and one shared interval for the rail.
// gridIndex identifies regular boundaries for captions; arbitrary edges and
// skipped dates that land outside the selected calendar phase carry null.
export function calendarTimelineTicks({ fromUtc, toUtc, timeZone = 'UTC', width } = {}) {
  if (![fromUtc, toUtc, width].every(Number.isFinite) || toUtc < fromUtc || width <= 0
    || !Number.isFinite(new Date(fromUtc).getTime()) || !Number.isFinite(new Date(toUtc).getTime())) return [];
  const firstDate = localDateAt(fromUtc, timeZone), lastDate = localDateAt(toUtc, timeZone);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(firstDate) || !/^\d{4}-\d{2}-\d{2}$/.test(lastDate)) return [];
  const span = toUtc - fromUtc;
  const first = { utc: fromUtc, position: 0, edge: 'start' };
  if (!span) {
    const interval = { unit: 'hour', step: 1 };
    return [{ ...first, ...interval, gridIndex: boundaries(interval, fromUtc, toUtc, firstDate, timeZone).startIndex }];
  }
  const last = { utc: toUtc, position: 1, edge: 'end' };
  let grid;
  for (const interval of intervals(span)) {
    grid = boundaries(interval, fromUtc, toUtc, firstDate, timeZone);
    const candidates = grid.interior;
    if (candidates.length > 32) continue;
    const interior = candidates.map(({ utc, gridIndex }) => ({ utc, position: (utc - fromUtc) / span, ...interval, gridIndex }))
      .filter(mark => mark.position * width >= EDGE_GAP && (1 - mark.position) * width >= EDGE_GAP);
    if (interior.length + 2 > MAX_TICKS) continue;
    if (interior.some((mark, index) => index > 0 && (mark.position - interior[index - 1].position) * width < TICK_GAP)) continue;
    return [{ ...first, ...interval, gridIndex: grid.startIndex }, ...interior, { ...last, ...interval, gridIndex: grid.endIndex }];
  }
  const interval = intervals(span).at(-1);
  return [{ ...first, ...interval, gridIndex: grid.startIndex }, { ...last, ...interval, gridIndex: grid.endIndex }];
}
