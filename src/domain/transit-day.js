import { gatePositionAtLongitude } from './gate-wheel.js';
import { PLANET_IDS as DISPLAY_PLANETS } from './planets.js';
import { TRANSIT_PLANETS, failTransitPacket as fail } from '../../shared/day-packets/transit-format.js';

// Packet column positions live here for both the day chart and reuse by Years.
export function transitSampleAt(day, index) {
  if (!Number.isInteger(index) || index < 0 || index >= day.samples) return fail();
  const utc = new Date(Date.parse(day.startUtc) + index * 60000).toISOString().replace('.000Z', 'Z');
  return { utc, longitudes: day.columns.slice(0, 11).map(column => column[index]),
    design: { utc, longitudes: day.columns.slice(11, 22).map(column => column[index]),
      designUtc: new Date(day.columns[22][index] * 1000).toISOString().replace('.000Z', 'Z'),
      designArcResidualDegrees: day.columns[23][index] } };
}

export function transitChartAt(day, index) {
  const sample = transitSampleAt(day, index);
  const activations = Object.fromEntries(['personality', 'design'].map((source, side) => {
    const longitudes = side === 0 ? sample.longitudes : sample.design.longitudes;
    const values = Object.fromEntries(TRANSIT_PLANETS.map((planet, column) => [planet, longitudes[column]]));
    values.earth = (values.sun + 180) % 360;
    values.south_node = (values.north_node + 180) % 360;
    return [source, DISPLAY_PLANETS.map(planet => ({ planet, ...gatePositionAtLongitude(values[planet]) }))];
  }));
  const utc = sample.utc;
  return { id: 'current-transit', name: 'Транзит', source: 'transit',
    personality: [...new Set(activations.personality.map(a => a.gate))].sort((a, b) => a - b),
    design: [...new Set(activations.design.map(a => a.gate))].sort((a, b) => a - b),
    activations, utc, birthDate: utc.slice(0, 10), birthTime: utc.slice(11, 16),
    birthPlace: '', timezone: 'UTC', utcOffset: 'UTC+00:00', fold: 0,
    designUtc: sample.design.designUtc, cityId: null, city: null,
    engine: day.engine, ephemeris: day.ephemeris, timezoneDatabase: day.timezoneDatabase,
    nodeModel: day.nodeModel, zodiac: day.zodiac, designArcResidualDegrees: sample.design.designArcResidualDegrees,
    updatedAt: utc, createdAt: day.startUtc, note: '',
    verification: 'Lossless minute-grid Swiss Ephemeris transit; official Human Design reference-chart validation pending.' };
}
