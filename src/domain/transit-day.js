import { projectMomentChart, snapshotLongitudes } from './moment-projection.js';
import { TRANSIT_PLANETS, failTransitPacket as fail } from '../../shared/day-packets/transit-format.js';

const visitedDays = new WeakMap();
const VISITED_MINUTES_PER_DAY = 32;
const chartMetadata = ['engine', 'ephemeris', 'timezoneDatabase', 'nodeModel', 'zodiac'];
function matchesSample(record, day, index) {
  if (record.startUtc !== day.startUtc || !Object.is(record.designSeconds, day.columns[22][index])
      || !Object.is(record.sample.design.designArcResidualDegrees, day.columns[23][index])) return false;
  for (let column = 0; column < 11; column++) {
    if (!Object.is(record.sample.longitudes[column], day.columns[column][index])
        || !Object.is(record.sample.design.longitudes[column], day.columns[11 + column][index])) return false;
  }
  return true;
}

// Packet column positions live here for both the day chart and reuse by Years.
// Float64 columns remain mutable, so compare this minute before reusing it.
// Retain visited minutes only; a whole day never becomes 1,440 chart objects.
function sampleRecordAt(day, index) {
  if (!Number.isInteger(index) || index < 0 || index >= day.samples) return fail();
  let visited = visitedDays.get(day);
  if (!visited) { visited = new Map(); visitedDays.set(day, visited); }
  let record = visited.get(index);
  if (record && matchesSample(record, day, index)) {
    visited.delete(index); visited.set(index, record);
    return record;
  }
  const utc = new Date(Date.parse(day.startUtc) + index * 60000).toISOString().replace('.000Z', 'Z');
  const designSeconds = day.columns[22][index];
  const sample = Object.freeze({ utc, longitudes: snapshotLongitudes(day.columns.slice(0, 11).map(column => column[index])),
    design: Object.freeze({ utc, longitudes: snapshotLongitudes(day.columns.slice(11, 22).map(column => column[index])),
      designUtc: new Date(designSeconds * 1000).toISOString().replace('.000Z', 'Z'),
      designArcResidualDegrees: day.columns[23][index] }) });
  record = { startUtc: day.startUtc, designSeconds, sample, chart: null };
  visited.delete(index); visited.set(index, record);
  if (visited.size > VISITED_MINUTES_PER_DAY) visited.delete(visited.keys().next().value);
  return record;
}

export function transitSampleAt(day, index) {
  return sampleRecordAt(day, index).sample;
}

export function transitChartAt(day, index) {
  const record = sampleRecordAt(day, index), { sample } = record;
  if (record.chart && chartMetadata.every(key => record.chart[key] === day[key])) return record.chart;
  record.chart = projectMomentChart(sample, TRANSIT_PLANETS, { id: 'current-transit', createdAt: day.startUtc,
    engine: day.engine, ephemeris: day.ephemeris, timezoneDatabase: day.timezoneDatabase,
    nodeModel: day.nodeModel, zodiac: day.zodiac,
    verification: 'Lossless minute-grid Swiss Ephemeris transit; official Human Design reference-chart validation pending.' });
  return record.chart;
}
