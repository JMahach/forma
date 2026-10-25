import type { SavedCameraPosition } from '../scene/camera.ts';
export interface SavedReturnView { opened: boolean; year: number | null; bodies: string[]; eventId: string | null }
export interface SavedLifetimeView {
  opened: true;
  mode: 'day' | 'lifetime';
  fromDate: string | null;
  toDate: string | null;
  requestedUtc?: number;
  index?: number;
  openStart?: boolean;
  openEnded?: boolean;
  personalPreview?: boolean;
  personalLive?: boolean;
}
export interface SavedView {
  version: 1;
  returns?: SavedReturnView | null;
  selectedId: string;
  mandala: boolean;
  workspace?: 'chart' | 'library' | 'charts' | 'account';
  panels?: { left: boolean; right: boolean };
  charts?: { query: string; searchOpen: boolean };
  knowledge?: { query: string; searchOpen: boolean; collection: string; entryId: string; view: 'catalog' | 'article' };
  camera: SavedCameraPosition | null;
  lifetime: SavedLifetimeView | null;
  transit: { live: boolean; date: string; timeZone: string; index: number } | null;
  natalDay: { opened: boolean; exactOriginal: boolean; index: number } | null;
  planets: { selectedPlanets: string[]; selectedDesignPlanets: string[] } | null;
}
export type ViewStore = ReturnType<typeof createViewStore>;

import { EPHEMERIS_FIRST_YEAR, EPHEMERIS_LAST_YEAR } from '../../shared/date-limits.ts';
import { CYCLE_BODIES, DEFAULT_CYCLE_BODIES } from '../domain/cycles.ts';
import { PLANET_IDS } from '../domain/planets.ts';

