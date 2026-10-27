import type { createJournal } from './journal.ts';
import {clientFailureReason,parseClientContextStep,CLIENT_REPORT_REASONS} from '../shared/client-report-contract.ts';
import type {ClientActionContext,ClientContextStep,ClientObservation,ClientReportReason} from '../shared/client-report-contract.ts';
import { createStoragePressure } from './data/storage-pressure.ts';
import { createCalculationUpdates } from './data/calculation-updates.ts';
import { createNavigation } from './state/navigation.ts';
import { viewForRoute } from './state/view-session.ts';
import { attachAccount } from './account.ts';
import { isDevelopmentPort } from '../shared/development.ts';
import { attachPanelKeyboard } from './views/side-panel-controls.ts';
import type { SavedView } from './data/view-store.ts';
import { createCalculationClients } from './data/calculation-clients.ts';
import { createViewStore } from './data/view-store.ts';
import { getConnectionMode } from './data/http-transport.ts';
import { actionAvailability } from './ui/action-state.ts';
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

type Journal=ReturnType<typeof createJournal>;
let application:ReturnType<typeof import('./app.ts').startApp>|undefined;
let applicationFailed=false,connectedJournal:Journal|undefined,connection:Promise<void>|undefined;
// One first startup fact, before the optional journal is available. No snapshot,
// raw exception, private identity, queue or delivery state lives in this handoff.
let earlyFailure:{action:ClientActionContext;step:ClientContextStep & {reason:ClientReportReason};occurredAt:number}|undefined;
function earlyObservation(action:ClientActionContext) {
  let delegate:ClientObservation|undefined,finished=false,failed=false;
  const started=performance.now();
  const observation:ClientObservation & {bind(value:Journal):void}={
    bind(value){if(!finished && !failed)delegate=value.begin(action);},
    async reportFailure(fact){
      if(finished || failed)return;
      if(delegate)return delegate.reportFailure(fact);
      const step=parseClientContextStep(fact);
      if(!step?.reason || !CLIENT_REPORT_REASONS.includes(step.reason as ClientReportReason))return;
      failed=true;
      earlyFailure??={action,step:{...step,reason:step.reason as ClientReportReason,durationMs:Math.max(0,performance.now()-started)},occurredAt:Date.now()};
    },
    reportError(error,step){return observation.reportFailure({...step,reason:clientFailureReason(error)});},
    finishSuccess(){finished=true;delegate?.finishSuccess();},
  };
  return observation;
}
let earlyView:ReturnType<typeof earlyObservation>|undefined,earlyCalculation:ReturnType<typeof earlyObservation>|undefined;
let viewObservation:ClientObservation|undefined,viewOwner:string|null|undefined;
let getViewOwner:()=>string|null=()=>null;
/** Entry hands one optional journal owner to the already prepared interface. */
export function connectJournal(journal:Journal) {
  return connection??=(async()=>{
    // Early startup did not know an accepted account. Record it anonymously
    // before the application's existing account boundary invalidates handles.
    if(earlyFailure){const pending=earlyFailure;journal.setAccount(null);
      await journal.begin(pending.action,pending.occurredAt).reportFailure(pending.step);
      earlyFailure=undefined;
    }
    earlyView?.bind(journal);earlyCalculation?.bind(journal);connectedJournal=journal;
    application?.attachJournal(journal);
    if(applicationFailed){
      journal.setAccount(account.getSession()?.accountId??null,account.getSession()?.sessionId,account.getSession()?.diagnosticProof);
      void journal.begin({action:'startup',component:'startup'})
        .reportFailure({stage:'render',reason:'unclassified_error'});
    }
  })();
}

attachPageGestures(document);

const element = <T extends Element = HTMLElement>(id: string) => document.getElementById(id) as unknown as T;
const toast = createToast(element('toast'));
element('chartLoadingStatus').textContent = 'Загружаем карту…';
const navigation = createNavigation({location, history, events: window});
const viewStore = createViewStore({ onStorageError: toast,
  onStorageFailure(fact){
    const owner=getViewOwner();
    if(viewOwner!==owner){viewObservation?.finishSuccess();viewObservation=undefined;viewOwner=owner;}
    viewObservation??=connectedJournal?.begin({action:'restore',component:'storage'})
      ??(earlyView??=earlyObservation({action:'restore',component:'storage'}));
    return viewObservation.reportFailure(fact);
  },
  onStorageRecovery(){viewObservation?.finishSuccess();viewObservation=undefined;},
}), savedView = viewForRoute(navigation.snapshot.route, viewStore.read());
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
const storagePressure = createStoragePressure();
const calculationClients = createCalculationClients({ cacheOptions: {pressure: storagePressure}, transit: {
  calculationVersion: document.body.dataset.calculationVersion,
  initialDate: !previewLoading && !document.hidden && needsDay ? new Date().toISOString().slice(0, 10) : null,
}, natal: {calculationVersion: document.body.dataset.calculationVersion},
  cycles: {cacheVersion: document.body.dataset.cyclesVersion} });
const dayClient = calculationClients.transit;
const calculationUpdates = createCalculationUpdates({clients: calculationClients,
  observe:action=>connectedJournal?.begin(action)??(earlyCalculation??=earlyObservation(action)),
  expected: {calculationVersion: document.body.dataset.calculationVersion, cyclesVersion: document.body.dataset.cyclesVersion}});
