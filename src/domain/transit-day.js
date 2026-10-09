import { PERSONALITY_COLUMN, DESIGN_COLUMN, DESIGN_UNIX_SECONDS_COLUMN, DESIGN_RESIDUAL_COLUMN } from '../../shared/day-packets/moment-columns.js';
import { projectMomentChart, snapshotLongitudes } from './moment-projection.js';
import { TRANSIT_PLANETS, failTransitPacket as fail } from '../../shared/day-packets/transit-format.js';

// The numeric day belongs to its data cache. Materialized charts are temporary;
// the active view alone owns its current chart, without a history of minutes.
export function transitSampleAt(day, index) {
  if (!Number.isInteger(index) || index < 0 || index >= day.samples) return fail();
  const utc = new Date(Date.parse(day.startUtc) + index * 60000).toISOString().replace('.000Z', 'Z');
  const designSeconds = day.columns[DESIGN_UNIX_SECONDS_COLUMN][index];
  return Object.freeze({ utc, longitudes: snapshotLongitudes(day.columns.slice(PERSONALITY_COLUMN, DESIGN_COLUMN).map(column => column[index])),
    design: Object.freeze({ utc, longitudes: snapshotLongitudes(day.columns.slice(DESIGN_COLUMN, DESIGN_UNIX_SECONDS_COLUMN).map(column => column[index])),
      designUtc: new Date(designSeconds * 1000).toISOString().replace('.000Z', 'Z'),
      designArcResidualDegrees: day.columns[DESIGN_RESIDUAL_COLUMN][index] }) });
}

export function transitChartAt(day, index) {
  return projectMomentChart(transitSampleAt(day, index), TRANSIT_PLANETS, { id: 'current-transit', createdAt: day.startUtc,
    engine: day.engine, ephemeris: day.ephemeris, timezoneDatabase: day.timezoneDatabase,
    nodeModel: day.nodeModel, zodiac: day.zodiac,
    verification: 'Lossless minute-grid Swiss Ephemeris transit; official Human Design reference-chart validation pending.' });
}