export const VIEW_STORAGE_KEY = 'liniya.view.v1';
const object = (value: unknown): value is object => !!value && typeof value === 'object' && !Array.isArray(value);
const index = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const utc = (value: unknown): value is number => Number.isSafeInteger(value) && Math.abs(value as number) <= 8640000000000000;
const date = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
function normalizeReturns(input: unknown): SavedReturnView | null {
  const value = input as Partial<SavedReturnView> & { group?: string; body?: string };
  if (!object(value) || typeof value.opened !== 'boolean'
    || !(value.eventId === null || typeof value.eventId === 'string' && /^[a-z0-9_:.+Z-]{1,180}$/i.test(value.eventId))) return null;
  const knownBody = (id: unknown): id is string => CYCLE_BODIES.some(body => body.id === id);
  const validYear = (year: unknown): year is number => Number.isInteger(year) && (year as number) >= EPHEMERIS_FIRST_YEAR && (year as number) <= EPHEMERIS_LAST_YEAR;
  let bodies: string[], year: number | null;
  if ('bodies' in value) {
    if (!Array.isArray(value.bodies) || value.bodies.length > CYCLE_BODIES.length
      || !value.bodies.every(knownBody) || value.year !== null && !validYear(value.year)) return null;
    bodies = CYCLE_BODIES.filter(body => value.bodies!.includes(body.id)).map(body => body.id);
    year = value.year;
  } else {
    // Legacy modes are translated here only; application state has no modes.
    if (!['major', 'year', 'planet'].includes(value.group!) || !validYear(value.year) || !knownBody(value.body)) return null;
    bodies = value.group === 'major' ? [...DEFAULT_CYCLE_BODIES]
      : value.group === 'year' ? ['sun', 'mercury', 'venus', 'mars'] : [value.body];
    year = value.group === 'year' ? value.year : null;
  }
  return { opened: value.opened, year, bodies, eventId: value.eventId };
}
function normalizeSearchView(input: unknown): SavedView['charts'] {
  const value = input as SavedView['charts'];
  return object(value) && typeof value!.query === 'string' && typeof value!.searchOpen === 'boolean'
    ? { query: value!.query, searchOpen: value!.searchOpen } : undefined;
}
function normalizeKnowledgeView(input: unknown): SavedView['knowledge'] {
  const value = input as SavedView['knowledge'], search = normalizeSearchView(input);
  return search && typeof value!.collection === 'string' && /^[a-z0-9-]{1,80}$/.test(value!.collection)
    && typeof value!.entryId === 'string' && /^[a-z0-9.-]{1,100}$/.test(value!.entryId)
    && (value!.view === 'catalog' || value!.view === 'article')
    ? { ...search, collection: value!.collection, entryId: value!.entryId, view: value!.view } : undefined;
}
function normalize(input: unknown): SavedView | null {
  const value = input as Omit<SavedView, 'lifetime'> & { lifetime: (Omit<SavedLifetimeView, 'mode'> & { mode: 'day' | 'lifetime' | 'archive' }) | null };
  if (!object(value) || value.version !== 1) return null;
  const returnView = normalizeReturns(value.returns);
  const charts = normalizeSearchView(value.charts), knowledge = normalizeKnowledgeView(value.knowledge);
  // Before shell visibility was saved separately, an open Returns screen
  // also meant an open right panel. Explicit shell state always wins.
  const panels = !('panels' in value) && returnView?.opened ? { left: false, right: true } : value.panels;
  const camera = value.camera, lifetime = value.lifetime, transit = value.transit, natalDay = value.natalDay, planets = value.planets;
  // Read the former saved name once; the application uses only lifetime.
  const lifetimeMode = lifetime?.mode === 'archive' ? 'lifetime' : lifetime?.mode;
  const choices = (list: unknown): list is string[] => Array.isArray(list) && list.length <= PLANET_IDS.length
    && list.every(id => PLANET_IDS.includes(id)) && new Set(list).size === list.length;
  return {
    version: 1,
    ...(returnView ? { returns: returnView } : {}),
    ...(charts ? { charts } : {}), ...(knowledge ? { knowledge } : {}),
    selectedId: typeof value.selectedId === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(value.selectedId) ? value.selectedId : 'current-transit',
    mandala: value.mandala === true,
    ...(['chart', 'library', 'charts', 'account'].includes(value.workspace!) ? { workspace: value.workspace } : {}),
    ...(object(panels) && typeof panels.left === 'boolean' && typeof panels.right === 'boolean'
      ? { panels: { left: panels.left, right: panels.right } } : {}),
    camera: object(camera) && (['x', 'y', 'k'] as const).every(key => Number.isFinite(camera[key]))
      && Math.abs(camera.x) <= 20000 && Math.abs(camera.y) <= 20000 && camera.k >= 1 && camera.k <= 100
      ? { x: camera.x, y: camera.y, k: camera.k,
        ...(Number.isFinite(camera.maxK) && camera.maxK! >= camera.k && camera.maxK! <= 100 ? { maxK: camera.maxK } : {}) } : null,
    lifetime: object(lifetime) && lifetime.opened === true && ['day', 'lifetime'].includes(lifetimeMode!)
      && (lifetimeMode === 'day' || date(lifetime.fromDate) && date(lifetime.toDate) && lifetime.fromDate <= lifetime.toDate && (utc(lifetime.requestedUtc) || index(lifetime.index)))
      ? { opened: true, mode: lifetimeMode!, fromDate: date(lifetime.fromDate) ? lifetime.fromDate : null,
        toDate: date(lifetime.toDate) ? lifetime.toDate : null,
        ...(utc(lifetime.requestedUtc) ? { requestedUtc: lifetime.requestedUtc } : lifetimeMode === 'lifetime' ? { index: lifetime.index } : {}), ...(lifetime.openStart === true ? { openStart: true } : {}), ...(lifetime.openEnded === true ? { openEnded: true } : {}), ...(typeof lifetime.personalPreview === 'boolean' ? { personalPreview: lifetime.personalPreview } : {}), ...(typeof lifetime.personalLive === 'boolean' ? { personalLive: lifetime.personalLive } : {}) } : null,
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
export function createViewStore({ getStorage = () => globalThis.sessionStorage, onStorageError = () => {} }: { getStorage?: () => Pick<Storage, 'getItem' | 'setItem'>; onStorageError?: (message: string) => void } = {}) {
  let memory: SavedView | null = null, encoded: string | null = null, warned = false;
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
    write(value: unknown) {
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
