import type { SavedView } from './data/view-store.ts';
import { createTransitDayClient } from './data/transit-day-client.ts';
import { createViewStore } from './data/view-store.ts';
import { createChartStore } from './data/chart-store.ts';
import { resolveSelectedChartId } from './state/chart-session.ts';
import { holdLoadingContent, commitLoadingLayout } from './views/chart-loading.ts';
import { createChartLibraryView } from './views/library.ts';
import { createPanelState } from './state/panels.ts';
import { createWorkspaceState } from './state/workspace.ts';
import { studioPresentation } from './ui/studio-presentation.ts';
import { eligibleCycleChart } from './domain/cycles.ts';
import { canExploreNatalDay } from './domain/chart-data.ts';
import { createCameraChangeHandler } from './views/camera-controls.ts';
import { createToast } from './ui/toast.ts';
import { createStudioLayout } from './ui/layout/studio-controller.ts';
import { STUDIO_FOOTPRINT, MANDALA_FRAME } from './scene/geometry/frames.ts';
import { createCamera } from './scene/camera.ts';
import { createCameraView } from './scene/camera-view.ts';
import { ACTIVATION_COLUMN_REVEAL_DISTANCE } from './scene/geometry/activation-layout.ts';
import { attachPageGestures } from './ui/page-gestures.ts';
import { attachGestures } from './scene/gestures.ts';
import { attachCameraControls } from './views/camera-controls.ts';
import { attachLoadingPreview } from './views/loading-preview.ts';
import { lifeTimelineForChart } from './domain/cycles.ts';

attachPageGestures(document);

const element = <T extends Element = HTMLElement>(id: string) => document.getElementById(id) as unknown as T;
const toast = createToast(element('toast'));
const viewStore = createViewStore({ onStorageError: toast }), savedView = viewStore.read();
let saveBeforeNavigate = () => {}, flushLoadingView = () => {};
const previewLoading = attachLoadingPreview({ button: element('toggleLoadingPreview'), location,
  beforeNavigate: () => saveBeforeNavigate() });
let pendingView: Partial<SavedView> | null = savedView;
let loadingInteraction = false;
// Read the tab once before prefetching. A saved lifetime, natal or exact return
// owns its own data; only Day and an explicitly live personal view need today.
const needsDay = (savedView?.selectedId ?? 'current-transit') === 'current-transit'
  ? savedView?.lifetime?.mode !== 'lifetime'
  : savedView?.lifetime?.personalLive === true && !savedView?.returns?.eventId;
