import type { ChartInput } from './chart-composition.ts';
export interface UtcRange { minUtc: number; maxUtc: number }
import { cycleTimeZone } from './cycles.ts';
import { startOfLocalDate } from './day-timeline.ts';

let cachedKey = '', cachedYear: UtcRange | null = null;
// A filter projects the existing personal span; it never changes its owner.
export function returnsVisibleWindow(natal: ChartInput | null | undefined, year: number | null, { minUtc: minimum, maxUtc: maximum }: { minUtc: number | null; maxUtc: number | null }) {
  if (!Number.isFinite(minimum) || !Number.isFinite(maximum) || maximum! < minimum!) return null;
  const minUtc = minimum!, maxUtc = maximum!;
  if (!Number.isInteger(year)) return { minUtc, maxUtc };
  const zone = cycleTimeZone(natal?.timezone), key = `${zone}:${year}`;
  if (key !== cachedKey) {
    cachedYear = { minUtc: startOfLocalDate(`${year}-01-01`, zone), maxUtc: startOfLocalDate(`${year! + 1}-01-01`, zone) - 1 };
    cachedKey = key;
  }
  const from = Math.max(minUtc, cachedYear!.minUtc), to = Math.min(maxUtc, cachedYear!.maxUtc);
  return to >= from ? { minUtc: from, maxUtc: to } : null;
}
