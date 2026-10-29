import { decodeNatalDay, decodeTransitDay } from './day-packets/decode.ts';

// One-time storage transition. Readers switch together in P01b/P18; this module
// has no storage or calculator dependency and does not admit records as ready.
interface CalculationMetadata {
  calculationVersion?: unknown;
  cyclesVersion?: unknown;
  cacheVersion?: unknown;
  engine?: string;
}
type WithoutCalculationVersion<T> = Omit<T, keyof CalculationMetadata> & {engine?:string};
const engineName = (engine?:string) => engine?.replace(/^Swiss Ephemeris \d+(?:\.\d+)*$/, 'Swiss Ephemeris');

export function migrateCalculationMetadata<T extends CalculationMetadata>(input:T):WithoutCalculationVersion<T> {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || input.engine !== undefined && typeof input.engine !== 'string') throw new TypeError('Invalid stored calculation metadata');
  const {calculationVersion, cyclesVersion, cacheVersion, engine, ...content} = input;
  const name = engineName(engine);
  if (!['calculationVersion','cyclesVersion','cacheVersion'].some(key => Object.hasOwn(input, key)) && name === engine) return input;
  return {...content, ...(engine === undefined ? {} : {engine:name})};
}

export function migrateLifetimeFileMetadata<T extends CalculationMetadata & {provenance?:unknown;compatibility?:unknown}>(input:T) {
  const migrated = migrateCalculationMetadata(input);
  if (!Object.hasOwn(migrated, 'provenance') && !Object.hasOwn(migrated, 'compatibility')) return migrated;
  const {provenance, compatibility, ...metadata} = migrated;
  return metadata;
}

// Preserve predictor orders and the encoded Float64 payload verbatim. Decoding
// validates completeness/numbers once; no numerical projection or encoding runs.
export function migrateDayPacket(kind:'natal'|'transit', packet:Uint8Array):Uint8Array {
  const {columns, ...metadata} = kind === 'natal' ? decodeNatalDay(packet) : decodeTransitDay(packet);
  const migrated = migrateCalculationMetadata(metadata);
  if (migrated === metadata) return packet;
  const oldLength = new DataView(packet.buffer, packet.byteOffset, packet.byteLength).getUint32(4, true);
  const header = new TextEncoder().encode(JSON.stringify(migrated));
  const result = new Uint8Array(packet.byteLength - oldLength + header.byteLength);
  result.set(packet.subarray(0, 4));
  new DataView(result.buffer).setUint32(4, header.byteLength, true);
  result.set(header, 8);
  result.set(packet.subarray(8 + oldLength), 8 + header.byteLength);
  return result;
}

type CalculationKind = 'natal'|'transit'|'return-events'|'return-charts';
const oldRevision = /^[a-f0-9]{64}$/;
const legacyRevision = (value:unknown) => value === null || typeof value === 'string' && oldRevision.test(value);
const invalidKey = ():never => { throw new TypeError('Unknown stored calculation key'); };

function returnKey(key:string, action:'events'|'chart') {
  const parts:unknown = JSON.parse(key);
  if (!Array.isArray(parts) || parts[0] !== action) return invalidKey();
  if (parts.length === 6 && legacyRevision(parts[1])) return JSON.stringify([parts[0], ...parts.slice(2)]);
  if (parts.length === 5 && typeof parts[1] === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(parts[1])) return key;
  return invalidKey();
}

export function migrateCalculationKey(kind:CalculationKind, key:string):string {
  if (kind === 'natal') {
    const match = /^natal-day:(?:([a-f0-9]{64}):)?(\d+:\d{4}-\d{2}-\d{2}:.+)$/.exec(key);
    return match ? `natal-day:${match[2]}` : invalidKey();
  }
  if (kind === 'transit') {
    const match = /^(?:[a-f0-9]{64}:)?(\d{4}-\d{2}-\d{2})$/.exec(key);
    return match ? match[1] : invalidKey();
  }
  return returnKey(key, kind === 'return-events' ? 'events' : 'chart');
}
