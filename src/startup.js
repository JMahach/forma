import { createTransitDayClient } from './data/transit-day-client.js';
import { createViewStore } from './data/view-store.js';
import { createChartStore } from './data/chart-store.js';
import { resolveSelectedChartId } from './state/chart-session.js';
import { holdLoadingContent } from './views/chart-loading.js';
import { createChartLibraryView } from './views/library.js';
import { createPanelState } from './state/panels.js';
import { createWorkspaceState } from './state/workspace.js';
import { studioPresentation } from './ui/studio-presentation.js';
import { eligibleCycleChart } from './domain/cycles.js';
import { canExploreNatalDay } from './domain/chart-data.js';
import { createCameraChangeHandler } from './views/camera-controls.js';
import { createToast } from './ui/toast.js';
import { createStudioLayout } from './ui/layout/studio-controller.js';
import { STUDIO_FOOTPRINT, MANDALA_FRAME } from './scene/geometry/frames.js';
import { createCamera } from './scene/camera.js';
import { createCameraView } from './scene/camera-view.js';
import { ACTIVATION_COLUMN_REVEAL_DISTANCE } from './scene/geometry/activation-layout.js';
import { attachPageGestures } from './ui/page-gestures.js';

attachPageGestures(document);

const element = id => document.getElementById(id);
const toast = createToast(element('toast'));
const viewStore = createViewStore({ onStorageError: toast }), savedView = viewStore.read();
// Read the tab once before prefetching. A saved lifetime, natal or exact return
// owns its own data; only Day and an explicitly live personal view need today.
const needsDay = (savedView?.selectedId ?? 'current-transit') === 'current-transit'
  ? savedView?.lifetime?.mode !== 'lifetime'
  : savedView?.lifetime?.personalLive === true && !savedView?.returns?.eventId;
