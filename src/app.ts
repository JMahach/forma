import { createChartEditing } from './application/chart-editing.ts';
import { readLibraryLocalNotice, readLibraryPackageKey } from './domain/library-maintenance.ts';
import type {LibraryLocalChange,LibraryLocalNotice} from './domain/library-maintenance.ts';
import { createResourceScope } from './runtime/resource-scope.ts';
import { chartPresentation } from './domain/chart-presentation.ts';
import { createViewCheckpoint } from './state/view-checkpoint.ts';
import type { ViewCheckpoint } from './state/view-checkpoint.ts';
import type { AccountBoundaryRequest } from './application/ports.ts';
import { createAccountBoundaryWork } from './application/account-boundary.ts';
import { createLayoutObserver } from './ui/layout/resize-observer.ts';
import type { createJournal } from './journal.ts';
import type { StoragePressure } from './data/storage-pressure.ts';
import { createLocalDayTimeline } from './domain/day-timeline.ts';
import type { CalculationClients } from './data/calculation-clients.ts';
import type { AppRoute } from '../shared/app-routes.ts';
import { appRoutePath } from '../shared/app-routes.ts';
import { attachChartLink } from './views/chart-link.ts';
import type { Navigation } from './platform/browser/navigation.ts';
import { createApplication } from './application/application.ts';
import type { Application } from './application/application.ts';
import type {BackgroundTask,ReleaseCheckPort} from './application/background-work.ts';
import { createBackgroundCoordinator } from './platform/browser/background-coordinator.ts';
import { createPageLifecycle } from './platform/browser/lifecycle.ts';
import { createLibraryFillTransfer } from './data/library-fill-transfer.ts';
import type {LibraryFillPacket} from './data/library-fill-transfer.ts';
import type {LibraryFillEvent,LibraryFillScope} from './application/library-fill.ts';
import type { PublicAccountChart } from '../shared/chart-record-contract.ts';
import type { SavedChart } from '../shared/chart-types.ts';
import type { BirthSubmission } from './domain/chart-record.ts';
import type { AccountWorkspace } from './account.ts';
import type { TransitDayClient } from './data/transit-day-client.ts';
import type { SavedView, ViewStore } from './data/view-store.ts';
import type { ChartStore } from './data/chart-store.ts';
import type { StudioLayout } from './ui/layout/studio-controller.ts';
import type { Toast } from './ui/toast.ts';
import type { PanelState } from './state/panels.ts';
import type { WorkspaceState, WorkspaceScreen } from './state/workspace.ts';
import type { Camera } from './scene/camera.ts';
import type { createCameraView } from './scene/camera-view.ts';
import type { Gestures, GestureOptions } from './scene/gestures.ts';
import type { StudioPresentation } from './ui/studio-presentation.ts';
import type { ChartLibraryView } from './views/library.ts';
import type { LifetimeExplorer } from './state/lifetime.ts';
import type { LifetimeControls } from './views/lifetime-controls.ts';
import type { ReturnsPanel } from './views/returns-panel.ts';
type AppJournal=Pick<ReturnType<typeof createJournal>,'begin'|'setAccount'> & Partial<Pick<ReturnType<typeof createJournal>,'discardForSpace'|'close'>> & {leave(ids?:readonly string[]):unknown;wake():unknown};
interface AppOptions {
  connection?: ConnectionSource;
  journal?:AppJournal;
  storagePressure?:StoragePressure;
  navigation?: Navigation;
  calculationClients?: Pick<CalculationClients, 'natal' | 'cycles' | 'resetPersonal' | 'retryPersonalCleanup'> & Partial<Pick<CalculationClients,'evictForSpace'|'syncTransitWindow'|'library'|'close'>>;
  account: Pick<AccountWorkspace, 'ready' | 'snapshot' | 'restoreInputFocus' | 'setVisible' | 'getSession' | 'subscribeSession' | 'subscribeNotices' | 'canRestoreLibrary'> & Partial<Pick<AccountWorkspace,'destroy'>>;
  dayClient: TransitDayClient; layout: StudioLayout; toast: Toast; viewStore: ViewStore;
  viewCheckpoint?: ViewCheckpoint;
  savedView: Partial<SavedView> | null; panels: PanelState; workspace: WorkspaceState;
  store: ChartStore; libraryView: ChartLibraryView; camera: Camera;
  cameraView: ReturnType<typeof createCameraView>; gestures?: Gestures | null;
  initialPresentation?: StudioPresentation | null; releaseLoadingContent?: (() => void) | null;
}

import { createChartClient } from './data/chart-client.ts';
import { createAccountLibraryStore } from './data/account-library-store.ts';
import { createAccountLibrary } from './state/account-library.ts';
import { createChartActions } from './state/chart-actions.ts';
import { UI_MESSAGES, failureMessage } from './ui/messages.ts';
import { createBirthClient } from './data/birth-client.ts';
import { getConnectionMode, subscribeConnection } from './data/http-transport.ts';
import type { ConnectionSource } from './data/http-transport.ts';
import { actionAvailability } from './ui/action-state.ts';
import { attachKnowledgeEntry } from './views/knowledge-entry.ts';
import { attachActivationPopover } from './views/activation-popover.ts';
import { attachActivationHover } from './scene/activation-hover.ts';
import { attachHoverPreview } from './selection/hover-preview.ts';
import { attachGestures } from './scene/gestures.ts';
import { pointerTarget } from './scene/pointer-target.ts';
import { attachMandalaMode } from './scene/modes/mandala.ts';
import { createMandalaMotion } from './scene/modes/mandala-motion.ts';
import { mandalaPreviewFromPointer, mandalaPreviewFromFocus, mandalaSelectionFromTarget } from './scene/mandala-preview.ts';
import { chartHighlight } from './state/chart-highlight.ts';
import { createGraphController } from './scene/updates.ts';
import { attachCameraControls, createCameraChangeHandler } from './views/camera-controls.ts';
import { createChartSession } from './state/chart-session.ts';
import { createChartExploration } from './state/chart-exploration.ts';
import { createViewSession, viewForRoute } from './state/view-session.ts';
import { createTransitPlanetFilter } from './state/transit-planets.ts';
import { chartCaption } from './views/chart-display.ts';
import { createChartHeadingLayout } from './ui/layout/chart-heading.ts';
import { attachChartLibrary } from './views/library.ts';
import { attachAllCharts } from './views/all-charts.ts';
import { attachBirthForm } from './views/birth-form.ts';
import { attachLiveTransit, attachTransitNavigation } from './views/live-transit.ts';
import { attachTransitControls } from './views/transit-controls.ts';
import { attachNatalDayExplorer } from './views/natal-day-controls.ts';
import { attachChartSummary } from './views/chart-summary-panel.ts';
import { attachTelegramGestures } from './ui/telegram-gestures.ts';
import { attachPerformanceMonitor } from './views/performance-monitor.ts';
import { attachChartLoading, holdLoadingContent, commitLoadingLayout } from './views/chart-loading.ts';
import { createReturnsController } from './state/returns.ts';
import { createCyclesClient } from './data/cycles-client.ts';
import { createNatalDayClient } from './data/natal-day-client.ts';
import { ageText, completedAge } from './domain/personal-age.ts';
import { eligibleCycleChart, personalTimelineTarget, cycleTimeZone } from './domain/cycles.ts';
import { attachReturnMarkers } from './views/returns-markers.ts';
import { returnsVisibleWindow } from './domain/returns-window.ts';
import { studioPresentation } from './ui/studio-presentation.ts';

