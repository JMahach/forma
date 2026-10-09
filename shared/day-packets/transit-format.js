import { MOMENT_PLANETS, MOMENT_COLUMN_COUNT, validMomentValue } from './moment-columns.js';
import { validOrder } from './float64-codec.js';

// Binary layout version. calculationVersion separately identifies the numeric inputs.
export const TRANSIT_DAY_VERSION = '2';
export const TRANSIT_PLANETS = MOMENT_PLANETS;
// Protocol column order is fixed; never derive it from the UI catalogue.
export const TRANSIT_SAMPLES = 1440;
// Personality, Design, Design UTC seconds and the exact 88° search residual.
export const TRANSIT_DAY_COLUMNS = MOMENT_COLUMN_COUNT;
export const TRANSIT_PAYLOAD_BYTES = TRANSIT_SAMPLES * TRANSIT_DAY_COLUMNS * 8;
export const TRANSIT_MAX_HEADER_BYTES = 4096;
export const failTransitPacket = () => { throw new Error('Некорректный пакет дневного транзита.'); };
export const validTransitValue = validMomentValue;

export function validateTransitMetadata(header) {
  if (!header || header.version !== TRANSIT_DAY_VERSION || header.samples !== TRANSIT_SAMPLES || header.stepSeconds !== 60
    || !Array.isArray(header.orders) || header.orders.length !== TRANSIT_DAY_COLUMNS || !header.orders.every(validOrder)
    || typeof header.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(header.date)
    || header.startUtc !== `${header.date}T00:00:00Z`) return failTransitPacket();
  const parsed = new Date(header.startUtc);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== header.date) return failTransitPacket();
  if (header.calculationVersion !== undefined && (typeof header.calculationVersion !== 'string' || !/^[a-f0-9]{64}$/.test(header.calculationVersion))) return failTransitPacket();
  if (header.nodeModel !== 'true' || header.zodiac !== 'tropical-geocentric-apparent') return failTransitPacket();
  for (const key of ['engine', 'ephemeris', 'timezoneDatabase']) {
    if (typeof header[key] !== 'string' || !header[key] || header[key].length > 256) return failTransitPacket();
  }
  return header;
}
