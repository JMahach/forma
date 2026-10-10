import { cycleTimeZone } from './cycles.js';
import { startOfLocalDate } from './day-timeline.js';

let cachedKey = '', cachedYear = null;
// A filter projects the existing personal span; it never changes its owner.
export function returnsVisibleWindow(natal, year, { minUtc, maxUtc }) {
  if (!Number.isFinite(minUtc) || !Number.isFinite(maxUtc) || maxUtc < minUtc) return null;
  if (!Number.isInteger(year)) return { minUtc, maxUtc };
  const zone = cycleTimeZone(natal?.timezone), key = `${zone}:${year}`;
  if (key !== cachedKey) {
    cachedYear = { minUtc: startOfLocalDate(`${year}-01-01`, zone), maxUtc: startOfLocalDate(`${year + 1}-01-01`, zone) - 1 };
    cachedKey = key;
  }
  const from = Math.max(minUtc, cachedYear.minUtc), to = Math.min(maxUtc, cachedYear.maxUtc);
  return to >= from ? { minUtc: from, maxUtc: to } : null;
}
