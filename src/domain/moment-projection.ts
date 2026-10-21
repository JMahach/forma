import type { Activation, ChartData } from '../../shared/chart-types.ts';
import type { NumericMoment } from '../../shared/day-packets/moment-columns.ts';
import type { ChartInput } from './chart-composition.ts';
interface LongitudeProjection { activations: readonly Activation[]; gates: readonly number[] }
import { gatePositionAtLongitude } from './gate-wheel.ts';
import { PLANET_IDS } from './planets.ts';

const snapshots = new WeakSet<readonly number[]>(), projections = new WeakMap<readonly number[], { planets: readonly string[]; result: LongitudeProjection }>();
const empty = Object.freeze([]);

// Only owned numeric snapshots are reusable; a frozen caller object can still
// contain mutable children or accessors. Day and Lifetime share these exact arrays.
export function snapshotLongitudes(values: readonly number[]) {
  if (snapshots.has(values)) return values;
  const snapshot = Object.freeze([...values]);
  snapshots.add(snapshot);
  return snapshot;
}

export function projectLongitudes(longitudes: readonly number[], planets: readonly string[]): LongitudeProjection {
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

// Day and Lifetime present the same UTC chart. Their adapters own validation,
// cache lifetime and provenance; the moment keeps its exact timestamp.
export function projectMomentChart(moment: Omit<NumericMoment, 'design'> & { design?: NumericMoment['design'] }, planets: readonly string[], metadata: ChartInput): Readonly<ChartData> {
  const personality = projectLongitudes(moment.longitudes, planets);
  const design = moment.design ? projectLongitudes(moment.design.longitudes, planets) : null;
  const utc = moment.utc;
  return Object.freeze({ source: 'transit',
    personality: personality.gates, design: design?.gates || empty,
    activations: Object.freeze({ personality: personality.activations, design: design?.activations || empty }),
    utc, localDate: utc.slice(0, 10), localTime: utc.slice(11, 16),
    timezone: 'UTC', utcOffset: 'UTC+00:00', fold: 0, designUtc: moment.design?.designUtc || null,
    engine: metadata.engine, ephemeris: metadata.ephemeris, timezoneDatabase: metadata.timezoneDatabase,
    nodeModel: metadata.nodeModel, zodiac: metadata.zodiac, designArcResidualDegrees: moment.design?.designArcResidualDegrees ?? null,
    verification: metadata.verification });
}
