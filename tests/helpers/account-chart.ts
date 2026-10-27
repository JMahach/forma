import type { AccountChart } from '../../shared/chart-record-contract.ts';
const planets = ['sun','earth','moon','north_node','south_node','mercury','venus','mars','jupiter','saturn','uranus','neptune','pluto'];
export const chartId = (n: number) => n.toString(16).padStart(32, '0');
export function accountChart(n = 1, accountId = '1', revision = 1): AccountChart {
  const side = planets.map((planet, i) => ({planet, longitude: i * 20, gate: i + 1, line: 1}));
  return {id: chartId(n), accountId, revision, noteRevision: 1, publicRevision: revision,
    source: 'transit', name: 'Карта ' + n, note: 'Личная заметка',
    birthDate: '2000-01-01', birthTime: '12:00', birthPlace: '', utc: '2000-01-01T12:00:00Z',
    timezone: 'UTC', utcOffset: 'UTC+00:00', fold: 0, designUtc: '1999-10-10T01:00:00Z',
    designArcResidualDegrees: 1e-9, personality: side.map(a => a.gate), design: side.map(a => a.gate),
    activations: {personality: side, design: side}, city: null, cityId: null,
    engine: 'test', ephemeris: 'test', timezoneDatabase: 'test', nodeModel: 'true', zodiac: 'test',
    verification: 'test', calculationVersion: 'current'};
}


export function accountNatalChart(n = 1, accountId = '1', revision = 1): AccountChart {
  const city = {id: '1', name: 'Test city', country: 'GB', region: '', timezone: 'UTC', latitude: 0, longitude: 0};
  return {...accountChart(n, accountId, revision), source: 'calculated', cityId: city.id, city, birthPlace: city.name};
}
