import { createIndexedDatabase } from './indexed-db.js';
import { cycleAge } from '../../shared/cycles-format.js';
import { DEFAULT_CYCLE_BODIES } from '../domain/cycles.js';

// Default body dates and all opened return charts belong to the device. Separate
// stores keep their payloads and identities independent of current selection.
// No application expiry or size cap: the browser still controls its own quota.
export function createReturnStorage({ indexedDB: factory, timeoutMs = 500 } = {}) {
  const database = createIndexedDatabase({ databaseName: 'bodygraph-return-events', version: 2,
    indexedDB: factory, timeoutMs, stores: ['events', 'charts'],
    upgrade(db) {
      if (!db.objectStoreNames.contains('events')) db.createObjectStore('events', { keyPath: 'key' });
      if (!db.objectStoreNames.contains('charts')) db.createObjectStore('charts', { keyPath: 'key' });
    },
  });
  return {
    getEvents(key) {
      return database.transaction('readonly', (tx, result) => {
        const request = tx.objectStore('events').get(key);
        request.onsuccess = () => {
          const record = request.result;
          if (!record || !DEFAULT_CYCLE_BODIES.includes(record.body) || !Array.isArray(record.events)) return;
          try {
            result({ range: record.range, events: record.events.map(({ utc, cycle, pass, direction }) => ({
              utc, cycle, pass, direction, body: record.body, id: `${record.body}:${utc}`, cycleId: `${record.body}:${cycle}`,
              age: cycleAge(utc, record.birthUtc),
            })) });
          } catch { /* Corrupt optional storage is a miss. */ }
        };
      });
    },
    putEvents(key, input, data) {
      if (!DEFAULT_CYCLE_BODIES.includes(input.body)) return Promise.resolve(null);
      return database.transaction('readwrite', tx => {
        tx.objectStore('events').put({ key, birthUtc: input.birthUtc, body: input.body, range: data.range,
          events: data.events.map(({ utc, cycle, pass, direction }) => ({ utc, cycle, pass, direction })) });
      });
    },
    removeEvents(key) { return database.transaction('readwrite', tx => tx.objectStore('events').delete(key)); },
    getChart(key) {
      return database.transaction('readonly', (tx, result) => {
        const request = tx.objectStore('charts').get(key);
        request.onsuccess = () => result(request.result?.data ?? null);
      });
    },
    putChart(key, data) {
      return database.transaction('readwrite', tx => tx.objectStore('charts').put({ key, data }));
    },
    removeChart(key) { return database.transaction('readwrite', tx => tx.objectStore('charts').delete(key)); },
    close() { database.close(); },
  };
}
