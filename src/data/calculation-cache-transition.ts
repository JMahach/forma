import { migrateCalculationKey, migrateCalculationMetadata, migrateDayPacket } from '../../shared/calculation-storage-transition.ts';
import { estimateBytes } from './memory-cache.ts';

type Kind = Parameters<typeof migrateCalculationKey>[0];
interface Catalogue {
  id:string; kind:Kind|null; key:string; version?:string; bytes:number; lru:number;
  location:'data'|'legacy'; personalEpoch:number; legacyBytes?:number;
}
type RecordValue = Record<string, unknown>;
const request = <T>(opened:IDBRequest<T>) => new Promise<T>((resolve, reject) => {
  opened.onsuccess = () => resolve(opened.result); opened.onerror = () => reject(opened.error);
});
const invalid = ():never => { throw new TypeError('Invalid stored calculation'); };
function record(value:unknown):RecordValue {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : invalid();
}

function migrateReturnChart(source:RecordValue) {
  const chart = record(source.chart), migrated = migrateCalculationMetadata(chart);
  // An issued proof authenticates this historical label as well as the numbers.
  // Keep its signed snapshot intact; the label never controls cache eligibility.
  return typeof source.proof === 'string' && Object.hasOwn(chart, 'engine')
    ? {...migrated, engine:chart.engine} : migrated;
}

function migratePayload(kind:Kind, value:unknown, key:string):unknown {
  if (kind === 'natal') {
    if (!(value instanceof ArrayBuffer)) return invalid();
    return migrateDayPacket('natal', new Uint8Array(value)).buffer;
  }
  const source = record(value), migrated = {...migrateCalculationMetadata(source)};
  if (Object.hasOwn(migrated, 'key')) migrated.key = key;
  if (kind === 'transit') migrated.meta = migrateCalculationMetadata(record(source.meta));
  if (kind === 'return-charts') migrated.chart = migrateReturnChart(source);
  return migrated;
}

function bytes(value:unknown):Uint8Array|null {
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  return ArrayBuffer.isView(value) ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength) : null;
}
function sameObject(a:object, b:object):boolean {
  const left = bytes(a), right = bytes(b);
  if (left) return right !== null && sameBytes(left, right);
  if (right) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every(key => Object.hasOwn(b, key)
    && sameValue((a as RecordValue)[key], (b as RecordValue)[key]));
}
function sameBytes(a:Uint8Array, b:Uint8Array) {
  return a.length === b.length && a.every((value, i) => value === b[i]);
}
function sameValue(a:unknown, b:unknown):boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object') return false;
  if (a === null || b === null) return false;
  return sameObject(a, b);
}

function resultWithoutProof(kind:Kind, value:unknown) {
  if (kind === 'natal' || kind === 'transit') return value;
  // Two signed receipts can certify the same result. Keep the selected receipt
  // intact; authentication remains the server's responsibility when it is used.
  const {proof, ...result} = record(value);
  return kind === 'return-charts'
    ? {...result, chart:migrateCalculationMetadata(record(result.chart))} : result;
}

async function resolveCollision(tx:IDBTransaction, meta:Catalogue, value:unknown) {
  const destination = await request(tx.objectStore('catalogue').get(meta.id)) as Catalogue|undefined;
  if (!destination) return value;
  const existing = await request(tx.objectStore('payloads').get(meta.id));
  if (!existing) return invalid();
  if (destination.personalEpoch !== meta.personalEpoch) return invalid();
  if (!sameValue(resultWithoutProof(meta.kind!, existing.value), resultWithoutProof(meta.kind!, value))) return invalid();
  const selected = meta.lru >= destination.lru ? value : existing.value;
  meta.lru = Math.max(meta.lru, destination.lru);
  return selected;
}

async function writeData(tx:IDBTransaction, old:Catalogue, meta:Catalogue) {
  const payloads = tx.objectStore('payloads'), catalogue = tx.objectStore('catalogue');
  const source = await request(payloads.get(old.id));
  if (!source) return invalid();
  let value = migratePayload(meta.kind!, source.value, meta.key);
  if (old.id !== meta.id) value = await resolveCollision(tx, meta, value);
  const payload = {id:meta.id, value};
  meta.bytes = estimateBytes(payload) + estimateBytes(meta);
  await request(payloads.put(payload));
  await request(catalogue.put(meta));
  if (old.id !== meta.id) {
    await request(payloads.delete(old.id));
    await request(catalogue.delete(old.id));
  }
}

async function migrateRow(tx:IDBTransaction, old:Catalogue) {
  const {version, ...meta} = old;
  if (meta.kind) meta.key = migrateCalculationKey(meta.kind, meta.key);
  if (meta.location === 'data') {
    if (!meta.kind) return invalid();
    meta.id = JSON.stringify([meta.kind, meta.key]);
    await writeData(tx, old, meta);
  } else {
    // These IDs/sourceKey still address the physical old database. Its importer
    // owns deletion and may have stopped after copying but before deleting.
    meta.bytes = meta.legacyBytes! + estimateBytes(meta);
    await request(tx.objectStore('catalogue').put(meta));
  }
}

async function migrateRows(tx:IDBTransaction) {
  const opened = tx.objectStore('catalogue').openCursor();
  let cursor = await request(opened);
  while (cursor) {
    await migrateRow(tx, cursor.value as Catalogue);
    const next = request(opened); cursor.continue(); cursor = await next;
  }
}

async function measure(tx:IDBTransaction) {
  let accountedBytes = 4096, legacyBytes = 0;
  const opened = tx.objectStore('catalogue').openCursor();
  let cursor = await request(opened);
  while (cursor) {
    accountedBytes += cursor.value.bytes; legacyBytes += cursor.value.legacyBytes ?? 0;
    const next = request(opened); cursor.continue(); cursor = await next;
  }
  return {accountedBytes, legacyBytes};
}

function migrateControl(source:RecordValue, sizes:Awaited<ReturnType<typeof measure>>) {
  if (source.key === 'budget') {
    const {versions, window, ...state} = source;
    const {version, ...dates} = window ? record(window) : {};
    return {...state, ...sizes, window:window ? dates : null};
  }
  if (!source.definition) return source;
  const definition = Object.fromEntries(Object.entries(record(source.definition))
    .map(([key, value]) => [key === 'databaseName' ? 'legacyDatabaseName' : key, value]));
  return {...source, definition};
}

async function migrate(tx:IDBTransaction) {
  const budget = await request(tx.objectStore('control').get('budget'));
  if (!budget) {
    if (await request(tx.objectStore('catalogue').count()) || await request(tx.objectStore('payloads').count())) return invalid();
    return;
  }
  if (!Object.hasOwn(budget, 'versions')) return;
  await migrateRows(tx);
  const sizes = await measure(tx), control = tx.objectStore('control');
  const opened = control.openCursor();
  let cursor = await request(opened);
  while (cursor) {
    await request(control.put(migrateControl(cursor.value, sizes)));
    const next = request(opened); cursor.continue(); cursor = await next;
  }
}

/** A versionchange transaction fences old writers and commits all IDs, payloads
 * and accounting together. It never opens/deletes the unfinished legacy source. */
export function migrateCalculationCache(transaction:IDBTransaction) {
  void migrate(transaction).catch(() => transaction.abort());
}