// Composition root: each feature owns its state; these callbacks connect them.
export function startApp({ connection, journal, storagePressure, navigation, calculationClients, account, dayClient, layout, toast, viewStore, viewCheckpoint, savedView, panels, workspace, store, libraryView, camera, cameraView, gestures: startupGestures = null, initialPresentation = null, releaseLoadingContent = null }: AppOptions) {
  const scope=createResourceScope();
  try {
  scope.own(()=>calculationClients?.close?.());
  scope.own(()=>account.destroy?.());
  scope.own(()=>journal?.close?.());
  scope.own(()=>layout.destroy());
  const connectionMode = connection ? () => connection.current : getConnectionMode;
  const observeConnection = connection ? (listener: Parameters<ConnectionSource['subscribe']>[0]) => connection.subscribe(listener) : subscribeConnection;
  const checkpoint=viewCheckpoint??createViewCheckpoint({store:viewStore,eventTarget:document.defaultView,interactionTarget:document});
  if(!viewCheckpoint)scope.own(checkpoint.destroy);
  let application: Application | null = null;
  let lastLibraryWork='',pendingLibraryUses=0;
  let releaseCheck:ReleaseCheckPort|null=null,publicCheckKey='',publicCheckInstance='';
  let publicCheckSource:PublicAccountChart|null=null;
  let freshPublic:{source:PublicAccountChart;checkedAt:number;receivedAt:number}|null=null;
  const routePending = () => application?.view.destination === 'preparing' && application.view.request?.snapshot.route?.kind === 'chart';
  const routeFailed = () => application?.view.destination === 'failed';
  let pendingBirthForm = savedView?.birthForm ?? null;
  // An operation is linked to this accepted tab source, never inferred from its content.
  let temporaryChartSave = savedView?.temporaryChartSave?.sourceId === store.temporaryChart?.id
    ? savedView?.temporaryChartSave ?? null : null;
  const offlineListeners=new Set<()=>void>();
  const notifyOfflineReady=()=>{for(const listener of offlineListeners)listener();};
  function cancelChartSave(){application?.send({type:'CancelWrite'});}
  let lastJournalAccount=account.getSession()?.accountId??null,lastJournalSession=account.getSession()?.sessionId??null,lastJournalProof=account.getSession()?.diagnosticProof,journalBoundaryPending=false;
  const journalBoundaryIds=new Set<string>();
  journal?.setAccount(lastJournalAccount,lastJournalSession,lastJournalProof);
  function syncJournalAccount() {
    const access=account.getSession(),next=access?.accountId??null;
    // Keep only the last known identity and whether a real boundary occurred.
    // Expiry preserves A; A -> B -> A must still clear A's earlier queue.
    if(!journal && next && lastJournalAccount && next!==lastJournalAccount){journalBoundaryPending=true;
      if(lastJournalSession)journalBoundaryIds.add(lastJournalSession);}
    if(next){lastJournalAccount=next;lastJournalSession=access!.sessionId;lastJournalProof=access!.diagnosticProof;}
    journal?.setAccount(next,access?.sessionId,access?.diagnosticProof);return next;
  }
  savedView = viewForRoute(navigation?.snapshot.route ?? null, savedView);
  let pendingLifetimeDraft = savedView?.lifetimeDraft ?? null, pendingInputRestore = true;
  function cancelInputRestore() { pendingInputRestore = false; }
  function discardPendingInput() {cancelInputRestore();pendingLifetimeDraft=null;}
  // A delayed startup must not move the caret after a new user gesture.
  document.addEventListener('pointerdown', cancelInputRestore, {capture:true,signal:scope.signal});
  document.addEventListener('keydown', cancelInputRestore, {capture:true,signal:scope.signal});
  document.addEventListener('input', cancelInputRestore, {capture:true,signal:scope.signal});
  const $ = <T extends Element = HTMLElement>(id: string) => document.getElementById(id) as unknown as T;
  scope.own(attachTelegramGestures([$('canvasWrap'), $('transitTime'), $('natalDayTime'), $('lifetimeTime')]));
  const studio = $('canvasWrap').parentElement!, shell = document.querySelector<HTMLElement>('.app-shell')!;
  // One initial reveal owns the visible screen. Later refreshes stay local to
  // their tools; a failed first attempt reveals the existing recovery UI.
  const initialPage = { active: true, attached: false, changingTimeline: false, contentFailed: false,
    screenPending: false, screenFailed: false, screenRevision: 0 };
  const startupRestored=()=>application?.startup.restored===true;
  const startupFailed=()=>application?.startup.failed===true || initialPage.contentFailed;
  const releaseInitialContent = releaseLoadingContent || holdLoadingContent(document);
  shell.dataset.booting = 'true';
  shell.dataset.pageState = 'loading'; shell.inert = false; shell.setAttribute('aria-busy', 'true');
  let fontsSettled = false;
  const fontsReady = Promise.resolve(document.fonts?.ready).catch(() => {});
  void fontsReady.then(() => { fontsSettled = true; updateInitialPage(); });
  let panelResizePending = false;
  const headingLayout = createChartHeadingLayout({
    header: $('chartHeader'), title: $('chartTitle'), subtitle: $('chartSubtitle'), canvas: $('canvasWrap'),
    content: $('chartHeader').querySelector<HTMLElement>('.chart-heading')!,
    panelCaption: { root: $('summaryChartCaption'), title: $('summaryChartTitle'), clock: $('summaryChartClock'), utc: $('summaryChartUtc'),
      date: $('summaryChartDate'), details: $('summaryChartDetails'), surface: studio,
      comparison: { root: $('summaryComparison'), title: $('summaryComparisonTitle'), clock: $('summaryComparisonClock'),
        date: $('summaryComparisonDate'), details: $('summaryComparisonDetails') } },
    leftControls: document.querySelector<HTMLElement>('.topbar-leading')!, rightControls: document.querySelector<HTMLElement>('.chart-tools')!,
    getMandalaTop: () => $('canvasWrap').getBoundingClientRect().top + layout.mandalaTop,
  });
  scope.own(headingLayout.destroy);
  let hoverPreview: ReturnType<typeof attachHoverPreview> | null = null;
  let chartSummary: ReturnType<typeof attachChartSummary> | null = null;
  let mandalaMode: ReturnType<typeof attachMandalaMode> | null = null;
  let chartLibrary: ReturnType<typeof attachChartLibrary> | null = null;
  let transit: ReturnType<typeof attachLiveTransit> | null = null;
  let transitControls: ReturnType<typeof attachTransitControls> | null = null;
  let natalDay: ReturnType<typeof attachNatalDayExplorer> | null = null;
  let lifetime: LifetimeExplorer | null = null, lifetimeControls: LifetimeControls | null = null;
  let viewSession: ReturnType<typeof createViewSession> | null = null;
  let chartPaintPending = false, captionPending = false;
  let lifetimeLoading: Promise<LifetimeExplorer | null> | null = null, lifetimeLoadFailed = false;
  let returns: ReturnType<typeof createReturnsController> | null = null, returnsView: ReturnsPanel | null = null;
  let returnsViewLoading: Promise<ReturnsPanel | null> | null = null;
  scope.own(()=>{transit?.stop();natalDay?.select(null);lifetime?.close();returns?.select(null);});
  let returnMarkers: ReturnType<typeof attachReturnMarkers> | null = null;
  let exploration: ReturnType<typeof createChartExploration> | null = null, timelineLayoutKey = '';
  let phoneLayout = layout.phone, mandalaColumns = layout.showMandalaColumns;
  const activationPopover = attachActivationPopover($('activationPopover'), $('bodygraph'), { viewportLayout: layout });
  const transitPlanets = createTransitPlanetFilter();
  const session = createChartSession({ store, initialSelectedId: savedView?.selectedId, getTransit: () => transit, getNatalDay: () => natalDay,
    getLifetime: () => lifetime, getReturns: () => returns,
    filterTransit: transitPlanets.filter, resetTransitFilter: transitPlanets.reset,
    onSelect: () => exploration?.selected(), onChange: updatePage });
  exploration = createChartExploration({ connection: connectionMode, session, getTransit: () => transit, getNatalDay: () => natalDay!,
    getLifetime: () => lifetime, getReturns: () => returns, loadLifetime,
    onTimelineReady: () => { updateTimelineTools(); refreshStudioLayout(); },
    onModeChange: updateTimelineTools, onChange: () => { syncLifetimeTransit(); viewSession?.schedule(); } });
  const currentChart = () => session.current;
  const lifetimeOwnsLoading = () => session.selectedId === 'current-transit' && Boolean(
    lifetime?.state.opened && lifetime.state.mode === 'lifetime' || viewSession?.pendingLifetime?.mode === 'lifetime');
  const chartLoading = attachChartLoading({
    canvas: $('canvasWrap'), drawing: $('bodygraph'), art: $('chartLoadingArt'),
    message: $('chartLoadingMessage'), status: $('chartLoadingStatus'), retry: $('chartLoadingRetry'), heading: $('chartHeader'),
    onRetry: () => {
      initialPage.contentFailed = false;application?.send({type:'StartupInterrupted'});
      if (routeFailed() && navigation?.snapshot.route?.kind === 'chart') {application?.send({type:'RetryRoute'});return;}
      if (lifetimeOwnsLoading()) {
        if (lifetimeLoadFailed) window.location.reload();
        else void lifetime?.retry();
      } else void transit?.retry();
    },
  });
  const updateLoading = () => {
    if(scope.stopped)return;
    const lifetimeLoading = lifetimeOwnsLoading(), state = lifetimeLoading ? lifetime?.state : transit?.state;
    const firstFailed = startupRestored() && startupFailed() && !session.hasCurrent;
    chartLoading.update({ hasChart: !routePending() && !routeFailed() && session.hasCurrent, holdLoading: initialPage.active,
      failed: routeFailed() || firstFailed || (lifetimeLoading ? lifetimeLoadFailed || state?.status === 'error' : transit?.state.unavailable),
      loading: routePending() || !firstFailed && (lifetimeLoading ? !lifetimeLoadFailed && (!state || state.status === 'loading') : transit?.state.loading) });
    updateInitialPage();
    updateLibraryWork();
  };

  const graph = createGraphController({
    getHighlightStyle: () => chartHighlight.current,
    getChart: currentChart, hasChart: () => session.hasCurrent,
    viewport: $('viewport'),
    getActiveElement: () => document.activeElement, activationPopover,
    getShowActivations: () => !(mandalaMode?.enabled && !layout.showMandalaColumns),
    getHoverPreview: () => hoverPreview,
    getMandala: () => mandalaMode ? { enabled: mandalaMode.enabled, visible: mandalaMode.visible } : null,
    onChartChange(id) {
      viewSession?.interrupt();
      void exploration!.select(id);
    },
  });
  scope.own(chartHighlight.subscribe(() => renderGraph()));
  const cameraChanged = createCameraChangeHandler({
    heading: $('chartHeader'), fitButton: $('fitButton'), activationPopover,
    getHoverPreview: () => hoverPreview, getSummary: () => chartSummary,
  });
  const gestureHandlers: GestureOptions = {
    camera, cameraView,
    onSelect(selection) {
      if (initialPage.active || !session.hasCurrent) return;
      if (selection.type !== 'planet-filter') { graph.choose(selection); return; }
      if (session.selectedId !== 'current-transit') return;
      const [source, planet] = selection.id.startsWith('design:') ? selection.id.split(':') as ['design', string] : ['personality' as const, selection.id];
      const owner = session.owner === 'lifetime' && lifetime?.current ? lifetime : transitPlanets;
      if (planet === 'all') owner.toggleAllPlanets(source);
      else owner.togglePlanet(planet, source);
      if (owner === transitPlanets) session.refilter();
      viewSession?.schedule();
    },
    resolvePointerTarget: event => initialPage.active || !session.hasCurrent ? null : pointerTarget($('bodygraph'), event, $('canvasWrap')),
    resolveSelection: (target, event) => mandalaSelectionFromTarget(event, target, hoverPreview?.currentSelection),
    onBackgroundTap: () => { if (!initialPage.active) graph.clear(); },
    onChange(view, fitted, metadata) {
      cameraChanged(view, fitted);
      viewSession?.schedule();
    },
  };
  const gestures = startupGestures || attachGestures($('bodygraph'), gestureHandlers);
  if (startupGestures) gestures.setHandlers(gestureHandlers);
  const activationHover = attachActivationHover($('bodygraph'));
  scope.own(activationHover.dispose);
  hoverPreview = attachHoverPreview($('bodygraph'), {
    surface: $('canvasWrap'),
    resolvePreview: mandalaPreviewFromPointer, resolveKeyboard: mandalaPreviewFromFocus,
    coalesceMandala: true, onPreview: previewGraph, onClear: activationHover.clear,
  });
  const knowledge = attachKnowledgeEntry({ button: $('openKnowledge'), dialog: $('knowledgeDialog'),
    initialView: savedView?.knowledge, onChange: () => viewSession?.schedule(),
    onSelect: selection => { navigateWorkspace('chart'); graph.choose(selection); },
    onOpen: () => {
      const alreadyShown = workspace.screen === 'knowledge';
      navigateWorkspace('knowledge');
      if (alreadyShown) void knowledge.show();
    },
    isCurrent: () => workspace.screen === 'knowledge',
    getSelection: () => graph.selectionState.primary, onError: toast });
  chartSummary = attachChartSummary({ panels, initialReturnsVisible: initialPresentation?.returnsVisible === true, isAvailable: () => workspace.screen === 'chart',
    panel: $('chartSummary'), summaryScreen: $('summaryScreen'), returnsPanel: $('returnsPanel'),
    switcher: $('summarySwitch'), backdrop: $('summaryBackdrop'),
    returnsButton: $('summaryReturns'), onReturns: () => { viewSession?.interrupt(); void exploration!.openReturnsList(); },
    onOpen: () => { activationPopover.close(); hoverPreview?.clear(); },
  });
  const mandalaMotion = createMandalaMotion({
    viewport: $('canvasWrap'), onUpdate: () => activationPopover.reposition(),
    onFinish: enabled => mandalaMode?.finishTransition(enabled),
  });
  scope.own(mandalaMotion.dispose);
  mandalaMode = attachMandalaMode({
    button: $('mandalaSwitch'), canvas: $('canvasWrap'), gestures, render: renderGraph,
    motion: mandalaMotion, layout, onStateChange: () => viewSession?.schedule(),
    beforeChange: () => { activationPopover.close(); hoverPreview?.clear({ notify: false }); },
  });
  // Explicit navigation reveals its destination on a phone. State projection
  // and restoration do not use this command, so a restored menu stays open.
  function routeForChart(id: string): AppRoute {
    return id === 'current-transit' ? {kind:'transit'}
      : accountLibrary.get(id) || store.get(id) && 'revision' in store.get(id)!
        ? {kind:'chart',id} : {kind:'temporary-chart'};
  }
  function publishRoute(route: AppRoute, replace = false) {
    if (!navigation) return;
    if (route.kind==='chart' || route.kind==='temporary-chart' || route.kind==='transit') application?.send({type:'CancelPublicRefresh'});
    viewSession?.interrupt();
    initialPresentation = null;
    application?.send({type:'RoutePublished',route,replace});
    updateLoading();
  }
  function navigateWorkspace(screen: WorkspaceScreen, { keepMenuOpen = false, fromRoute = false } = {}) {
    if(application?.write.source && !(screen==='account' && application.write.waitingForLogin))cancelChartSave();
    if (layout.phone && !keepMenuOpen) chartLibrary?.close();
    workspace.setScreen(screen);
    if (!fromRoute) publishRoute(screen === 'chart' ? routeForChart(session.selectedId) : {kind:screen});
  }
  // Opening a chart uses Home; updating the current chart keeps its camera.
  function selectChart(id: string, { keepMenuOpen = false, fromRoute = false, replace = false } = {}) {
    navigateWorkspace('chart', { keepMenuOpen, fromRoute:true });
    graph.changeChart(id);
    if (session.selectedId === id && accountLibrary.get(id)) markLibraryOpened(id);
    gestures.reset();
    const destination = routeForChart(id);
    if (!fromRoute) publishRoute(destination, replace);
  }
  const birthClient = createBirthClient();
  const chartClient = createChartClient({getSession: account.getSession});
  let libraryChannel: BroadcastChannel | null = null;
  try {libraryChannel = new window.BroadcastChannel('forma-library');} catch { /* Resuming a tab also checks its local library. */ }
  const notifyLibrary = (notice:Parameters<NonNullable<Parameters<typeof createAccountLibrary>[0]['notify']>>[0]|LibraryLocalNotice) => {try {libraryChannel?.postMessage(notice);} catch {}};
  const libraryStorage = calculationClients?.library ?? createAccountLibraryStore({pressure: storagePressure});
  let backgroundChannel:BroadcastChannel|null=null;
  try{backgroundChannel=new window.BroadcastChannel('forma-background-checks');}catch{/* Automatic work pauses without shared coordination. */}
  scope.own(()=>{releaseCheck?.stop();releaseCheck=null;offlineListeners.clear();libraryChannel?.close();backgroundChannel?.close();});
  const pageLifecycle=createPageLifecycle({events:window,visibility:document,online:()=>connectionMode()==='online',subscribeConnection:observeConnection});
  const backgroundCoordinator=createBackgroundCoordinator({owner:crypto.randomUUID(),store:libraryStorage.background,channel:backgroundChannel,lifecycle:pageLifecycle});
  storagePressure?.setSources({
    diagnostics: guard => journal?.discardForSpace?.(guard) ?? Promise.resolve('unavailable'),
    natalDays: (keep, exclude, guard) => calculationClients?.evictForSpace?.('natal', keep, exclude, guard) ?? Promise.resolve('unavailable'),
    returnCharts: (keep, exclude, guard) => calculationClients?.evictForSpace?.('return-charts', keep, exclude, guard) ?? Promise.resolve('unavailable'),
  });
  const accountLibrary = createAccountLibrary({client: chartClient, storage: libraryStorage,
    online: () => connectionMode() !== 'offline',
    restoreAllowed: account.canRestoreLibrary, notify: notifyLibrary});
  scope.own(()=>accountLibrary.close());
  const chartLink = attachChartLink({button: $<HTMLButtonElement>('copyChartLink'), root: shell, boundary: $('chartSummary')});
  let privateLibraryShown = false, librarySelection = 0;
  const chartActions = createChartActions({client: chartClient, library: accountLibrary,
    getSession: account.getSession, calculate: birthClient.calculate, initialPending: savedView?.pendingChartWrites,
    prepareWrite: () => viewSession!.checkpoint('write'),
    onPending: () => {viewSession?.flush();}});
  const chartEditing=createChartEditing({actions:chartActions,ready:()=>libraryReady,session:account.getSession,
    durable:()=>accountLibrary.storageAvailable,online:()=>connectionMode()==='online',
    deleted(id){if(store.clearPublic(id))viewSession?.flush();},
    messages:{signIn:UI_MESSAGES.chartSaveSignIn,failed:UI_MESSAGES.chartSaveFailed,
      unconfirmed:UI_MESSAGES.chartSaveUnconfirmed,unavailable:UI_MESSAGES.chartUnavailable}});
  scope.own(chartEditing.reset);
  function saveShownChart():Promise<void> {
    if(connectionMode()==='offline'){toast(UI_MESSAGES.offline);return Promise.resolve();}
    const source=session.record;
    if(!source || accountLibrary.get(source.id))return Promise.resolve();
    return application!.requestSave(source);
  }
  function updateChartSaveControl() {
    const source=session.record,visible=Boolean(source && !accountLibrary.get(source.id));
    const hasAddress = source && source !== store.temporaryChart
      && (accountLibrary.get(source.id) || store.publicChart?.id === source.id);
    chartLink.update(hasAddress && workspace.screen === 'chart'
      ? new URL(appRoutePath({kind: 'chart', id: source.id}), location.href).href : null);
    const button=$<HTMLButtonElement>('saveShownChart'),wrap=$('saveShownChartWrap');
    $('saveShownChartGroup').hidden=!visible;
    const availability=actionAvailability({connection:connectionMode(),requiresConnection:true,
      available:visible,pending:Boolean(application?.write.busy && !application.write.waitingForLogin)});
    button.disabled=availability.disabled;button.setAttribute('aria-busy',String(availability.busy));
    const unavailable=Boolean(availability.reason);
    wrap.dataset.unavailable=String(unavailable);wrap.title=availability.reason;
    $('sharedOfflineDescription').hidden=!unavailable;
    button.title=unavailable?'':'Добавить карту';
    if(unavailable){
      wrap.tabIndex=0;wrap.setAttribute('role','group');wrap.setAttribute('aria-label','Добавить карту');
      wrap.setAttribute('aria-describedby','sharedOfflineDescription');button.setAttribute('aria-describedby','sharedOfflineDescription');
    }else{
      for(const name of ['tabindex','role','aria-label','aria-describedby'])wrap.removeAttribute(name);
      button.removeAttribute('aria-describedby');
    }
  }
  $('saveShownChart').addEventListener('click',()=>saveShownChart(), {signal:scope.signal});
  $('accountPage').addEventListener('click',event=>{
    const button=(event.target as Element).closest<HTMLButtonElement>('[data-account-action]');
    if(button && !button.disabled && ['back','close','cancel'].includes(button.dataset.accountAction!))cancelChartSave();
  },{capture:true,signal:scope.signal});
  const actionError = (code: string, message: string) => Object.assign(new Error(message), {code});
  const canAccessCharts = () => !accountLibrary.accountId || Boolean(account.getSession());
  const canEditCharts = () => canAccessCharts()
    && !actionAvailability({ connection: connectionMode(), requiresConnection: true }).disabled;
  function projectAccountLibrary() {
    if (!privateLibraryShown && !accountLibrary.accountId) return;
    privateLibraryShown = true;
    const publicId=store.publicChart?.id, priorPublic=publicId?store.charts.find(chart=>chart.id===publicId):null;
    // Confirmed disappearance within the same account also revokes a prior public view.
    // Logout/account switching have a different owner and preserve the public tab source.
    if(priorPublic && 'accountId' in priorPublic && priorPublic.accountId===accountLibrary.accountId
      && !accountLibrary.has(priorPublic.id))store.clearPublic(priorPublic.id);
    // Account projection may replace the same ID with a private or not-yet-ready
    // record. It does not supersede the accepted source of an explicit save.
    const preserveSaveSource = Boolean(application?.write.source && session.record === application.write.source);
    if(preserveSaveSource)store.showPublic(application!.write.source);
    const previous = session.record, editedId = birthForm.editedId;
    store.projectLibrary(accountLibrary.charts, accountLibrary.storageAvailable,
      accountLibrary.readyIds,accountLibrary.entries);
    birthForm.refresh();
    if (startupRestored() && !preserveSaveSource && editedId && !store.get(editedId)) {
      librarySelection++; selectChart('current-transit', {replace:true});
      return;
    } else if (startupRestored() && !preserveSaveSource && session.selectedId !== 'current-transit') {
      const next = store.get(session.selectedId);
      if (!next) { librarySelection++; selectChart('current-transit', {replace:true}); }
      else if (previous?.utc !== next.utc || JSON.stringify(previous?.activations) !== JSON.stringify(next.activations)) graph.changeChart(next.id);
      else session.refreshRecord();
      // The accepted session already updates every page projection.
      return;
    }
    if (startupRestored()) updatePage();
  }
  async function openLibraryChart(id: string, options?: {keepMenuOpen: boolean}, edit = false) {
    const observation=journal?.begin({action:'chart_open',component:'chart'});
    const selection = ++librarySelection;
    try {
      if (privateLibraryShown && id !== 'current-transit' && id !== store.temporaryChart?.id && !accountLibrary.has(id)) return;
      if (accountLibrary.has(id)) await accountLibrary.open(id);
      if (selection !== librarySelection) return;
      if (edit) birthForm.open(true, id); else selectChart(id, options);
    } catch (error) {
      if (selection === librarySelection) {
        void observation?.reportError(error,{stage:'storage_read'});
        toast(failureMessage(error, UI_MESSAGES.chartUnavailable));
      }
    } finally {observation?.finishSuccess();}
  }
  async function submitAccountChart(input: BirthSubmission, signal: AbortSignal) {
    const observation=journal?.begin({action:'chart_save',component:'chart'});
    try {
      const result=await chartEditing.submit(input,signal);
      observation?.finishSuccess();return result;
    }catch(error){void observation?.reportError(error,{stage:'commit'});throw error;}
  }
  async function removeAccountChart(id: string, signal: AbortSignal) {
    const observation=journal?.begin({action:'chart_delete',component:'chart'});
    try {
      const result=await chartEditing.remove(id,signal);
      if(result.kind==='unknown')void observation?.reportFailure({stage:'response',reason:'outcome_unknown',outcome:'unknown'});
      else observation?.finishSuccess();
      return result;
    }catch(error){void observation?.reportError(error,{stage:'request'});throw error;}
  }
  let libraryInitialized = false;
  function beginAccountBoundary(request:AccountBoundaryRequest) {
    return createAccountBoundaryWork(request,{
      library:accountLibrary,calculations:calculationClients,
      get pendingWrites(){return chartActions.pending;},
      get boundAccount(){return temporaryChartSave?.expectedAccountId??null;},
      enter(){application?.send({type:'CancelPublicRefresh'});syncJournalAccount();chartLibrary?.closeDelete();},
      logout(ids){
        if(!journal){journalBoundaryPending=true;for(const id of ids)journalBoundaryIds.add(id);}
        journal?.leave(ids);
        cancelChartSave();pendingBirthForm=null;discardPendingInput();
        temporaryChartSave=null;chartActions.clear();chartEditing.reset();librarySelection++;birthForm.close();
        // Retain only independent tab sources in the private checkpoint adapter.
        return checkpoint.clear(store.temporaryChart || store.publicChart?{version:1,
          temporaryChart:store.temporaryChart,publicChart:store.publicChart,
          selectedId:session.selectedId===store.temporaryChart?.id || session.selectedId===store.publicChart?.id
            ? session.selectedId:'current-transit'}:undefined).kind==='stored';
      },
      switchAccount(access){
        if(pendingBirthForm && pendingBirthForm.accountId!==null && pendingBirthForm.accountId!==access.accountId)pendingBirthForm=null;
        temporaryChartSave=null;cancelChartSave();chartActions.clear();chartEditing.reset();librarySelection++;
        const draft=birthForm.snapshot;
        if(birthForm.opened && (!draft || draft.accountId!==null && draft.accountId!==access.accountId))birthForm.close();
      },
      flushSnapshot:()=>viewSession!.flush(),
      settled(){
        if(account.getSession())application!.send({type:'ResumeWrite'});
        if(libraryInitialized){application!.send({type:'RecoverWrites'});application!.send({type:'BackgroundChanged'});wakeLibraryWork('library');}
      },
    });
  }
  const libraryReady = (async () => {
    try{await accountLibrary.restore();}catch(error){if((error as {code?:string})?.code!=='account_changed')throw error;}
    await account.ready;
    if(scope.stopped || application!.view.lifecycle!=='running')return;
    await application!.requestSession(account.getSession());
    if(scope.stopped || application!.view.lifecycle!=='running')return;
    libraryInitialized=true;
    if (!accountLibrary.storageAvailable) toast('Хранилище браузера недоступно. Изменения не будут сохранены.');
  })();

  chartLibrary = attachChartLibrary({ serverDeletion: {handles: id => accountLibrary.has(id), checking: chartActions.isCheckingRemoval, submit:removeAccountChart}, initialSelection: savedView?.librarySelection, panels, view: libraryView, getSelectedId: () => workspace.screen === 'chart' ? session.selectedId : null,
    document, getCharts: () => store.displayCharts,
    removeChart: id => {if(store.clearTemporary(id)){temporaryChartSave=null;viewSession?.flush();}}, getConnectionMode: connectionMode, subscribeConnection: observeConnection, session, onSelect: (id, options) => {void openLibraryChart(id, options);}, onUpdate: updatePage, canEdit: canAccessCharts,
    onEdit: id => {void openLibraryChart(id, undefined, true);}, onNew: () => birthForm.open(),
    beforeOpen: () => { activationPopover.close(); hoverPreview?.clear(); },
  });
  scope.own(()=>chartLibrary?.dispose());
  const allCharts = attachAllCharts({ button: $('openAllCharts'), dialog: $('allChartsDialog'),
    list: $('allChartsList'), getCharts: () => store.displayCharts, canEdit: canEditCharts, onRowsChange: () => chartLibrary.refreshAvailability(), initialView: savedView?.charts, onChange: () => viewSession?.schedule(),
    onOpen: () => { navigateWorkspace('charts'); },
  });
  $('openAccount').addEventListener('click', () => { navigateWorkspace('account'); }, {signal:scope.signal});
  const birthForm = attachBirthForm({
    getAccountId: () => accountLibrary.accountId,
    onDraftChange: () => { pendingBirthForm = null; viewSession?.schedule(); },
    document, getChart: id => id ? store.get(id) : undefined,
    saveChart: chart => { store.setTemporary(chart);temporaryChartSave=null; return true; },
    isCheckingSubmission: () => chartEditing.checking,
    submitChart: (input, signal) => input.previous && input.previous.id === store.temporaryChart?.id
      ? null : account.getSession() || accountLibrary.accountId ? submitAccountChart(input, signal) : null,
    ...birthClient, getConnectionMode: connectionMode, subscribeConnection: observeConnection, session, toast,
    onSave: (id, { metadataOnly = false } = {}) => {
      if (id !== session.selectedId) selectChart(id, {replace: navigation?.snapshot.route?.kind === 'temporary-chart'});
      else if (metadataOnly) session.refreshRecord();
      else graph.changeChart(id);
      workspace.setScreen('chart');
      publishRoute(routeForChart(id), navigation?.snapshot.route?.kind === 'temporary-chart');
      viewSession?.flush();
    },
    beforeOpen: () => { chartEditing.reset(); returns?.close(); activationPopover.close(); hoverPreview?.clear(); },
  });
  const natalDayClient = calculationClients?.natal ?? createNatalDayClient({ memory: dayClient.memory,library:libraryStorage });
  natalDay = attachNatalDayExplorer({
    connection: connectionMode,
    dayClient: natalDayClient,
    toggle: $('natalDayToggle'), panel: $('natalDayControls'), range: $('natalDayTime'), marker: $('natalDayReference'),
    status: $('natalDayStatus'), retryButton: $('natalDayRetry'), hourMarks: $('natalDayHourMarks'),
    onMomentInput: () => viewSession?.interrupt(),
    onRender: exploration!.publishDay, onStateChange: () => { updateTimelineTools(); viewSession?.schedule();updateLibraryWork(); },
  });
  returnMarkers = attachReturnMarkers({ container: $('lifetimeTime').parentElement!,
    onTargetsChange: () => lifetimeControls?.refreshTargets(),
    onSelect: event => { viewSession?.interrupt(); return returns!.selectEvent(event.id); } });
  const cyclesClient=calculationClients?.cycles ?? createCyclesClient({memory:dayClient.memory,library:libraryStorage});
  returns = createReturnsController({
    connection: connectionMode,
    observe: action => journal?.begin(action),
    getOwner(chart) {
      const access = account.getSession(), record = (chart.id ? accountLibrary.get(chart.id) : null);
      return access && record && record.accountId === access.accountId && record.source === 'calculated'
        && record.utc === chart.utc && record.timezone === chart.timezone
        ? {chartId: record.id, expectedAccountId: access.accountId,record} : null;
    },
    client: cyclesClient,
    onRequest: exploration!.requestReturn, onRender: exploration!.publishReturn,
    onStateChange() {
      updateTimelineTools(); viewSession?.schedule();updateLibraryWork();
    },
  });
  $('summaryBreakComparison').addEventListener('click', () => { viewSession?.interrupt(); exploration!.resetMoment(); }, {signal:scope.signal});
  $('natalDayToggle').addEventListener('click', () => changeTimeline('day', () => exploration!.toggleDay()), {signal:scope.signal});
  let cacheTimeline: ReturnType<typeof createLocalDayTimeline> | null = null;
  function syncTransitCacheWindow(timeline: typeof cacheTimeline | undefined, refresh = false) {
    if (!calculationClients?.syncTransitWindow || !timeline) return;
    const now = Date.now();
    if (!refresh && cacheTimeline && now < cacheTimeline.endUtc && cacheTimeline.timeZone === timeline.timeZone) return;
    // Persistent transit covers today's local day, even while exploring a past date.
    cacheTimeline = createLocalDayTimeline(now, timeline.timeZone);
    void calculationClients.syncTransitWindow({dates: cacheTimeline.packetDates, expiresAt: cacheTimeline.endUtc});
  }
  transit = attachLiveTransit({
    document, button: $('nowButton'), dayClient, isFormOpen: () => birthForm.opened,
    isChartVisible: () => workspace.screen === 'chart',
    onRender: exploration!.publishTransit, onStateChange: state => {
      syncTransitCacheWindow(state.timeline);
      transitControls?.setCoveredByLifetime(session.selectedId !== 'current-transit' || Boolean(lifetime?.state.opened));
      transitControls?.update(state); syncLifetimeTransit(); updateLoading(); refreshTimelineLayout(); viewSession?.schedule();
      if (returns?.available) updateChartCaption();
    },
  });
  transitControls = attachTransitControls({
    panel: $('transitControls'), range: $('transitTime'), marker: $('transitReference'),
    status: $('transitStatus'), retryButton: $('transitRetry'), hourMarks: $('transitHourMarks'),
    onScrub: value => { viewSession?.interrupt(); return transit!.scrub(value); },
    onNow: () => { viewSession?.interrupt(); return transit!.goNow(); },
  });
  transitControls!.update(transit!.state);
  $('chartDialog').addEventListener('close', () => { if (!session.hasCurrent) transit!.refresh(); }, {signal:scope.signal});
  attachTransitNavigation($('nowButton'), {
    onSelect: selectChart, refresh: transit!.refresh,
  });
  if (!startupGestures) attachCameraControls({ fitButton: $('fitButton') }, gestures);
  const performanceMonitor=attachPerformanceMonitor({
    document, button: $('togglePerformance'), panel: $('performancePanel'), drawing: $('bodygraph'), inputSurface: $('canvasWrap'),
    ranges: [$('transitTime'), $('natalDayTime'), $('lifetimeTime')],
    motionButtons: [$('fitButton'), $('mandalaSwitch'), $('transitReference'), $('natalDayReference')],
  });

  scope.own(performanceMonitor.destroy);

  function updateChartCaption() {
    if (workspace.screen !== 'chart') { captionPending = true; return; }
    captionPending = false;
    const chart = currentChart();
    // The accepted composition describes the shown moment, even while another
    // source is loading. A pending owner must not change the natal caption.
    const caption = chartCaption(chart, session.record,
      { useUtc: session.shownSource === 'lifetime',
        showAge: Boolean(returns?.available),
        ageUtc: new Date().toISOString() });
    headingLayout.updateText(caption.title, caption.subtitle, caption.moments);
  }

  function renderGraph() {
    if(scope.stopped)return;
    if (workspace.screen !== 'chart') { chartPaintPending = true; return; }
    chartPaintPending = false;
    graph.render();
  }

  function previewGraph() {
    if (workspace.screen !== 'chart') { chartPaintPending = true; return; }
    graph.preview();
  }

  function refreshStudioLayout({ preserveScale = panelResizePending } = {}) {
    layout.refresh();
    headingLayout.refresh();
    const changed = phoneLayout !== layout.phone || mandalaColumns !== layout.showMandalaColumns;
    if (changed) {
      phoneLayout = layout.phone;
      mandalaColumns = layout.showMandalaColumns;
      activationPopover.close();
      hoverPreview?.clear({ notify: false });
      renderGraph();
    }
    gestures.resize({ preserveScale });
    if (panelResizePending) {
      const canvas = $('canvasWrap').getBoundingClientRect(), frame = studio.getBoundingClientRect();
      const target = layout.sideInsets;
      // Geometry, not a timer, ends the transition. Background tabs and slow
      // frames must retain the same physical zoom until the field arrives.
      panelResizePending = Math.abs(canvas.width - target.width) > .1
        || Math.abs(canvas.left - frame.left - target.left) > .1;
    }
    return changed;
  }

  function presentation() {
    if (initialPage.active && !startupRestored() && initialPresentation) return initialPresentation;
    const timeline = exploration!.pendingTimeline || lifetime?.state;
    const source=chartPresentation(session.selectedId,session.record);
    return studioPresentation({ isTransit: source.isTransit,
      personalAvailable: source.personalAvailable && Boolean(returns?.available), dayOpened: Boolean(natalDay?.state.opened),
      lifetime: timeline ? { opened: timeline.opened, mode: timeline.mode } : null, returnsOpened: Boolean(returns?.opened),
      returnsEnabled: exploration!.returnsEnabled, transitEnabled: exploration!.transitEnabled,
      loadFailed: lifetimeLoadFailed });
  }

  function refreshTimelineLayout(view = presentation()) {
    if (!transitControls) return;
    if (initialPage.active) studio.dataset.initialTimeline = view.timelinePanel || 'none';
    const key = `${view.timelineKind}:${view.lifetimeHeadingVisible}`;
    if (key === timelineLayoutKey) return;
    timelineLayoutKey = key;
    layout.setTimelineKind(view.timelineKind);
    return refreshStudioLayout();
  }

  function syncLifetimeTransit() {
    if (lifetime && !lifetime.syncDay() && !lifetime.syncClock()) lifetimeControls?.refreshMoment();
  }

  function updatePage() {
    if(scope.stopped)return;
    const layoutRendered = updateTimelineTools();
    updateChartCaption();updateChartSaveControl();
    chartLibrary!.render(); allCharts?.update(); updateWorkspaceNavigation();
    if (!layoutRendered) renderGraph();
    updateLoading();
    viewSession?.schedule();
    application?.send({type:'BackgroundChanged'});
  }

  function updateWorkspaceNavigation() {
    libraryView.setScreen(workspace.screen);
  }
  async function waitForInitialCharts(revision: number) {
    await fontsReady;
    while (initialPage.active && revision === initialPage.screenRevision && workspace.screen === 'charts') {
      const ready = await allCharts.whenReady();
      if (ready !== null) return ready;
      // Resize or a changed visible set invalidates only that measurement.
      // The same screen still needs its currently visible pixels.
    }
    return false;
  }
  function applyWorkspace() {
    const screen = workspace.screen, revision = ++initialPage.screenRevision;
    const switching = studio.dataset.workspaceScreen !== screen;
    if (switching && studio.dataset.workspaceScreen) discardPendingInput();
    let knowledgeReady: ReturnType<typeof knowledge.show> | null = null;
    // A section return restores the existing panel state, not a drawer command.
    // Commit both the panel and the chart's final width before motion resumes.
    if (switching) studio.dataset.workspaceSwitching = 'true';
    try {
      studio.dataset.workspaceScreen = screen;
      allCharts.setVisible(screen === 'charts');
      knowledgeReady = screen === 'knowledge' ? knowledge.show() : (knowledge.hide(), null);
      $('accountPage').hidden = screen !== 'account';
      account.setVisible(screen === 'account');
      chartSummary!.layout(); chartLibrary!.render(); updateWorkspaceNavigation();
      activationPopover.close(); hoverPreview?.clear();
      panelResizePending = true;
      refreshStudioLayout({ preserveScale: true });
    } finally {
      if (switching) {
        studio.getBoundingClientRect();
        delete studio.dataset.workspaceSwitching;
      }
    }
    if (switching) {
      transit?.visibilityChanged();
      if (screen === 'chart') {
        if (captionPending) updateChartCaption();
        if (chartPaintPending) renderGraph();
      }
    }
    viewSession?.schedule();
    if (initialPage.active) {
      initialPage.screenFailed = false;
      initialPage.screenPending = screen === 'knowledge' || screen === 'charts' || screen === 'account';
      const ready = screen === 'knowledge' ? knowledgeReady : screen === 'charts'
        ? waitForInitialCharts(revision) : screen === 'account' ? account.ready : null;
      if (ready) void Promise.resolve(ready).then(value => {
        if (revision !== initialPage.screenRevision) return;
        initialPage.screenPending = false; initialPage.screenFailed = value === false; updateInitialPage();
      }, () => {
        if (revision !== initialPage.screenRevision) return;
        initialPage.screenPending = false; initialPage.screenFailed = true; updateInitialPage();
      });
      updateInitialPage();
    }
  }
  function inputSnapshot<T extends {focus?: unknown} | null | undefined>(current: T, previous: T, screen: 'account' | 'charts' | 'knowledge'): T {
    return pendingInputRestore && workspace.screen === screen && current && previous?.focus
      ? {...current, focus:previous.focus} : current;
  }
  function restoreInitialInput() {
    if ((!pendingInputRestore && !pendingLifetimeDraft) || initialPage.active || !startupRestored()) return;
    if (viewSession?.interrupted) {discardPendingInput();return;}
    if (workspace.screen === 'chart' && pendingLifetimeDraft) {
      if (!lifetimeControls?.restoreDraft(pendingLifetimeDraft,{restoreFocus:pendingInputRestore})) return;
    } else if (pendingInputRestore && workspace.screen === 'account' && savedView?.account?.focus) account.restoreInputFocus(savedView.account.focus);
    else if (pendingInputRestore && workspace.screen === 'charts' && savedView?.charts?.focus) allCharts.restoreInputFocus();
    else if (pendingInputRestore && workspace.screen === 'knowledge' && savedView?.knowledge?.focus) knowledge.restoreInputFocus();
    pendingInputRestore = false; pendingLifetimeDraft = null;
    viewSession?.schedule();
  }
  function updateInitialPage() {
    if(scope.stopped)return;
    if (!initialPage.active || !initialPage.attached || !fontsSettled || initialPage.screenPending || initialPage.changingTimeline) return;
    let failed = initialPage.screenFailed;
    if (workspace.screen === 'chart') {
      if (!startupRestored()) return;
      const view = presentation(), cycles = returns!.state, day = natalDay!.state, life = lifetime?.state;
      const cyclesVisible = view.returnsVisible || view.personalTimelineVisible;
      failed ||= startupFailed() || lifetimeLoadFailed || day.opened && day.status === 'error'
        || life?.opened && life.status === 'error' || cyclesVisible && (cycles.errors.length > 0 || Boolean(cycles.chartError));
      if (lifetimeLoading || view.returnsVisible && returnsViewLoading) return;
      if (!failed && (!session.hasCurrent || day.opened && day.status === 'loading'
        || life?.opened && life.status === 'loading' || cyclesVisible && (cycles.pendingBodies.length > 0 || cycles.loadingChart))) return;
    }
    initialPage.active = false;
    refreshStudioLayout({ preserveScale: true });
    shell.dataset.pageState = failed ? 'error' : 'ready'; shell.inert = false; shell.setAttribute('aria-busy', 'false');
    releaseInitialContent();
    updateLoading();
    studio.dataset.panelsReady = 'true';
    // Commit final visibility and selected colours with transitions suppressed.
    commitLoadingLayout(document);
    restoreInitialInput();
  }
  scope.own(workspace.subscribe(applyWorkspace));
  applyWorkspace();

  // Views have subscribed first, so their DOM is ready before measuring.
  scope.own(panels.subscribe(() => {
    panelResizePending = true;
    refreshStudioLayout({ preserveScale: true });
    viewSession?.schedule();
  }));

  returns!.select(session.record);
  natalDay!.select(session.record, session.baseChart);
  updatePage();
  for (const name of ['transitionend', 'transitioncancel'] as const) $('canvasWrap').addEventListener(name, event => {
    if (event.target === $('canvasWrap') && ['left', 'width'].includes(event.propertyName) && panelResizePending) {
      refreshStudioLayout({ preserveScale: true });
    }
  }, {signal:scope.signal});
  const layoutObserver = createLayoutObserver(() => refreshStudioLayout());
  scope.own(()=>layoutObserver.disconnect());
  layoutObserver.observe($('canvasWrap'));
  const savedChart=store.get(savedView?.selectedId!);
  const savedTarget=eligibleCycleChart(savedChart) && savedView?.lifetime?.opened?personalTimelineTarget(savedChart):null;
  const restoreView=savedTarget?{...savedView,lifetime:{...savedView!.lifetime!,...savedTarget}}:savedView;
  viewSession = createViewSession({
    checkpoint, store: { read: () => restoreView, write: viewStore.write }, chartStore: store, session,
    onInterrupt:()=>application?.send({type:'StartupInterrupted'}),
    mandala: { get enabled() { return mandalaMode.enabled; },
      restore: enabled => mandalaMode.setEnabled(enabled, { animate: false }) }, camera: gestures, cameraRestored: true, panels, workspace, transit, natalDay: natalDay, planetFilter: transitPlanets,
    getBirthForm: () => pendingBirthForm ?? birthForm.snapshot,
    getLifetimeDraft: () => pendingLifetimeDraft ?? lifetimeControls?.snapshot ?? null, onPersisted:notifyOfflineReady,
    getTemporaryChartSave: () => temporaryChartSave,
    getPendingChartWrites: () => [...chartActions.pending], getAccountView: () => inputSnapshot(account.snapshot,savedView?.account,'account'),
    getKnowledgeView: () => inputSnapshot(knowledge.snapshot,savedView?.knowledge,'knowledge'),
    getChartsView: () => inputSnapshot(allCharts.snapshot,savedView?.charts,'charts'), getLibrarySelection: () => chartLibrary?.selection,
    getPersonalPreview: () => returns!.available ? exploration!.preview : undefined,
    getPersonalLive: () => returns!.available ? exploration!.live : undefined,
    restorePersonalPreview: exploration!.restorePreview,
    restorePersonalLive: exploration!.restoreLive,
    acceptLifetimeMode: exploration!.acceptLifetimeMode,
    getReturns: () => returns, getLifetime: () => lifetime, getLifetimeIntent: () => exploration!.pendingTimeline, loadLifetime,
    openReturnsTimeline: exploration!.openTimeline, canRestoreLifetime: () => (session.selectedId === 'current-transit' || returns!.available),
  });
  const initialRoute=navigation?.snapshot;
  function acceptLocalLibraryChange(change:LibraryLocalChange) {
    for(const key of change.keys){
      const ref=readLibraryPackageKey(key);
      if(ref){void natalDay?.refreshStoredPackage(ref);void returns?.refreshStoredPackage(ref);}
    }
    if(change.keys.includes(session.selectedId))notifyOfflineReady();
  }
  function receiveLocalLibraryChange(value:unknown):boolean {
    if(scope.stopped)return false;
    const change=readLibraryLocalNotice(value,accountLibrary.workingLease,accountLibrary.session?.sessionId);
    if(!change)return false;acceptLocalLibraryChange(change);return true;
  }
  function markLibraryOpened(id:string) {
    pendingLibraryUses++;updateLibraryWork();
    void accountLibrary.markOpened(id).finally(()=>{pendingLibraryUses--;wakeLibraryWork('use');});
  }
  function libraryWorkScope():LibraryFillScope|null {
    const lease=accountLibrary.workingLease,access=accountLibrary.session;
    if(!lease || !access || !libraryInitialized || !startupRestored())return null;
    const foreground=Boolean(initialPage.active || pendingLibraryUses>0 || birthForm.pending || account.snapshot?.verificationPending || account.snapshot?.telegramPending
      || application?.view.destination==='preparing' || application?.write.busy && !application.write.waitingForLogin
      || transit?.state.loading || natalDay?.pending || returns?.pending || lifetimeLoading || lifetime?.pending);
    return {lease,sessionId:access.sessionId,catalogMarker:accountLibrary.completeCatalog?.marker??'',
      visible:pageLifecycle.visible,foreground,online:connectionMode()==='online'};
  }
  function updateLibraryWork() {
    if(!application || scope.stopped)return;
    const key=JSON.stringify(libraryWorkScope());if(key===lastLibraryWork)return;lastLibraryWork=key;
    application.send({type:'FillChanged'});application.send({type:'AuditChanged'});
  }
  function wakeLibraryWork(reason:Extract<LibraryFillEvent,{type:'FillWake'}>['reason']) {
    if(!application || scope.stopped)return;updateLibraryWork();const at=Date.now();
    application.send({type:'FillWake',at,reason});
    if(reason!=='use' && reason!=='space')application.send({type:'AuditWake',at});
  }
  const libraryTransfer=createLibraryFillTransfer({store:libraryStorage,charts:chartClient,cycles:cyclesClient,lease:()=>accountLibrary.workingLease});
  function backgroundTasks():BackgroundTask[] {
    const tasks:BackgroundTask[]=[],access=account.getSession();
    if(releaseCheck || journal)tasks.push({target:{key:'app',scope:{kind:'app'},instance:'release'},
      async run(authority){void journal?.wake();await releaseCheck?.check(authority.signal);return {outcome:{kind:'success'},data:{checked:true}};},
      initial:releaseCheck?.install?.bind(releaseCheck),
      receive(){releaseCheck?.observe();}});
    if(libraryInitialized && startupRestored() && access)tasks.push({
      target:{key:`library:${access.accountId}`,scope:{kind:'library',accountId:access.accountId},sessionId:access.sessionId},
      async run(authority){const result=await accountLibrary.load(authority);const ready=result.status==='complete'||result.status==='unchanged';
        if(ready)wakeLibraryWork('hourly');return {outcome:{kind:ready?'success':'cancelled'}};},
      initial:!document.hidden && connectionMode()==='online'?async signal=>{await accountLibrary.load(undefined,signal);wakeLibraryWork('library');}:undefined,
    });
    const source=store.publicChart?.id===session.selectedId && !accountLibrary.has(session.selectedId)?store.publicChart:null;
    const key=source?`${source.id}/${access?.sessionId??'guest'}`:'';
    if(freshPublic?.source!==source)freshPublic=null;
    if(key!==publicCheckKey || source!==publicCheckSource){publicCheckKey=key;publicCheckSource=source;publicCheckInstance=crypto.randomUUID();}
    if(source && startupRestored())tasks.push({target:{key:`public:${source.id}`,scope:{kind:'public',chartId:source.id},instance:publicCheckInstance},
      run:authority=>freshPublic?.source===source && authority.permit.startedAt>=freshPublic.receivedAt && authority.permit.startedAt-freshPublic.receivedAt<2000
        ?Promise.resolve({outcome:{kind:'success',checkedAt:freshPublic.checkedAt},data:{chart:source}})
        :application!.refreshPublic(authority),
      receive:data=>application!.send({type:'PublicSourceObserved',source,access,data}),
    });
    return tasks;
  }
  application = createApplication({runtimeId:crypto.randomUUID(),navigation,background:{coordinator:backgroundCoordinator,tasks:backgroundTasks},
    libraryFill:{...libraryTransfer,scope:libraryWorkScope,entries:()=>accountLibrary.completeCatalog?.entries??null,
      control:libraryStorage.fill,inventory:libraryStorage.maintenance.inventory,
      accepted(_candidate,payload,authority){
        const packet=payload as LibraryFillPacket;
        if(packet.kind==='card' && accountLibrary.acceptStored(packet.chart,packet.marker,authority.permit.lease,authority.permit.sessionId) && session.selectedId===packet.chart.id)notifyOfflineReady();
      }},
    libraryAudit:{scope:libraryWorkScope,store:libraryStorage.maintenance},
    update:{
    restored:()=>!initialPage.contentFailed && !initialPage.screenPending && !initialPage.screenFailed,
    ready(){
      if(birthForm.pending || account.snapshot?.verificationPending || account.snapshot?.telegramPending)return false;
      // An unfinished field must have a supported checkpoint owner.
      if(birthForm.opened && !birthForm.snapshot)return false;
      const focused=document.activeElement;
      const savedFocus = birthForm.snapshot?.focus
        || workspace.screen === 'account' && focused?.id === 'accountEmail' && account.snapshot?.focus
        || workspace.screen === 'charts' && focused?.id === 'allChartsSearch' && allCharts.snapshot.focus
        || workspace.screen === 'knowledge' && focused?.id === 'knowledgeSearch' && knowledge.snapshot?.focus
        || workspace.screen === 'chart' && ['lifetimeFromDate','lifetimeToDate'].includes(focused?.id ?? '') && lifetimeControls?.snapshot?.focus;
      if(focused?.matches?.('input,textarea,[contenteditable="true"]') && !savedFocus)return false;
      return true;

    },
    selection:()=>session.selectedId,
    canRestore(selected){
      return selected==='current-transit' || selected===store.temporaryChart?.id
        || !accountLibrary.get(selected) && selected===store.publicChart?.id || accountLibrary.canRestore(selected);
    },
    checkpoint:()=>viewSession!.flush(),
  },startup:{
    ready:()=>libraryReady,
    current:()=>!viewSession!.interrupted && (!initialRoute || navigation!.isCurrent(initialRoute)),
    async route(){
      projectAccountLibrary();
      if(initialRoute)await application!.requestRoute(initialRoute,true);
    },
    async restore(signal){
      if(initialRoute?.route?.kind!=='chart' && accountLibrary.get(savedView?.selectedId??'')) {
        try{await accountLibrary.open(savedView!.selectedId!,signal);}catch{/* Only accepted downloaded records can be restored. */}
      }
      if(signal.aborted || initialRoute && !navigation!.isCurrent(initialRoute))return false;
      return viewSession!.restore(signal);
    },
    resume:()=>exploration!.finishRestore({saved:restoreView,interrupted:viewSession!.interrupted,
      pendingLifetime:viewSession!.pendingLifetime,pendingReturns:viewSession!.pendingReturns}),
    commit(){
      const draft=pendingBirthForm;pendingBirthForm=null;
      if(draft && !birthForm.opened)birthForm.restore(draft);
      viewSession!.flush();
      application!.send({type:'RecoverWrites'});application!.send({type:'BackgroundChanged'});
    },
    report(){toast('Не удалось восстановить положение страницы.');},
    changed(){
      if(startupRestored())initialPresentation=null;
      updateTimelineTools();updateLoading();restoreInitialInput();notifyOfflineReady();
      application?.send({type:'BackgroundChanged'});
      if(startupRestored())wakeLibraryWork('lifecycle');
    },
  },publicRefresh:{
    source:()=>store.publicChart,getSession:account.getSession,read:chartClient.public,
    available:()=>store.publicChart?.id===session.selectedId && !application?.write.source && startupRestored() && connectionMode()==='online'
      && !accountLibrary.get(store.publicChart!.id),
    accept(previous,next){
      store.acceptPublic(next);
      if(publicCheckSource===previous)publicCheckSource=store.publicChart;
      if(session.selectedId===next.id && !accountLibrary.get(next.id)) {
        if(previous.utc!==next.utc || JSON.stringify(previous.activations)!==JSON.stringify(next.activations))graph.changeChart(next.id);
        else session.refreshRecord();
      }
      updatePage();viewSession?.flush();
    },
    missing(previous){
      store.clearPublic(previous.id);
      if(session.selectedId===previous.id && !accountLibrary.get(previous.id)) {
        if(workspace.screen==='chart')selectChart('current-transit',{replace:true});else graph.changeChart('current-transit');
      }
      updatePage();viewSession?.flush();
    },
  }, write:{
    actions:chartActions,online:()=>connectionMode()!=='offline',getSession:account.getSession,
    async ready(){await libraryReady;if(account.getSession())await application!.requestSession(account.getSession());},
    source:()=>session.record,temporary:()=>store.temporaryChart,hasOwn:id=>!!accountLibrary.get(id),
    binding:()=>temporaryChartSave,bind:value=>{temporaryChartSave=value;},
    retire(source){store.clearTemporary(source.id);store.releasePublicSource(source);},
    public:chartClient.public,acceptPublic:store.acceptPublic,clearPublic:store.clearPublic,
    view:{
      signIn(){navigateWorkspace('account');},select(id){selectChart(id,{replace:true});},
      adopt(chart,source,follow){
        const selected=session.record===source;
        if(selected && session.adopt(chart.id,source.id)) {
          if(follow)workspace.setScreen('chart');
          if(workspace.screen==='chart')publishRoute({kind:'chart',id:chart.id},true);
        } else if(follow)selectChart(chart.id,{replace:true});
        else if(selected)graph.changeChart(chart.id);
        if(!follow)updatePage();
      },
      deleted(id){
        if(session.selectedId===id && !accountLibrary.get(id)) {
          if(workspace.screen==='chart')selectChart('current-transit',{replace:true});else graph.changeChart('current-transit');
        }
      },
      changed(){updateChartSaveControl();notifyOfflineReady();updateLibraryWork();},checkpoint(){viewSession?.flush();},
      report(kind,error){toast(error===undefined?kind==='unconfirmed'?UI_MESSAGES.chartSaveUnconfirmed
        :kind==='unavailable'?UI_MESSAGES.chartUnavailable:UI_MESSAGES.chartSaveFailed:failureMessage(error,UI_MESSAGES.chartSaveFailed));},
    },
  }, account:{
    subscribeSession(listener){return account.subscribeSession(()=>listener(account.getSession()));},
    subscribeLogout(listener){return account.subscribeNotices(notice=>{if(notice.kind==='logout')listener(notice.ids);});},
    begin:beginAccountBoundary,
    stop(){application?.send({type:'CancelPublicRefresh'});},
  },route(request) {
      const route = request.snapshot.route!;
      const observation = route.kind === 'chart' ? journal?.begin({action:'chart_open',component:'chart'}) : undefined;
      return {
        enter() {
          if (route.kind==='chart' || route.kind==='temporary-chart' || route.kind==='transit') application?.send({type:'CancelPublicRefresh'});
          if (!request.initial) {cancelChartSave();viewSession?.interrupt();}
          librarySelection++;
          navigateWorkspace(route.kind === 'chart' || route.kind === 'temporary-chart' || route.kind === 'transit' ? 'chart' : route.kind, {fromRoute:true});
        },
        async prepare(signal, current) {
          if (route.kind !== 'chart') return;
          await libraryReady;
          if (!current()) return;
          await application!.requestSession(account.getSession());
          if (!current()) return;
          if (accountLibrary.get(route.id)) await accountLibrary.open(route.id, signal);
          else {
            const cached=store.publicChart?.id===route.id
              ? store.publicChart : null;
            let chart,checkedAt:number|undefined;
            try {
              if(connectionMode()==='offline' && cached)chart=cached;
              else {checkedAt=Date.now();chart=await chartClient.public(route.id,signal);}
            }
            catch(error) {
              const code=(error as {code?:string})?.code;
              if(!cached || !['offline','connection_failed','server_unavailable'].includes(code??''))throw error;
              chart=cached;checkedAt=undefined;
            }
            if (current()) {store.acceptPublic(chart);if(checkedAt!==undefined)freshPublic={source:store.publicChart!,checkedAt,receivedAt:Date.now()};}
          }
        },
        apply() {
          if (request.initial) return;
          if (route.kind === 'chart') selectChart(route.id, {fromRoute:true});
          else if (route.kind === 'transit') selectChart('current-transit', {fromRoute:true});
          else if (route.kind === 'temporary-chart') selectChart(store.temporaryChart?.id ?? 'current-transit', {fromRoute:true});
        },
        async failed(error) {
          void observation?.reportError(error,{stage:'request'});
          toast(failureMessage(error, UI_MESSAGES.chartUnavailable));
          if (route.kind === 'chart' && (error as {code?:string})?.code === 'not_found') {
            store.clearPublic(route.id);selectChart('current-transit',{replace:true});viewSession?.flush();
            if (request.initial) {
              const redirected=navigation!.snapshot,ready=await transit!.start(null,{firstChart:true});
              if(application?.view.lifecycle === 'running' && navigation!.isCurrent(redirected)){initialPage.contentFailed=ready===false;updateLoading();}
            }
          }
        },
        settled() {
          if (!request.initial) { initialPresentation = null; }
        },
        dispose() { observation?.finishSuccess(); },
      };
    }});
    scope.own(()=>application!.stop());
    scope.own(application.subscribe(updateLoading));
    application.start();
  scope.own(accountLibrary.subscribe(projectAccountLibrary));
  scope.own(libraryStorage.subscribeLocal(change=>{
    const sessionId=accountLibrary.session?.sessionId;if(!sessionId)return;
    const notice:LibraryLocalNotice={kind:'local-storage',sessionId,...change};
    if(receiveLocalLibraryChange(notice))notifyLibrary(notice);
  }));
  let pageVisible=pageLifecycle.visible;
  scope.own(pageLifecycle.subscribe(returned=>{
    const appeared=pageLifecycle.visible && !pageVisible;pageVisible=pageLifecycle.visible;
    updateLibraryWork();if(returned || appeared)wakeLibraryWork('lifecycle');
  }));
  if (libraryChannel) libraryChannel.onmessage = async event => {
    if(scope.stopped || receiveLocalLibraryChange(event.data))return;
    if (libraryInitialized) {
      const prior=accountLibrary.completeCatalog;await accountLibrary.receive(event.data).catch(() => {});
      updateLibraryWork();if(accountLibrary.completeCatalog && accountLibrary.completeCatalog!==prior)wakeLibraryWork('library');
    }
  };
  document.addEventListener('visibilitychange', () => {
    if(!document.hidden)void journal?.wake();
    if (!document.hidden && libraryInitialized) {
      void accountLibrary.refreshLocal().catch(() => {});
      application!.send({type:'RecoverWrites'});
      syncTransitCacheWindow(transit?.state.timeline, true);
    }
  }, {signal:scope.signal});
  let previousConnection = connectionMode();
  scope.own(observeConnection(() => {
    const connection = connectionMode(), returned = previousConnection !== 'online' && connection === 'online';
    previousConnection = connection;updateChartSaveControl();
    void natalDay?.refreshAvailability();
    void returns?.refreshAvailability();
    lifetime?.refreshAvailability(); updateTimelineTools();
    if (returned) {syncTransitCacheWindow(transit?.state.timeline, true);void journal?.wake();}
    if (!libraryInitialized) return;
    if (connectionMode() !== 'offline') application!.send({type:'RetryAccountBoundary'});
    application!.send({type:'RecoverWrites'});application!.send({type:'BackgroundChanged'});
  }));
  const restoration = application.whenRestored();
  studio.dataset.panelsReady = 'true';

  function loadReturnsView(): Promise<ReturnsPanel | null> {
    if(scope.stopped)return Promise.resolve(null);
    if (returnsView) return Promise.resolve(returnsView);
    if (returnsViewLoading) return returnsViewLoading;
    returnsViewLoading = import('./views/returns-panel.ts').then(({ attachReturnsPanel }) => {
      if(scope.stopped)return null;
      returnsView = attachReturnsPanel({ viewportLayout: layout,
        document, onBack: () => returns!.close(),
        onYear: value => returns!.setYear(value),
        onBodies: value => returns!.setBodies(value),
        onSelect: async value => { viewSession?.interrupt(); await returns!.selectEvent(value); },
        onBirth: () => { viewSession?.interrupt(); returns!.setYear(null); exploration!.resetMoment(); },
        onNow: () => { viewSession?.interrupt(); returns!.setYear(null); exploration!.followNow(); },
        onRetry: () => returns!.retry(),
        onLayout: refreshStudioLayout,
      });
      // Loading only supplies the view. The controller still owns whether its
      // drawer is open, including another click or navigation during the import.
      updateTimelineTools();
      return returnsView;
    }).catch(() => {
      if(scope.stopped)return null;
      if (initialPage.active) { initialPage.contentFailed = true; }
      if (returns!.opened) { returns!.close(); toast('Не удалось открыть возвраты. Попробуйте ещё раз.'); }
      return null;
    }).finally(() => { returnsViewLoading = null; updateInitialPage(); });
    return returnsViewLoading;
  }

  function updateTimelineTools() {
    if(scope.stopped)return;
    if (!returns) return;
    const state = returns!.state, lifetimeState = lifetime?.state, metadata = lifetimeState?.metadata;
    const view = presentation();
    const dayOpen = view.timelinePanel === 'natal-day';
    $('natalDayToggle').setAttribute('aria-expanded', String(dayOpen));
    $('natalDayToggle').setAttribute('aria-pressed', String(dayOpen));
    if (initialPage.active && initialPresentation) {
      for (const [kind, id] of [['transit', 'transitControls'], ['natal-day', 'natalDayControls'], ['lifetime', 'lifetimeControls']] as const)
        $(id).hidden = kind !== view.timelinePanel;
    }
    const heading = $('lifetimeControls').querySelector<HTMLElement>('.lifetime-heading')!;
    heading.hidden = !view.lifetimeHeadingVisible; heading.inert = !view.lifetimeHeadingVisible;
    $('lifetimeControls').dataset.personalLife = String(state.available);
    $('summaryReturns').hidden = !state.available;
    $<HTMLButtonElement>('summaryReturns').disabled = !state.opened && !state.canOpen;
    // Source labels describe the same resolved chart as the scene.
    const chart = currentChart();
    const viewState = { ...state, visible: view.returnsVisible,
      birthSelected: !exploration!.live && chart.primary === session.baseChart && !chart.secondary, live: exploration!.live,
      nowAvailable: connectionMode() !== 'offline' || transit?.state.referenceIndex != null };
    chartSummary!.setReturnsVisible(view.returnsVisible);
    if (returnsView) returnsView!.update(viewState);
    else if (view.returnsVisible) void loadReturnsView();
    const lifetimeToggle = $('lifetimeToggle');
    lifetimeToggle.hidden = !view.lifetimeAvailable;
    (lifetimeToggle as HTMLButtonElement).disabled = !view.toggleEnabled && (connectionMode() === 'offline'
      && !lifetimeState?.metadata && (session.selectedId !== 'current-transit' || !transit?.state.current));
    lifetimeToggle.title = view.toggleLabel;
    lifetimeToggle.setAttribute('aria-label', view.toggleLabel);
    lifetimeToggle.setAttribute('aria-controls', 'lifetimeControls');
    lifetimeToggle.setAttribute('aria-expanded', String(view.toggleEnabled));
    lifetimeToggle.setAttribute('aria-pressed', String(view.toggleEnabled));
    const valid = view.personalTimelineVisible && metadata;
    const window = valid ? returnsVisibleWindow(state.natal, state.year, lifetimeState) : null;
    lifetimeControls?.setVisibleWindow(window && { ...window, calendar: Number.isInteger(state.year),
      timeZone: cycleTimeZone(state.natal?.timezone) });
    returnMarkers?.update({ events: state.events, natal: state.natal, displayedUtc: chart?.utc,
      readyEvents: state.offline ? state.readyEvents : undefined,
      fromUtc: window?.minUtc ?? NaN,
      toUtc: window?.maxUtc ?? NaN,
      visible: Boolean(valid) });
    const changed = refreshTimelineLayout(view);
    updateInitialPage();
    return changed;
  }

  // Both a toolbar click and page restoration use the same lazy controller.
  // Importing it alone never opens Lifetime or resets a restored date range.
  async function loadLifetime(): Promise<LifetimeExplorer | null> {
    if(scope.stopped)return null;
    if (lifetime) return lifetime;
    if (lifetimeLoading) return lifetimeLoading;
    if (lifetimeLoadFailed) return null;
    $('lifetimeToggle').setAttribute('aria-busy', 'true');
    lifetimeLoading = (async () => {
      try {
        const [{ createLifetimeExplorer }, { attachLifetimeControls }] = await Promise.all([
          import('./state/lifetime.ts'), import('./views/lifetime-controls.ts'),
        ]);
        if(scope.stopped)return null;
        const getDayState = () => session.selectedId === 'current-transit' ? transit!.state : null;
        const getPersonalRecord = () => returns!.available ? returns!.natal : null;
        let controls: LifetimeControls | undefined;
        const controller = createLifetimeExplorer({
          connection: connectionMode,
          visible:()=>!document.hidden,
          observe: action => journal?.begin(action),
          dayClient, natalDayClient, planetFilter: transitPlanets,
          getDayState, getPersonalRecord, getMomentState: exploration!.momentState,
          onRender: exploration!.publishLifetime,
          onModeAccepted: exploration!.acceptLifetimeMode,
          onStateChange(state) {
            controls?.update(state);
            transitControls!.setCoveredByLifetime(state.opened || session.selectedId !== 'current-transit');
            viewSession?.schedule();
            exploration!.lifetimeChanged(state);
            updateTimelineTools(); updateLoading();
          },
        });
        controls = attachLifetimeControls({
          explorer: controller, viewportLayout: layout, getDayState, getPersonalRecord,
          formatEndpoints: state => {
            const natal = session.record;
            if (eligibleCycleChart(natal) && !natalDay!.state.opened && Number.isInteger(returns!.year)) {
              const visible = returnsVisibleWindow(natal, returns!.year, state);
              if (visible) {
                const label = new Intl.DateTimeFormat('ru', { timeZone: cycleTimeZone(natal!.timezone), month: 'short', year: 'numeric' });
                return [label.format(visible.minUtc), label.format(visible.maxUtc)];
              }
            }
            return eligibleCycleChart(natal) && !natalDay!.state.opened
              ? ['Рождение', ageText(completedAge(`${state.toDate}T23:59:59Z`, natal)!)] : null;
          },
          getMomentState: exploration!.momentState,
          onDayScrub: transit!.scrub, onDayNow: transit!.goNow,
          onLifetimeNow: () => {
            if (returns!.available) returns!.setYear(null);
            if (!exploration!.followNow()) return false;
            returns!.close(); return true;
          },
          resolveTap: (event, metrics) => returnMarkers!.hitTest(event, metrics),
          beforeScrub: exploration!.beforeScrub,
          onMomentInput: () => { discardPendingInput(); viewSession?.interrupt(); },
          onDraftChange: () => viewSession?.schedule(),
          panel: $('lifetimeControls'), range: $('lifetimeTime'), marker: $('lifetimeReference'),
          status: $('lifetimeStatus'), hourMarks: $('lifetimeHourMarks'),
          fromDate: $('lifetimeFromDate'), toDate: $('lifetimeToDate'),
          fromError: $('lifetimeFromError'), toError: $('lifetimeToError'),
          fromCalendar: $('lifetimeFromCalendar'), toCalendar: $('lifetimeToCalendar'),
        });
        scope.own(controls.dispose);
        lifetime = controller;
        lifetimeControls = controls;
        return lifetime;
      } catch {
        if(scope.stopped)return null;
        lifetimeLoadFailed = true; updateLoading(); updateTimelineTools();
        return null;
      } finally {
        lifetimeLoading = null;
        if(!scope.stopped)$('lifetimeToggle').removeAttribute('aria-busy');
        updateInitialPage();
      }
    })();
    return lifetimeLoading;
  }
  function changeTimeline(kind: 'day' | 'lifetime', command: () => unknown) {
    discardPendingInput();
    const pending = initialPresentation;
    const loading = initialPage.active;
    if (loading) { initialPage.changingTimeline = true; initialPage.contentFailed = false; }
    initialPresentation = null;
    viewSession?.interrupt();
    let result;
    try {
      const closePending = kind === 'day' ? pending?.timelinePanel === 'natal-day' : pending?.toggleEnabled;
      result = closePending ? exploration!.closeScales() : command();
    }
    finally {
      if (loading) initialPage.changingTimeline = false;
      updateTimelineTools(); updateLoading();
    }
    Promise.resolve(result).then(() => { updateTimelineTools(); updateLoading(); });
  }
  $('lifetimeToggle').addEventListener('click', () => {
    if (session.selectedId !== 'current-transit' && !returns!.available) return;
    activationPopover.close(); hoverPreview?.clear();
    if (lifetimeLoadFailed) { window.location.reload(); return; }
    if (session.selectedId === 'current-transit') {
      changeTimeline('lifetime', () => exploration!.toggleTransit());
    } else changeTimeline('lifetime', () => exploration!.toggleReturns());
  }, {signal:scope.signal});
  for (const field of [$('lifetimeFromDate'), $('lifetimeToDate')]) {
    field.addEventListener('input', () => { viewSession?.interrupt(); exploration!.invalidateTimeline(); }, {capture:true,signal:scope.signal});
  }
  initialPage.attached = true;
  updateInitialPage();
  commitLoadingLayout(document);
  // The startup owner keeps its checkpoint if assembly throws before handoff.
  if(viewCheckpoint)scope.own(checkpoint.destroy);
  const offlineRestored = () => application!.isRestored();
  return { saveShownChart,cancelChartSave,restoration,offlineRestored,
    attachReleaseCheck(port:ReleaseCheckPort){if(scope.stopped){port.stop();return;}releaseCheck?.stop();releaseCheck=port;application?.send({type:'BackgroundChanged'});},
    subscribeOfflineReady(listener:()=>void){offlineListeners.add(listener);return()=>{offlineListeners.delete(listener);};},
    prepareOfflineUpdate:()=>application!.prepareUpdate(),
    stopApplication: scope.stop,
    flushView: () => viewSession!.flush(),
    attachJournal(value:AppJournal){
      if(scope.stopped){void value.close?.();return;}
      if(journal===value)return;
      const current=syncJournalAccount();journal=value;
      if(lastJournalAccount!==null)journal.setAccount(lastJournalAccount,lastJournalSession,lastJournalProof);
      if(journalBoundaryPending)journal.leave([...journalBoundaryIds]);
      if(lastJournalAccount===null || current!==lastJournalAccount || journalBoundaryPending)journal.setAccount(current,account.getSession()?.sessionId,account.getSession()?.diagnosticProof);
      journalBoundaryPending=false;journalBoundaryIds.clear();application?.send({type:'BackgroundChanged'});
    } };
  } catch(error) {
    void scope.stop().catch(cleanupError=>console.error('Application cleanup failed',cleanupError));
    throw error;
  }
}
