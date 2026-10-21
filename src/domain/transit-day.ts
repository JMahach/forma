import type { TransitDay } from '../../shared/day-packets/transit-format.ts';
import { PERSONALITY_COLUMN, DESIGN_COLUMN, DESIGN_UNIX_SECONDS_COLUMN, DESIGN_RESIDUAL_COLUMN } from '../../shared/day-packets/moment-columns.ts';
import { projectMomentChart, snapshotLongitudes } from './moment-projection.ts';
import { TRANSIT_PLANETS, failTransitPacket as fail } from '../../shared/day-packets/transit-format.ts';

// The numeric day belongs to its data cache. Materialized charts are temporary;
// the active view alone owns its current chart, without a history of minutes.
export function transitSampleAt(day: TransitDay, index: number) {
  if (!Number.isInteger(index) || index < 0 || index >= day.samples) return fail();
  const utc = new Date(Date.parse(day.startUtc) + index * 60000).toISOString().replace('.000Z', 'Z');
  const designSeconds = day.columns[DESIGN_UNIX_SECONDS_COLUMN][index];
  return Object.freeze({ utc, longitudes: snapshotLongitudes(day.columns.slice(PERSONALITY_COLUMN, DESIGN_COLUMN).map(column => column[index])),
    design: Object.freeze({ utc, longitudes: snapshotLongitudes(day.columns.slice(DESIGN_COLUMN, DESIGN_UNIX_SECONDS_COLUMN).map(column => column[index])),
      designUtc: new Date(designSeconds * 1000).toISOString().replace('.000Z', 'Z'),
      designArcResidualDegrees: day.columns[DESIGN_RESIDUAL_COLUMN][index] }) });
}

export function transitChartAt(day: TransitDay, index: number) {
  return projectMomentChart(transitSampleAt(day, index), TRANSIT_PLANETS, {
    engine: day.engine, ephemeris: day.ephemeris, timezoneDatabase: day.timezoneDatabase,
    nodeModel: day.nodeModel, zodiac: day.zodiac,
    verification: 'Lossless minute-grid Swiss Ephemeris transit; official Human Design reference-chart validation pending.' });
}
