import { createIndexedDatabase } from './indexed-db.js';
import { createMemoryCache } from './memory-cache.js';
import { TRANSIT_DAY_VERSION } from '../../shared/day-packets/transit-format.js';
import { MOMENT_COLUMN_COUNT, validMomentValue } from '../../shared/day-packets/moment-columns.js';
import { SUPPORTED_START, SUPPORTED_END_EXCLUSIVE } from '../../shared/date-limits.js';

const DAY_MS = 86400000, SAMPLES = 1440;
const keyOf = (date, version) => `${version}:${date}`;
const memoryKey = key => `transit-day:${key}`;
const validVersion = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const metadataKeys = ['engine', 'ephemeris', 'timezoneDatabase', 'nodeModel', 'zodiac'];
const dayIndex = milliseconds => Math.floor((milliseconds - SUPPORTED_START) / DAY_MS);

// Reuse the existing database's full days. Sparse legacy rows are never read
// into the new cache. The small coverage bitmap describes full days only.
export function createTransitDayCache({ indexedDB, databaseName = 'forma-moments',
  memory = createMemoryCache(), timeoutMs = 1000 } = {}) {
  const database = createIndexedDatabase({ indexedDB, databaseName, timeoutMs, version: 1,
    stores: ['packets', 'catalogue'],
    upgrade(db) {
      db.createObjectStore('packets', { keyPath: 'key' });
      const catalogue = db.createObjectStore('catalogue', { keyPath: 'key' });
      catalogue.createIndex('accessedAt', 'accessedAt'); catalogue.createIndex('full', 'full');
      db.createObjectStore('settings');
    },
  });
  const reads = new Map(), writes = new Map();
  const coverage = new Uint8Array(Math.ceil((SUPPORTED_END_EXCLUSIVE - SUPPORTED_START) / DAY_MS));
  let coverageVersion = null, preparing = null, prepared = false, closed = false;
  function mark(date, version, present) {
    const index = dayIndex(Date.parse(date));
    if (version === coverageVersion && index >= 0 && index < coverage.length) coverage[index] = present ? 1 : 0;
  }
  function prepare(version) {
    if (!validVersion(version)) return Promise.resolve();
    if (coverageVersion === version && (preparing || prepared)) return preparing || Promise.resolve();
    if (coverageVersion !== version) { coverageVersion = version; coverage.fill(0); }
    prepared = false;
    const scanned = new Uint8Array(coverage.length);
    const work = database.transaction('readonly', (tx, result) => {
      const request = tx.objectStore('catalogue').index('full').openCursor(1);
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) { result(true); return; }
        const index = dayIndex(Date.parse(cursor.value.date));
        if (cursor.value.version === version && index >= 0 && index < scanned.length) scanned[index] = 1;
        cursor.continue();
      };
    }).then(committed => {
      if (committed && preparing === work && coverageVersion === version) {
        prepared = true;
        for (let i = 0; i < coverage.length; i++) coverage[i] |= scanned[i];
      }
    }).finally(() => { if (preparing === work) preparing = null; });
    preparing = work;
    return work;
  }
  function validDay(day, date, version) {
    return day?.date === date && day.calculationVersion === version && validVersion(version)
      && day.version === TRANSIT_DAY_VERSION && day.startUtc === `${date}T00:00:00Z`
      && day.samples === SAMPLES && day.stepSeconds === 60 && day.columns?.length === MOMENT_COLUMN_COUNT
      && day.columns.every((column, c) => column instanceof Float64Array && column.length === SAMPLES
        && column.every(value => validMomentValue(value, c)));
  }
  function fromPacket(packet, date, version) {
    if (packet?.key !== keyOf(date, version) || !(packet.day instanceof Float64Array)
        || packet.day.length !== MOMENT_COLUMN_COUNT * SAMPLES) return null;
    const day = { ...packet.meta, date, calculationVersion: version, version: TRANSIT_DAY_VERSION,
      startUtc: `${date}T00:00:00Z`, samples: SAMPLES, stepSeconds: 60,
      columns: Array.from({ length: MOMENT_COLUMN_COUNT }, (_, c) => packet.day.subarray(c * SAMPLES, (c + 1) * SAMPLES)) };
    return validDay(day, date, version) ? day : null;
  }
  function peekDay(date, version) { return memory.get(memoryKey(keyOf(date, version))); }
  async function getDay(date, version) {
    const hot = peekDay(date, version); if (hot) return hot;
    const key = keyOf(date, version);
    if (writes.has(key)) return writes.get(key).day;
    if (!reads.has(key)) {
      const entry = { latest: null, promise: null };
      entry.promise = database.transaction('readonly', (tx, result) => {
        const request = tx.objectStore('packets').get(key);
        request.onsuccess = () => result(fromPacket(request.result, date, version));
      }).then(day => {
        const current = peekDay(date, version) || entry.latest; if (current) return current;
        mark(date, version, Boolean(day));
        return day ? memory.put(memoryKey(key), day) : null;
      }).finally(() => reads.delete(key));
      reads.set(key, entry);
    }
    return reads.get(key).promise;
  }
  function putDay(day) {
    if (closed || !validDay(day, day?.date, day?.calculationVersion)) return false;
    const { date, calculationVersion: version } = day, key = keyOf(date, version);
    memory.put(memoryKey(key), day);
    if (reads.has(key)) reads.get(key).latest = day;
    // A write is optional. Quota failure never removes the usable RAM result.
    const work = database.transaction('readwrite', (tx, result) => {
      const numbers = new Float64Array(MOMENT_COLUMN_COUNT * SAMPLES);
      day.columns.forEach((column, c) => numbers.set(column, c * SAMPLES));
      tx.objectStore('packets').put({ key, date, version, day: numbers,
        offsets: new Uint32Array(), values: new Float64Array(),
        meta: Object.fromEntries(metadataKeys.map(name => [name, day[name]])) });
      tx.objectStore('catalogue').put({ key, date, version, full: 1 });
      result(true);
    }).then(saved => { if (saved) mark(date, version, true); return saved; })
      .finally(() => { if (writes.get(key)?.promise === work) writes.delete(key); });
    writes.set(key, { day, promise: work });
    return true;
  }
  return {
    memory, prepare, putDay, peekDay, getDay,
    hasMinute(milliseconds, version) {
      if (!Number.isSafeInteger(milliseconds) || milliseconds % 60000 || milliseconds < SUPPORTED_START || milliseconds >= SUPPORTED_END_EXCLUSIVE) return false;
      const date = new Date(milliseconds).toISOString().slice(0, 10);
      return Boolean(peekDay(date, version) || version === coverageVersion && coverage[dayIndex(milliseconds)]);
    },
    retainDay(day) { return memory.retain(memoryKey(keyOf(day.date, day.calculationVersion)), day); },
    async flush() { await Promise.all([...writes.values()].map(entry => entry.promise)); },
    async close() { closed = true; await Promise.all([...writes.values()].map(entry => entry.promise)); database.close(); },
  };
}
