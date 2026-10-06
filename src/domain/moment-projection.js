import { gatePositionAtLongitude } from './gate-wheel.js';
import { PLANET_IDS } from './planets.js';

const snapshots = new WeakSet(), projections = new WeakMap();
const empty = Object.freeze([]);

// Only owned numeric snapshots are reusable; a frozen caller object can still
// contain mutable children or accessors. Day and Years share these exact arrays.
export function snapshotLongitudes(values) {
  if (snapshots.has(values)) return values;
  const snapshot = Object.freeze([...values]);
  snapshots.add(snapshot);
  return snapshot;
}

export function projectLongitudes(longitudes, planets) {
  const cached = projections.get(longitudes);
  if (cached && planets.length === cached.planets.length && planets.every((planet, index) => planet === cached.planets[index])) return cached.result;
  const values = Object.fromEntries(planets.map((planet, index) => [planet, longitudes[index]]));
  values.earth = (values.sun + 180) % 360;
  values.south_node = (values.north_node + 180) % 360;
  const activations = Object.freeze(PLANET_IDS.map(planet => Object.freeze({ planet, ...gatePositionAtLongitude(values[planet]) })));
  const gates = Object.freeze([...new Set(activations.map(entry => entry.gate))].sort((a, b) => a - b));
  const result = Object.freeze({ activations, gates });
  if (snapshots.has(longitudes)) projections.set(longitudes, { planets: [...planets], result });
  return result;
}

// Day and Years present the same UTC chart. Their adapters own validation,
// cache lifetime and provenance; the moment keeps its exact timestamp.
export function projectMomentChart(moment, planets, metadata) {
  const personality = projectLongitudes(moment.longitudes, planets);
  const design = moment.design ? projectLongitudes(moment.design.longitudes, planets) : null;
  const utc = moment.utc;
  return Object.freeze({ id: metadata.id, name: 'Транзит', source: 'transit',
    personality: personality.gates, design: design?.gates || empty,
    activations: Object.freeze({ personality: personality.activations, design: design?.activations || empty }),
    utc, birthDate: utc.slice(0, 10), birthTime: utc.slice(11, 16),
    birthPlace: '', timezone: 'UTC', utcOffset: 'UTC+00:00', fold: 0, designUtc: moment.design?.designUtc || null, cityId: null, city: null,
    engine: metadata.engine, ephemeris: metadata.ephemeris, timezoneDatabase: metadata.timezoneDatabase,
    nodeModel: metadata.nodeModel, zodiac: metadata.zodiac, designArcResidualDegrees: moment.design?.designArcResidualDegrees ?? null,
    updatedAt: utc, createdAt: metadata.createdAt, note: '', verification: metadata.verification });
}