const dayClient = createTransitDayClient({
  calculationVersion: document.body.dataset.calculationVersion,
  initialDate: !previewLoading && !document.hidden && needsDay ? new Date().toISOString().slice(0, 10) : null,
});
const store = createChartStore({ onStorageError: toast });
// The first preview and the application share these state owners. Project the
// saved shells before importing the application, while boot transitions are off.
const panels = createPanelState(), workspace = createWorkspaceState();
panels.restore(savedView?.panels); workspace.restore(savedView?.workspace);
const studio = element('canvasWrap').parentElement!;
studio.dataset.workspaceScreen = workspace.screen;
function syncLoadingPanels() {
  const rightOpen = workspace.screen === 'chart' && panels.right;
  for (const [id, button, opened] of [['library', 'openLibrary', panels.left], ['chartSummary', 'summarySwitch', rightOpen]] as const) {
    element(id).classList.toggle('open', opened);
    element(id).inert = !opened;
    element(id).setAttribute('aria-hidden', String(!opened));
    element(button).setAttribute('aria-expanded', String(opened));
  }
  element('libraryBackdrop').hidden = !panels.left;
  element('summaryBackdrop').hidden = !rightOpen;
}
syncLoadingPanels();
// The local library is already available: render its actual rows once, then
// let the application attach commands to this same view and store.
const libraryView = createChartLibraryView({ chartList: element('chartList'), libraryCount: element('libraryCount'), nowButton: element('nowButton'), document });
const selectedId = resolveSelectedChartId(store, savedView?.selectedId);
libraryView.update(store.charts, workspace.screen === 'chart' ? selectedId : null);
libraryView.setScreen(workspace.screen);
if (panels.left) libraryView.show();
// Project only the saved controls' geometry; the state owners still restore
// their actual values and data after import. The loading mask uses this same
// panel until restoration has prepared the visible screen.
const record = store.get(selectedId), isTransit = selectedId === 'current-transit';
const personalAvailable = eligibleCycleChart(record), dayAvailable = canExploreNatalDay(record);
const canvas = element('canvasWrap');
function renderLoadingTools() {
  const sameChart = selectedId === pendingView?.selectedId;
  const savedLifetime = sameChart && (isTransit || personalAvailable) && pendingView?.lifetime?.opened ? pendingView.lifetime : null;
  const savedReturns = sameChart && personalAvailable && (pendingView?.returns?.opened || pendingView?.returns?.eventId);
  const initialLifetime = savedLifetime || (savedReturns ? { opened: true, mode: 'lifetime' } as const : null);
  const dayOpened = !initialLifetime && dayAvailable && sameChart
    && (pendingView?.natalDay?.opened === true || personalAvailable && pendingView?.natalDay?.opened !== false);
  const view = studioPresentation({ isTransit, personalAvailable, dayOpened, lifetime: initialLifetime,
    returnsOpened: Boolean(savedReturns && pendingView?.returns?.opened && pendingView?.panels?.right !== false), returnsEnabled: Boolean(initialLifetime && personalAvailable),
    transitEnabled: Boolean(initialLifetime && isTransit) });
  element('chartSummary').dataset.screen = view.returnsVisible ? 'returns' : 'summary';
  studio.dataset.initialTimeline = view.timelinePanel || 'none';
  for (const [kind, id] of [['transit', 'transitControls'], ['natal-day', 'natalDayControls'], ['lifetime', 'lifetimeControls']] as const)
    element(id).hidden = kind !== view.timelinePanel;
  const heading = element('lifetimeControls').querySelector<HTMLElement>('.lifetime-heading')!;
  heading.hidden = !view.lifetimeHeadingVisible; heading.inert = !view.lifetimeHeadingVisible;
  element('lifetimeControls').dataset.personalLife = String(personalAvailable);
  const dayToggle = element('natalDayToggle');
  dayToggle.hidden = !dayAvailable;
  dayToggle.setAttribute('aria-expanded', String(dayOpened));
  dayToggle.setAttribute('aria-pressed', String(dayOpened));
  const timelineToggle = element('lifetimeToggle');
  timelineToggle.hidden = !view.lifetimeAvailable; timelineToggle.title = view.toggleLabel;
  timelineToggle.setAttribute('aria-label', view.toggleLabel);
  timelineToggle.setAttribute('aria-pressed', String(view.toggleEnabled));
  timelineToggle.setAttribute('aria-expanded', String(view.toggleEnabled));
  const reveal = pendingView?.mandala === true ? 1 : 0;
  canvas.classList.toggle('has-mandala', Boolean(reveal));
  canvas.style.setProperty('--mandala-reveal', String(reveal));
  canvas.style.setProperty('--activation-column-offset', `${ACTIVATION_COLUMN_REVEAL_DISTANCE * reveal}px`);
  element('mandalaSwitch').setAttribute('aria-checked', String(Boolean(reveal)));
  return view;
}
let initialPresentation = renderLoadingTools();
const layout = createStudioLayout({ footprint: STUDIO_FOOTPRINT, canvas: element('canvasWrap'), drawing: element('bodygraph'),
  timelineKind: initialPresentation.timelineKind, onPhoneLayout: phone => panels.setExclusive(phone),
  panels: [element('transitControls'), element('natalDayControls'), element('lifetimeControls')],
  sidePanels: () => ({ ...panels.snapshot, right: workspace.screen === 'chart' && panels.right,
    leftWidth: element('library').getBoundingClientRect().width,
    rightWidth: parseFloat(getComputedStyle(studio).getPropertyValue('--returns-panel-width')),
  }) });
syncLoadingPanels();
// The navigation drawer covers the workspace; its visibility remains owned by
// the same panel state during loading and after the application takes over.
function refreshPhoneNavigation() { studio.inert = Boolean(layout.phone && panels.left); }
layout.subscribeViewport(refreshPhoneNavigation);
panels.subscribe(refreshPhoneNavigation);
refreshPhoneNavigation();
// One projection paints the ready chart and its loading illustration. The
// application takes this camera over without changing the saved view.
const cameraView = createCameraView({ svg: element('bodygraph'), surface: canvas, mirrors: [element('chartLoadingArt')] });
const cameraChanged = createCameraChangeHandler({ heading: element('chartHeader'), fitButton: element('fitButton'),
  activationPopover: { reposition() {} } });
const camera = createCamera({ getHomeFrame: () => layout.frame(), getFrame: () => MANDALA_FRAME,
  measureFit: frame => cameraView.measureFit(frame, () => layout.insets()), onChange(view, fitted) { cameraView.paint(view); cameraChanged(view, fitted); } });
camera.restoreView(savedView?.camera);
const gestures = attachGestures(element('bodygraph'), { camera, cameraView, resolvePointerTarget: () => null,
  onChange(view, fitted) { cameraChanged(view, fitted); flushLoadingView(); } });
