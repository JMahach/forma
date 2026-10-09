import { cycleTimeZone } from './cycles.js';
import { localDateAt } from './day-timeline.js';

let cachedKey = '', cachedYear = null;
function startOfDate(date, timeZone) {
  const midnight = Date.parse(`${date}T00:00:00Z`);
  let low = midnight - 36 * 3600000, high = midnight + 36 * 3600000;
  // Search the actual boundary, including historical offsets with seconds.
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (localDateAt(middle, timeZone) < date) low = middle + 1;
    else high = middle;
  }
  return low;
}

// A filter projects the existing personal span; it never changes its owner.
export function returnsVisibleWindow(natal, year, { minUtc, maxUtc }) {
  if (!Number.isFinite(minUtc) || !Number.isFinite(maxUtc) || maxUtc < minUtc) return null;
  if (!Number.isInteger(year)) return { minUtc, maxUtc };
  const zone = cycleTimeZone(natal?.timezone), key = `${zone}:${year}`;
  if (key !== cachedKey) {
    cachedYear = { minUtc: startOfDate(`${year}-01-01`, zone), maxUtc: startOfDate(`${year + 1}-01-01`, zone) - 1 };
    cachedKey = key;
  }
  const from = Math.max(minUtc, cachedYear.minUtc), to = Math.min(maxUtc, cachedYear.maxUtc);
  return to >= from ? { minUtc: from, maxUtc: to } : null;
}
