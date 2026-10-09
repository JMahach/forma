import { CYCLE_BODIES, DEFAULT_CYCLE_BODIES } from '../domain/cycles.js';
import { PLANET_IDS } from '../domain/planets.js';

export const VIEW_STORAGE_KEY = 'liniya.view.v1';
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const index = value => Number.isSafeInteger(value) && value >= 0;
const utc = value => Number.isSafeInteger(value) && Math.abs(value) <= 8640000000000000;
const date = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
function normalizeReturnEvent(event, id) {
  if (!object(event) || event.id !== id || !CYCLE_BODIES.some(body => body.id === event.body)
    || typeof event.utc !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/.test(event.utc)
    || !Number.isFinite(Date.parse(event.utc)) || !Number.isInteger(event.cycle) || event.cycle < 1 || event.cycle > 10000) return null;
  return { id, body: event.body, utc: event.utc, cycle: event.cycle,
    pass: Number.isInteger(event.pass) && event.pass > 0 && event.pass <= 10 ? event.pass : 1,
    cycleId: typeof event.cycleId === 'string' && /^[a-z0-9_:.+Z-]{1,180}$/i.test(event.cycleId) ? event.cycleId : `${event.body}:${event.cycle}`,
    direction: ['direct', 'retrograde', 'stationary'].includes(event.direction) ? event.direction : 'direct' };
}
function normalizeReturns(value) {
  if (!object(value) || typeof value.opened !== 'boolean'
    || !(value.eventId === null || typeof value.eventId === 'string' && /^[a-z0-9_:.+Z-]{1,180}$/i.test(value.eventId))) return null;
  const knownBody = id => CYCLE_BODIES.some(body => body.id === id);
  const validYear = year => Number.isInteger(year) && year >= 1801 && year <= 2399;
  let bodies, year;
  if ('bodies' in value) {
    if (!Array.isArray(value.bodies) || value.bodies.length > CYCLE_BODIES.length
      || !value.bodies.every(knownBody) || value.year !== null && !validYear(value.year)) return null;
    bodies = CYCLE_BODIES.filter(body => value.bodies.includes(body.id)).map(body => body.id);
    year = value.year;
  } else {
    // Legacy modes are translated here only; application state has no modes.
    if (!['major', 'year', 'planet'].includes(value.group) || !validYear(value.year) || !knownBody(value.body)) return null;
    bodies = value.group === 'major' ? [...DEFAULT_CYCLE_BODIES]
      : value.group === 'year' ? ['sun', 'mercury', 'venus', 'mars'] : [value.body];
    year = value.group === 'year' ? value.year : null;
  }
  const event = normalizeReturnEvent(value.event, value.eventId);
  return { opened: value.opened, year, bodies, eventId: value.eventId, ...(event ? { event } : {}) };
}
function normalize(value) {
  if (!object(value) || value.version !== 1) return null;
  const returnView = normalizeReturns(value.returns);
  const camera = value.camera, lifetime = value.lifetime, transit = value.transit, natalDay = value.natalDay, planets = value.planets;
  // Read the former saved name once; the application uses only lifetime.
  const lifetimeMode = lifetime?.mode === 'archive' ? 'lifetime' : lifetime?.mode;
  const choices = list => Array.isArray(list) && list.length <= PLANET_IDS.length
    && list.every(id => PLANET_IDS.includes(id)) && new Set(list).size === list.length;
  return {
    version: 1,
    ...(returnView ? { returns: returnView } : {}),
    selectedId: typeof value.selectedId === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(value.selectedId) ? value.selectedId : 'current-transit',
    mandala: value.mandala === true,
    camera: object(camera) && ['x', 'y', 'k'].every(key => Number.isFinite(camera[key]))
      && Math.abs(camera.x) <= 20000 && Math.abs(camera.y) <= 20000 && camera.k >= 1 && camera.k <= 100
      ? { x: camera.x, y: camera.y, k: camera.k } : null,
    lifetime: object(lifetime) && lifetime.opened === true && ['day', 'lifetime'].includes(lifetimeMode)
      && (lifetimeMode === 'day' || date(lifetime.fromDate) && date(lifetime.toDate) && lifetime.fromDate <= lifetime.toDate && (utc(lifetime.requestedUtc) || index(lifetime.index)))
      ? { opened: true, mode: lifetimeMode, fromDate: date(lifetime.fromDate) ? lifetime.fromDate : null,
        toDate: date(lifetime.toDate) ? lifetime.toDate : null,
        ...(utc(lifetime.requestedUtc) ? { requestedUtc: lifetime.requestedUtc } : lifetimeMode === 'lifetime' ? { index: lifetime.index } : {}), ...(lifetime.openEnded === true ? { openEnded: true } : {}), ...(typeof lifetime.personalPreview === 'boolean' ? { personalPreview: lifetime.personalPreview } : {}), ...(typeof lifetime.personalLive === 'boolean' ? { personalLive: lifetime.personalLive } : {}) } : null,
    transit: object(transit) && typeof transit.live === 'boolean' && date(transit.date)
      && typeof transit.timeZone === 'string' && transit.timeZone.length <= 80 && index(transit.index)
      ? { live: transit.live, date: transit.date, timeZone: transit.timeZone, index: transit.index } : null,
    natalDay: object(natalDay) && typeof natalDay.opened === 'boolean' && typeof natalDay.exactOriginal === 'boolean' && index(natalDay.index)
      ? { opened: natalDay.opened, exactOriginal: natalDay.exactOriginal, index: natalDay.index } : null,
    planets: object(planets) && choices(planets.selectedPlanets) && choices(planets.selectedDesignPlanets)
      ? { selectedPlanets: [...planets.selectedPlanets], selectedDesignPlanets: [...planets.selectedDesignPlanets] } : null,
  };
}

// Each tab keeps its presentation through reloads. New tabs start without a
// view snapshot; the saved chart library remains in persistent storage.
// Never store computed charts or
// rewrite the library while restoring the visible page.
export function createViewStore({ getStorage = () => globalThis.sessionStorage, onStorageError = () => {} } = {}) {
  let memory = null, encoded = null, warned = false;
  const warn = () => {
    if (warned) return;
    warned = true;
    onStorageError('Не удалось сохранить положение страницы. Проверьте хранилище браузера.');
  };
  return {
    read() {
      let raw;
      try { raw = getStorage().getItem(VIEW_STORAGE_KEY); } catch { warn(); return memory; }
      if (!raw) return null;
      try { memory = normalize(JSON.parse(raw)); encoded = memory ? JSON.stringify(memory) : null; }
      catch { memory = null; encoded = null; }
      return memory;
    },
    write(value) {
      const next = normalize(value);
      if (!next) return false;
      memory = next;
      const serialized = JSON.stringify(next);
      if (serialized === encoded) return true;
      try { getStorage().setItem(VIEW_STORAGE_KEY, serialized); encoded = serialized; return true; }
      catch { warn(); return false; }
    },
  };
}