const dayClient = createTransitDayClient({
  calculationVersion: document.body.dataset.calculationVersion,
  initialDate: !document.hidden && needsDay ? new Date().toISOString().slice(0, 10) : null,
});
const store = createChartStore({ onStorageError: toast });
// The first preview and the application share these state owners. Project the
// saved shells before importing the application, while boot transitions are off.
const panels = createPanelState(), workspace = createWorkspaceState();
panels.restore(savedView?.panels); workspace.restore(savedView?.workspace);
const studio = element('canvasWrap').parentElement;
studio.dataset.workspaceScreen = workspace.screen;
function syncLoadingPanels() {
  const rightOpen = workspace.screen === 'chart' && panels.right;
  for (const [id, button, opened] of [['library', 'openLibrary', panels.left], ['chartSummary', 'summarySwitch', rightOpen]]) {
    element(id).classList.toggle('open', opened);
    element(id).inert = !opened;
    element(id).setAttribute('aria-hidden', String(!opened));
    element(button).setAttribute('aria-expanded', String(opened));
  }
  element('chartSummary').dataset.screen = 'summary';
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
const personalAvailable = eligibleCycleChart(record), sameChart = selectedId === savedView?.selectedId;
const savedLifetime = sameChart && (isTransit || personalAvailable) && savedView?.lifetime?.opened ? savedView.lifetime : null;
const savedReturns = sameChart && personalAvailable && (savedView?.returns?.opened || savedView?.returns?.eventId);
const initialLifetime = savedLifetime || (savedReturns ? { opened: true, mode: 'lifetime' } : null);
const dayAvailable = canExploreNatalDay(record);
const dayOpened = !initialLifetime && dayAvailable && sameChart
  && (savedView?.natalDay?.opened === true || personalAvailable && savedView?.natalDay?.opened !== false);
const initialPresentation = studioPresentation({ isTransit, personalAvailable, dayOpened, lifetime: initialLifetime,
  returnsOpened: Boolean(savedReturns), returnsEnabled: Boolean(initialLifetime && personalAvailable),
  transitEnabled: Boolean(initialLifetime && isTransit) });
studio.dataset.initialTimeline = initialPresentation.timelinePanel || 'none';
for (const [kind, id] of [['transit', 'transitControls'], ['natal-day', 'natalDayControls'], ['lifetime', 'lifetimeControls']])
  element(id).hidden = kind !== initialPresentation.timelinePanel;
const lifetimeHeading = element('lifetimeControls').querySelector('.lifetime-heading');
lifetimeHeading.hidden = !initialPresentation.lifetimeHeadingVisible;
lifetimeHeading.inert = !initialPresentation.lifetimeHeadingVisible;
element('lifetimeControls').dataset.personalLife = String(personalAvailable);
element('natalDayToggle').hidden = !dayAvailable;
const timelineToggle = element('lifetimeToggle');
timelineToggle.hidden = !initialPresentation.lifetimeAvailable;
timelineToggle.title = initialPresentation.toggleLabel;
timelineToggle.setAttribute('aria-label', initialPresentation.toggleLabel);
timelineToggle.setAttribute('aria-pressed', String(initialPresentation.toggleEnabled));
timelineToggle.setAttribute('aria-expanded', String(initialPresentation.toggleEnabled));
const canvas = element('canvasWrap'), reveal = savedView?.mandala === true ? 1 : 0;
canvas.classList.toggle('has-mandala', Boolean(reveal));
canvas.style.setProperty('--mandala-reveal', String(reveal));
canvas.style.setProperty('--activation-column-offset', `${ACTIVATION_COLUMN_REVEAL_DISTANCE * reveal}px`);
element('mandalaSwitch').setAttribute('aria-checked', String(Boolean(reveal)));
const layout = createStudioLayout({ footprint: STUDIO_FOOTPRINT, canvas: element('canvasWrap'), drawing: element('bodygraph'),
  timelineKind: initialPresentation.timelineKind,
  panels: [element('transitControls'), element('natalDayControls'), element('lifetimeControls')],
  sidePanels: () => ({ ...panels.snapshot, right: workspace.screen === 'chart' && panels.right,
    leftWidth: element('library').getBoundingClientRect().width,
    rightWidth: parseFloat(getComputedStyle(studio).getPropertyValue('--returns-panel-width')),
  }) });
// One projection paints the ready chart and its loading illustration. The
// application takes this camera over without changing the saved view.
const cameraView = createCameraView({ svg: element('bodygraph'), surface: canvas, mirrors: [element('chartLoadingArt')] });
const cameraChanged = createCameraChangeHandler({ heading: element('chartHeader'), fitButton: element('fitButton'),
  activationPopover: { reposition() {} } });
const camera = createCamera({ getHomeFrame: () => layout.frame(), getFrame: () => MANDALA_FRAME,
  measureFit: frame => cameraView.measureFit(frame, () => layout.insets()), onChange(view, fitted) { cameraView.paint(view); cameraChanged(view, fitted); } });
camera.restoreView(savedView?.camera);
const loadingLayoutObserver = new ResizeObserver(() => { layout.refresh(); camera.resize(); });
loadingLayoutObserver.observe(element('canvasWrap'));
// Early buttons use the same panel state. They detach synchronously before
// the application attaches its regular handlers, preserving commands made
// while app.js was still downloading.
panels.beginRestore();
const stopLoadingPanelProjection = panels.subscribe(() => {
  syncLoadingPanels();
  if (panels.left) libraryView.show(); else libraryView.hide();
  layout.refresh(); camera.resize({ preserveScale: true });
});
const loadingPanelCommands = [
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
document.querySelector('.app-shell').inert = false;
// Local visual inspection only; never stored in the tab or library.
const previewLoading = ['localhost', '127.0.0.1'].includes(location.hostname)
  && new URLSearchParams(location.search).get('preview') === 'loading';
try {
  const app = await import('./app.js');
  loadingLayoutObserver.disconnect();
  handoffLoadingPanels();
  app.startApp({ dayClient, layout, toast, viewStore, savedView, panels, workspace, store, libraryView, camera, cameraView, initialPresentation, releaseLoadingContent, previewLoading });
} catch {
  const shell = document.querySelector('.app-shell');
  shell.dataset.pageState = 'error'; shell.inert = false; shell.setAttribute('aria-busy', 'false');
  releaseLoadingContent();
  studio.dataset.workspaceScreen = 'chart';
  const canvas = document.getElementById('canvasWrap');
  canvas.dataset.chartState = 'error';
  canvas.setAttribute('aria-busy', 'false');
  document.getElementById('chartLoadingStatus').textContent = 'Не удалось загрузить приложение';
  const retry = document.getElementById('chartLoadingRetry');
  retry.hidden = false;
  retry.addEventListener('click', () => location.reload());
  studio.getBoundingClientRect(); delete shell.dataset.booting;
}
