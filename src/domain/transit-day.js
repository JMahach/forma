import { gatePositionAtLongitude } from './gate-wheel.js';
import { PLANET_IDS as DISPLAY_PLANETS } from './planets.js';
import { TRANSIT_PLANETS, failTransitPacket as fail } from '../../shared/day-packets/transit-format.js';

export function transitChartAt(day, index) {
  if (!Number.isInteger(index) || index < 0 || index >= day.samples) return fail();
  const values = Object.fromEntries(TRANSIT_PLANETS.map((planet, column) => [planet, day.columns[column][index]]));
  values.earth = (values.sun + 180) % 360;
  values.south_node = (values.north_node + 180) % 360;
  const personality = DISPLAY_PLANETS.map(planet => ({ planet, ...gatePositionAtLongitude(values[planet]) }));
  const utc = new Date(Date.parse(day.startUtc) + index * 60000).toISOString().replace('.000Z', 'Z');
  return { id: 'current-transit', name: 'Транзит', source: 'transit',
    personality: [...new Set(personality.map(a => a.gate))].sort((a, b) => a - b), design: [],
    activations: { personality, design: [] }, utc, birthDate: utc.slice(0, 10), birthTime: utc.slice(11, 16),
    birthPlace: '', timezone: 'UTC', utcOffset: 'UTC+00:00', fold: 0, designUtc: null, cityId: null, city: null,
    engine: day.engine, ephemeris: day.ephemeris, timezoneDatabase: day.timezoneDatabase,
    nodeModel: day.nodeModel, zodiac: day.zodiac, designArcResidualDegrees: null,
    updatedAt: utc, createdAt: day.startUtc, note: '',
    verification: 'Lossless minute-grid Swiss Ephemeris transit; official Human Design reference-chart validation pending.' };
}
