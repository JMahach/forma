import { canonicalChartId } from '../../shared/chart-record-contract.ts';
import { validatePublicAccountChart } from '../domain/account-chart.ts';
import { normalizeTemporaryChart } from './storage.ts';
import type { SavedChart } from '../../shared/chart-types.ts';
import { normalizeLifetimeDraft, normalizeTextSelection, type SavedLifetimeDraft, type TextSelection } from '../domain/input-draft.ts';
import { normalizeBirthFormDraft, type SavedBirthForm } from '../domain/birth-form-draft.ts';
import type { ChartWriteIntent, PublicAccountChart } from '../../shared/chart-record-contract.ts';
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
export interface SavedAccountView {
  focus?: TextSelection | null;
  email: string; attemptEmail: string; attemptId: string | null;
  step: 'email' | 'code' | 'telegram'; verificationPending: boolean; telegramPending?: boolean;
}
export interface SavedTemporaryChartSave extends ChartWriteIntent { sourceId: string }
export interface SavedView {
  publicChart?: PublicAccountChart | null;
  temporaryChartSave?: SavedTemporaryChartSave | null;
  temporaryChart?: SavedChart | null;
  birthForm?: SavedBirthForm | null;
  lifetimeDraft?: SavedLifetimeDraft | null;
  pendingChartWrites?: ChartWriteIntent[];
  account?: SavedAccountView | null;
  version: 1;
  returns?: SavedReturnView | null;
  selectedId: string;
  librarySelection?: string[];
  mandala: boolean;
  workspace?: 'chart' | 'library' | 'charts' | 'account';
  panels?: { left: boolean; right: boolean };
  charts?: { query: string; searchOpen: boolean; focus?: TextSelection | null };
  knowledge?: { query: string; searchOpen: boolean; focus?: TextSelection | null; collection: string; entryId: string; view: 'catalog' | 'article' };
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
    ? { query: value!.query, searchOpen: value!.searchOpen, ...('focus' in value! ? {focus:normalizeTextSelection(value!.focus,value!.query)} : {}) } : undefined;
}
function normalizeKnowledgeView(input: unknown): SavedView['knowledge'] {
  const value = input as SavedView['knowledge'], search = normalizeSearchView(input);
  return search && typeof value!.collection === 'string' && /^[a-z0-9-]{1,80}$/.test(value!.collection)
    && typeof value!.entryId === 'string' && /^[a-z0-9.-]{1,100}$/.test(value!.entryId)
    && (value!.view === 'catalog' || value!.view === 'article')
    ? { ...search, collection: value!.collection, entryId: value!.entryId, view: value!.view } : undefined;
}
function normalizeAccount(input: unknown): SavedAccountView | null {
  const value = input as SavedAccountView;
  if (!object(value) || typeof value.email !== 'string'
    || typeof value.attemptEmail !== 'string' || value.attemptEmail.length > 320
    || !['email', 'code', 'telegram'].includes(value.step)
    || !(value.attemptId === null || typeof value.attemptId === 'string' && /^[a-f0-9]{32}$/.test(value.attemptId))) return null;
  return { email: value.email, attemptEmail: value.attemptEmail, attemptId: value.attemptId,
    ...('focus' in value ? {focus:value.step === 'email' ? normalizeTextSelection(value.focus,value.email) : null} : {}),
    step: value.step, verificationPending: value.verificationPending === true, ...(value.telegramPending === true ? {telegramPending: true} : {}) };
}
function normalizePendingWrites(input: unknown): ChartWriteIntent[] {
  if (!Array.isArray(input)) return [];
  const writes = new Map<string, ChartWriteIntent>();
  for (const raw of input) {
    if (!object(raw)) continue;
    const {operationId, expectedAccountId} = raw as Partial<ChartWriteIntent>;
    if (typeof operationId !== 'string' || !/^(?:[a-f0-9]{32}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/i.test(operationId)
      || typeof expectedAccountId !== 'string' || !/^[1-9][0-9]{0,19}$/.test(expectedAccountId)) continue;
    writes.set(expectedAccountId + ':' + operationId, {operationId, expectedAccountId});
  }
  return [...writes.values()];
}
function normalizePublicChart(value:unknown):PublicAccountChart|null {
  try{return validatePublicAccountChart(value);}catch{return null;}
}
function normalizeTemporarySave(input: unknown, chart: SavedChart | null): SavedTemporaryChartSave | null {
  const pointer=normalizePendingWrites([input])[0];
  const sourceId=object(input) && 'sourceId' in input ? input.sourceId : null;
  return pointer && chart && sourceId===chart.id ? {...pointer,sourceId:chart.id} : null;
}
function normalize(input: unknown): SavedView | null {
  const value = input as Omit<SavedView, 'lifetime'> & { lifetime: (Omit<SavedLifetimeView, 'mode'> & { mode: 'day' | 'lifetime' | 'archive' }) | null };
  if (!object(value) || value.version !== 1) return null;
  const temporaryChart=normalizeTemporaryChart(value.temporaryChart);
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
    ...('publicChart' in value ? {publicChart:normalizePublicChart(value.publicChart)} : {}),
    ...('temporaryChart' in value ? {temporaryChart} : {}),
    ...('temporaryChartSave' in value ? {temporaryChartSave:normalizeTemporarySave(value.temporaryChartSave,temporaryChart)} : {}),
    ...('pendingChartWrites' in value ? {pendingChartWrites: normalizePendingWrites(value.pendingChartWrites)} : {}),
    ...('lifetimeDraft' in value ? {lifetimeDraft:normalizeLifetimeDraft(value.lifetimeDraft)} : {}),
    ...('birthForm' in value ? {birthForm:normalizeBirthFormDraft(value.birthForm)} : {}),
    ...('account' in value ? { account: normalizeAccount(value.account) } : {}),
    ...(returnView ? { returns: returnView } : {}),
    ...(charts ? { charts } : {}), ...(knowledge ? { knowledge } : {}),
    selectedId: typeof value.selectedId === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(value.selectedId) ? canonicalChartId(value.selectedId) : 'current-transit',
    ...(Array.isArray(value.librarySelection) && value.librarySelection.every(id => typeof id === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(id))
      ? { librarySelection: [...new Set(value.librarySelection.map(canonicalChartId))] } : {}),
    mandala: value.mandala === true,
    ...(['chart', 'library', 'charts', 'account'].includes(value.workspace!) ? { workspace: value.workspace } : {}),
    ...(object(panels) && typeof panels.left === 'boolean' && typeof panels.right === 'boolean'
      ? { panels: { left: panels.left, right: panels.right } } : {}),
    camera: object(camera) && (['x', 'y', 'k'] as const).every(key => Number.isFinite(camera[key]))
      && Math.abs(camera.x) <= 20000 && Math.abs(camera.y) <= 20000 && camera.k >= 1 && camera.k <= 100
      ? { x: camera.x, y: camera.y, k: camera.k,
        ...(Number.isFinite(camera.maxK) && camera.maxK! >= camera.k && camera.maxK! <= 100 ? { maxK: camera.maxK } : {}),
        ...(Number.isFinite(camera.zoomLimit) && camera.zoomLimit! > 0 && camera.zoomLimit! <= 100 ? { zoomLimit: camera.zoomLimit } : {}) } : null,
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

// The existing tab snapshot owns presentation, unfinished input and one ready
// temporary chart. New tabs start empty; a duplicated snapshot diverges locally.
// Restoring a tab never rewrites the persistent chart library.
export interface ViewStorageFailure {
  readonly stage: 'storage_read' | 'validate' | 'commit';
  readonly reason: 'storage_unavailable' | 'corrupt_data';
}
interface ViewStoreOptions {
  getStorage?: () => Pick<Storage, 'getItem' | 'setItem'> & Partial<Pick<Storage, 'removeItem'>>;
  onStorageError?: (message: string) => void;
  onStorageFailure?: (fact: ViewStorageFailure) => unknown;
  onStorageRecovery?: () => unknown;
}
export function createViewStore({ getStorage = () => globalThis.sessionStorage, onStorageError = () => {}, onStorageFailure, onStorageRecovery }: ViewStoreOptions = {}) {
  let memory: SavedView | null = null, encoded: string | null = null, warned = false, unsaved = false, failed = false;
  // The external journal owns delivery. Only safe source facts leave this
  // store; recipient failure must not alter restoration or memory fallback.
  const report = (stage: ViewStorageFailure['stage'], reason: ViewStorageFailure['reason']) => {
    failed=true;
    try { if (onStorageFailure) void Promise.resolve(onStorageFailure({stage, reason})).catch(() => {}); }
    catch {}
  };
  const recovered = () => {
    if(!failed)return;failed=false;
    try { if(onStorageRecovery)void Promise.resolve(onStorageRecovery()).catch(()=>{}); }
    catch {}
  };
  const warn = () => {
    if (warned) return;
    warned = true;
    onStorageError('Не удалось сохранить положение страницы. Проверьте хранилище браузера.');
  };
  return {
    read() {
      // Failed writes/deletions must not revive an older disk draft in this page.
      if(unsaved)return memory;
      let raw;
      try { raw = getStorage().getItem(VIEW_STORAGE_KEY); } catch { report('storage_read', 'storage_unavailable'); warn(); return memory; }
      if (!raw) {memory=null;encoded=null;recovered();return null;}
      try { memory = normalize(JSON.parse(raw)); encoded = memory ? raw : null; recovered(); }
      catch { memory = null; encoded = null; report('validate', 'corrupt_data'); }
      return memory;
    },
    write(value: unknown) {
      const next = normalize(value);
      if (!next) return false;
      memory = next;unsaved=true;
      const serialized = JSON.stringify(next);
      let stage: ViewStorageFailure['stage'] = 'storage_read';
      try {
        const storage=getStorage();
        if(serialized!==encoded || storage.getItem(VIEW_STORAGE_KEY)!==serialized) {
          stage='commit';storage.setItem(VIEW_STORAGE_KEY,serialized);
        }
        encoded=serialized;unsaved=false;recovered();return true;
      } catch { report(stage, 'storage_unavailable'); warn(); return false; }
    },
    clear() {
      memory=null;encoded=null;unsaved=true;
      let stage: ViewStorageFailure['stage'] = 'storage_read';
      try {
        const storage=getStorage();stage='commit';
        if(storage.removeItem)storage.removeItem(VIEW_STORAGE_KEY);
        else storage.setItem(VIEW_STORAGE_KEY,'null');
        unsaved=false;recovered();return true;
      }catch{report(stage, 'storage_unavailable');warn();return false;}
    },
  };
}
