import { projectLongitudes } from './moment-projection.js';
import { CHART_DAY_PLANETS, failChartDayPacket as fail } from '../../shared/day-packets/natal-format.js';
const iso = value => new Date(value).toISOString().replace('.000Z', 'Z');

function minuteAt(day, index) {
  if (!Number.isInteger(index) || index < 0 || index >= day.samples) return fail();
  const segment = day.segments.findLast(segment => segment.index <= index);
  const moment = Date.parse(segment.startUtc) + (index - segment.index) * 60000;
  return { segment, moment };
}
export function chartDayMinute(day, index) {
  const { segment, moment } = minuteAt(day, index);
  return { index, utc: iso(moment), birthTime: iso(moment + segment.offsetSeconds * 1000).slice(11, 16), utcOffset: segment.utcOffset, fold: segment.fold };
}
export function chartDayIndexAt(day, utc) {
  const moment = typeof utc === 'number' ? utc : Date.parse(utc);
  if (!Number.isFinite(moment)) return 0;
  let low = 0, high = day.samples - 1;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (minuteAt(day, mid).moment <= moment) low = mid + 1; else high = mid;
  }
  return minuteAt(day, low).moment > moment ? Math.max(0, low - 1) : low;
}
export function chartAtMinute(day, index, originalChart) {
  const minute = chartDayMinute(day, index);
  const [personality, design] = [0, 11].map(offset => projectLongitudes(
    CHART_DAY_PLANETS.map((_, column) => day.columns[offset + column][index]), CHART_DAY_PLANETS));
  const activations = { personality: personality.activations, design: design.activations };
  return { ...originalChart, source: 'calculated', birthDate: day.date, timezone: day.timezone,
    utc: minute.utc, birthTime: minute.birthTime, utcOffset: minute.utcOffset, fold: minute.fold,
    activations, personality: personality.gates, design: design.gates,
    designUtc: iso(day.columns[22][index] * 1000), designArcResidualDegrees: day.columns[23][index],
    engine: day.engine, ephemeris: day.ephemeris, timezoneDatabase: day.timezoneDatabase, nodeModel: day.nodeModel, zodiac: day.zodiac };
}