attachCameraControls({ fitButton: element('fitButton') }, gestures);
let loadingActive = true;
function loadingSnapshot(): Partial<SavedView> {
  const view = camera.getView(), home = camera.getFittedView();
  return { ...pendingView, version: 1, selectedId, workspace: workspace.snapshot, panels: panels.snapshot,
    mandala: pendingView?.mandala === true,
    camera: { x: (view.x - home.x) / home.k, y: (view.y - home.y) / home.k,
      k: view.k / home.k, maxK: camera.maximumScale() / home.k } };
}
flushLoadingView = () => {
  if (!loadingActive) return;
  loadingInteraction = true;
  viewStore.write?.(loadingSnapshot());
};
saveBeforeNavigate = flushLoadingView;
const flushOnHide = () => { if (document.hidden) flushLoadingView(); };
document.addEventListener('visibilitychange', flushOnHide);
const page = document.defaultView;
page?.addEventListener?.('pagehide', flushLoadingView);
function changeLoadingTool(kind: 'day' | 'lifetime' | 'mandala') {
  const view = renderLoadingTools();
  pendingView = { ...pendingView, version: 1, selectedId };
  if (kind === 'mandala') pendingView.mandala = !pendingView.mandala;
  else {
    const day = pendingView.natalDay || { index: 0, exactOriginal: true };
    const close = kind === 'day' ? view.timelinePanel === 'natal-day' : view.toggleEnabled;
    pendingView.returns = null;
    pendingView.natalDay = { ...day, opened: kind === 'day' && !close };
    pendingView.lifetime = kind === 'lifetime' && !close
      ? personalAvailable
        ? { opened: true, mode: 'lifetime', ...lifeTimelineForChart(record)!, requestedUtc: Date.parse(record!.utc!), personalPreview: false }
        : { opened: true, mode: 'day', fromDate: null, toDate: null }
      : null;
  }
  initialPresentation = renderLoadingTools();
  layout.setTimelineKind(initialPresentation.timelineKind);
  layout.refresh(); camera.resize({ preserveScale: true });
  flushLoadingView();
}
const loadingLayoutObserver = new ResizeObserver(() => { layout.refresh(); camera.resize(); });
loadingLayoutObserver.observe(element('canvasWrap'));
// Early buttons use the same panel state. They detach synchronously before
// the application attaches its regular handlers, preserving commands made
// while app.ts was still downloading.
panels.beginRestore();
const stopLoadingPanelProjection = panels.subscribe(() => {
  syncLoadingPanels();
  if (panels.left) libraryView.show(); else libraryView.hide();
  layout.refresh(); camera.resize({ preserveScale: true });
  flushLoadingView();
});
const loadingPanelCommands: [string, () => void][] = [
  ['mandalaSwitch', () => changeLoadingTool('mandala')],
  ['lifetimeToggle', () => { if (initialPresentation.lifetimeAvailable) changeLoadingTool('lifetime'); }],
  ['natalDayToggle', () => { if (dayAvailable) changeLoadingTool('day'); }],
  ['openLibrary', () => panels.setLeft(!panels.left)], ['libraryBackdrop', () => panels.setLeft(false)],
  ['summarySwitch', () => { if (workspace.screen === 'chart') panels.setRight(!panels.right); }],
  ['summaryBackdrop', () => panels.setRight(false)],
];
for (const [id, command] of loadingPanelCommands) element(id).addEventListener('click', command);
function handoffLoadingPanels() {
  for (const [id, command] of loadingPanelCommands) element(id).removeEventListener('click', command);
  stopLoadingPanelProjection();
}
const releaseLoadingContent = holdLoadingContent(document);
document.querySelector<HTMLElement>('.app-shell')!.inert = false;
canvas.inert = false; canvas.setAttribute('tabindex', '0');
element<SVGSVGElement & { inert: boolean }>('bodygraph').inert = true;
// Commit saved geometry before enabling ordinary user-driven transitions.
commitLoadingLayout(document);
if (!previewLoading) try {
  const app = await import('./app.ts');
  loadingLayoutObserver.disconnect();
  handoffLoadingPanels();
  const latestView = loadingInteraction ? loadingSnapshot() : savedView;
  loadingActive = false;
  document.removeEventListener('visibilitychange', flushOnHide);
  page?.removeEventListener?.('pagehide', flushLoadingView);
  const application = app.startApp({ dayClient, layout, toast, viewStore, savedView: latestView, panels, workspace, store, libraryView, camera, cameraView, gestures, initialPresentation, releaseLoadingContent });
  saveBeforeNavigate = () => application?.flushView();
} catch {
  const shell = document.querySelector<HTMLElement>('.app-shell')!;
  shell.dataset.pageState = 'error'; shell.inert = false; shell.setAttribute('aria-busy', 'false');
  releaseLoadingContent();
  studio.dataset.workspaceScreen = 'chart';
  const canvas = document.getElementById('canvasWrap')!;
  canvas.dataset.chartState = 'error';
  canvas.setAttribute('aria-busy', 'false');
  document.getElementById('chartLoadingStatus')!.textContent = 'Не удалось загрузить приложение';
  const retry = document.getElementById('chartLoadingRetry')!;
  retry.hidden = false;
  retry.addEventListener('click', () => location.reload());
  commitLoadingLayout(document);
}
