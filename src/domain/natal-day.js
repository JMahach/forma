import { PERSONALITY_COLUMN, DESIGN_COLUMN, DESIGN_UNIX_SECONDS_COLUMN, DESIGN_RESIDUAL_COLUMN } from '../../shared/day-packets/moment-columns.js';
import { projectLongitudes, snapshotLongitudes } from './moment-projection.js';
import { NATAL_DAY_PLANETS, failNatalDayPacket as fail } from '../../shared/day-packets/natal-format.js';
const iso = value => new Date(value).toISOString().replace('.000Z', 'Z');

function minuteAt(day, index) {
  if (!Number.isInteger(index) || index < 0 || index >= day.samples) return fail();
  const segment = day.segments.findLast(segment => segment.index <= index);
  const moment = Date.parse(segment.startUtc) + (index - segment.index) * 60000;
  return { segment, moment };
}
export function natalDayMinute(day, index) {
  const { segment, moment } = minuteAt(day, index);
  return { index, utc: iso(moment), birthTime: iso(moment + segment.offsetSeconds * 1000).slice(11, 16), utcOffset: segment.utcOffset, fold: segment.fold };
}
export function natalDayIndexAt(day, utc) {
  const moment = typeof utc === 'number' ? utc : Date.parse(utc);
  if (!Number.isFinite(moment)) return 0;
  let low = 0, high = day.samples - 1;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (minuteAt(day, mid).moment <= moment) low = mid + 1; else high = mid;
  }
  return minuteAt(day, low).moment > moment ? Math.max(0, low - 1) : low;
}
// A local minute can land on a UTC second, and repeated hours are distinct
// samples. Always use packet segments rather than rounding UTC to :00.
export function natalDayNearestIndex(day, milliseconds, { min = -Infinity, max = Infinity, round = Math.round } = {}) {
  if (!Number.isFinite(milliseconds) || milliseconds < minuteAt(day, 0).moment || milliseconds > minuteAt(day, day.samples - 1).moment) return null;
  let low = natalDayIndexAt(day, min), high = natalDayIndexAt(day, max);
  if (min === -Infinity) low = 0;
  if (max === Infinity) high = day.samples - 1;
  if (minuteAt(day, low).moment < min) low++;
  if (low > high || low >= day.samples || minuteAt(day, high).moment > max) return null;
  const floor = Math.max(low, Math.min(high, natalDayIndexAt(day, milliseconds)));
  const ceil = Math.min(high, floor + (minuteAt(day, floor).moment < milliseconds ? 1 : 0));
  if (round === Math.floor) return floor;
  if (round === Math.ceil) return ceil;
  return milliseconds - minuteAt(day, floor).moment < minuteAt(day, ceil).moment - milliseconds ? floor : ceil;
}
export function natalDaySampleAt(day, index) {
  const utc = natalDayMinute(day, index).utc;
  return { utc, longitudes: snapshotLongitudes(day.columns.slice(PERSONALITY_COLUMN, DESIGN_COLUMN).map(column => column[index])),
    design: { utc, longitudes: snapshotLongitudes(day.columns.slice(DESIGN_COLUMN, DESIGN_UNIX_SECONDS_COLUMN).map(column => column[index])),
      designUtc: iso(day.columns[DESIGN_UNIX_SECONDS_COLUMN][index] * 1000),
      designArcResidualDegrees: day.columns[DESIGN_RESIDUAL_COLUMN][index] } };
}
export function chartAtMinute(day, index, originalChart) {
  const minute = natalDayMinute(day, index);
  const [personality, design] = [PERSONALITY_COLUMN, DESIGN_COLUMN].map(offset => projectLongitudes(
    NATAL_DAY_PLANETS.map((_, column) => day.columns[offset + column][index]), NATAL_DAY_PLANETS));
  const activations = { personality: personality.activations, design: design.activations };
  return { ...originalChart, source: 'calculated', birthDate: day.date, timezone: day.timezone,
    utc: minute.utc, birthTime: minute.birthTime, utcOffset: minute.utcOffset, fold: minute.fold,
    activations, personality: personality.gates, design: design.gates,
    designUtc: iso(day.columns[DESIGN_UNIX_SECONDS_COLUMN][index] * 1000), designArcResidualDegrees: day.columns[DESIGN_RESIDUAL_COLUMN][index],
    engine: day.engine, ephemeris: day.ephemeris, timezoneDatabase: day.timezoneDatabase, nodeModel: day.nodeModel, zodiac: day.zodiac };
}