if (!previewLoading && getConnectionMode() === 'online') void calculationUpdates.refresh();
const store = createChartStore({ onStorageError: toast, initialTemporaryChart: savedView?.temporaryChart,
  initialPublicChart:savedView?.publicChart, calculationVersion:document.body.dataset.calculationVersion });
// Account records are restored by their owner after startup. Legacy local
// records remain untouched and never become a persistent guest collection.
store.projectLibrary([], false);
// The first preview and the application share these state owners. Project the
// saved shells before importing the application, while boot transitions are off.
const panels = createPanelState(), workspace = createWorkspaceState();
attachPanelKeyboard(document, panels);
const randomButton = document.getElementById('randomChartButton');
if (randomButton) randomButton.hidden = false;
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
// The tab result is already available. Prepare its existing row once; the
// application attaches commands and the account library to this same view.
const libraryView = createChartLibraryView({ chartList: element('chartList'), libraryCount: element('libraryCount'), nowButton: element('nowButton'), document,
  canEdit: () => !actionAvailability({ connection: getConnectionMode(), requiresConnection: true }).disabled });
const selectedId = resolveSelectedChartId(store, savedView?.selectedId);
libraryView.update(store.temporaryChart ? [store.temporaryChart] : [], workspace.screen === 'chart' ? selectedId : null, savedView?.librarySelection);
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
  const view = studioPresentation({ isTransit, personalAvailable, dayOpened,
    lifetime: initialLifetime ? { opened: initialLifetime.opened, mode: initialLifetime.mode } : null,
    returnsOpened: Boolean(savedReturns && pendingView?.returns?.opened), returnsEnabled: Boolean(initialLifetime && personalAvailable),
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
let loadingActive = true, pendingAccountFocus = savedView?.account?.focus;
function cancelLoadingFocus() {
  pendingAccountFocus = null; loadingInteraction = true;
}
document.addEventListener('pointerdown', cancelLoadingFocus, true);
document.addEventListener('keydown', cancelLoadingFocus, true);
document.addEventListener('input', cancelLoadingFocus, true);
function releaseLoadingFocus() {
  document.removeEventListener('pointerdown', cancelLoadingFocus, true);
  document.removeEventListener('keydown', cancelLoadingFocus, true);
  document.removeEventListener('input', cancelLoadingFocus, true);
}
const account = attachAccount({ page: element('accountPage'), saved: savedView?.account, loadingOnly: previewLoading,
  onChange: () => saveBeforeNavigate() });
getViewOwner=()=>{const access=account.getSession?.();return access?.sessionId??access?.accountId??null;};
element('accountPage').hidden = workspace.screen !== 'account';
account.setVisible(workspace.screen === 'account');
function loadingSnapshot(): Partial<SavedView> {
  const current = account.snapshot;
  const accountView = current && pendingAccountFocus && current.step === 'email'
    && current.email === savedView?.account?.email && workspace.screen === 'account'
    ? {...current, focus:pendingAccountFocus} : current;
  // The shell fallback is not a new selection while the private library is still loading.
  return { ...pendingView, version: 1, temporaryChart: store.temporaryChart, publicChart:store.publicChart, selectedId:pendingView?.selectedId ?? selectedId, workspace: workspace.snapshot, panels: panels.snapshot,
    account: accountView, mandala: pendingView?.mandala === true,
    camera: camera.getSavedView() };
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
  pendingView = { ...pendingView, version: 1, selectedId:pendingView?.selectedId ?? selectedId };
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
  loadingActive = false; releaseLoadingFocus();
  document.removeEventListener('visibilitychange', flushOnHide);
  page?.removeEventListener?.('pagehide', flushLoadingView);
  application = app.startApp({ navigation, storagePressure, calculationClients, calculationUpdates, account, dayClient, layout, toast, viewStore, savedView: latestView, panels, workspace, store, libraryView, camera, cameraView, gestures, initialPresentation, releaseLoadingContent });
  saveBeforeNavigate = () => application?.flushView();
} catch {
  applicationFailed=true;
  const shell = document.querySelector<HTMLElement>('.app-shell')!;
  shell.dataset.pageState = 'error'; shell.inert = false; shell.setAttribute('aria-busy', 'false');
  delete shell.dataset.shellReady;
  loadingActive = false; releaseLoadingFocus();
  loadingLayoutObserver.disconnect();
  handoffLoadingPanels();
  document.removeEventListener('visibilitychange', flushOnHide);
  page?.removeEventListener?.('pagehide', flushLoadingView);
  element('chartLoadingArt').setAttribute('hidden', '');
  element('chartLoadingMessage').hidden = false;
  studio.dataset.workspaceScreen = 'chart';
  const canvas = document.getElementById('canvasWrap')!;
  canvas.dataset.chartState = 'error';
  canvas.setAttribute('aria-busy', 'false');
  document.getElementById('chartLoadingStatus')!.textContent = 'Не удалось загрузить приложение';
  const retry = document.getElementById('chartLoadingRetry')!;
  retry.hidden = false;
  retry.addEventListener('click', () => location.reload());
}

// The page updater cannot infer restoration from shell visibility or the worker.
export function prepareOfflineUpdate(){return application?.prepareOfflineUpdate()??false;}
export function offlineRestored(){return application?.offlineRestored()??false;}
export function offlineReady(){return application?.restoration??Promise.resolve();}
export function subscribeOfflineReady(listener:()=>void){return application?.subscribeOfflineReady(listener)??(()=>{});}
