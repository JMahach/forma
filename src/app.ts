import { chartPresentation } from './domain/chart-presentation.ts';
import { createViewCheckpoint } from './state/view-checkpoint.ts';
import type { ViewCheckpoint } from './state/view-checkpoint.ts';
import type { AccountBoundaryRequest, AccountBoundaryWork } from './application/ports.ts';
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
import type { AccountChart, ChartWriteIntent } from '../shared/chart-record-contract.ts';
import type { SavedChart } from '../shared/chart-types.ts';
import type { BirthSubmission } from './views/birth-form.ts';
import type { ChartActionResult } from './state/chart-actions.ts';
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
type AppJournal=Pick<ReturnType<typeof createJournal>,'begin'|'setAccount'> & Partial<Pick<ReturnType<typeof createJournal>,'discardForSpace'>> & {leave(ids?:readonly string[]):unknown;wake():unknown};
interface AppOptions {
  journal?:AppJournal;
  storagePressure?:StoragePressure;
  navigation?: Navigation;
  calculationClients?: Pick<CalculationClients, 'natal' | 'cycles' | 'resetPersonal' | 'retryPersonalCleanup'> & Partial<Pick<CalculationClients,'evictForSpace'|'syncTransitWindow'|'library'>>;
  account: Pick<AccountWorkspace, 'ready' | 'snapshot' | 'restoreInputFocus' | 'setVisible' | 'getSession' | 'subscribeSession' | 'subscribeNotices' | 'canRestoreLibrary'>;
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
export function startApp({ journal, storagePressure, navigation, calculationClients, account, dayClient, layout, toast, viewStore, viewCheckpoint, savedView, panels, workspace, store, libraryView, camera, cameraView, gestures: startupGestures = null, initialPresentation = null, releaseLoadingContent = null }: AppOptions) {
  const checkpoint=viewCheckpoint??createViewCheckpoint({store:viewStore,eventTarget:document.defaultView,interactionTarget:document});
  let application: Application | null = null;
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
  document.addEventListener('pointerdown', cancelInputRestore, true);
  document.addEventListener('keydown', cancelInputRestore, true);
  document.addEventListener('input', cancelInputRestore, true);
  const $ = <T extends Element = HTMLElement>(id: string) => document.getElementById(id) as unknown as T;
  attachTelegramGestures([$('canvasWrap'), $('transitTime'), $('natalDayTime'), $('lifetimeTime')]);
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
  let returnMarkers: ReturnType<typeof attachReturnMarkers> | null = null;
  let exploration: ReturnType<typeof createChartExploration> | null = null, timelineLayoutKey = '';
  let phoneLayout = layout.phone, mandalaColumns = layout.showMandalaColumns;
  const activationPopover = attachActivationPopover($('activationPopover'), $('bodygraph'), { viewportLayout: layout });
  const transitPlanets = createTransitPlanetFilter();
  const session = createChartSession({ store, initialSelectedId: savedView?.selectedId, getTransit: () => transit, getNatalDay: () => natalDay,
    getLifetime: () => lifetime, getReturns: () => returns,
    filterTransit: transitPlanets.filter, resetTransitFilter: transitPlanets.reset,
    onSelect: () => exploration?.selected(), onChange: updatePage });
  exploration = createChartExploration({ session, getTransit: () => transit, getNatalDay: () => natalDay!,
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
    const lifetimeLoading = lifetimeOwnsLoading(), state = lifetimeLoading ? lifetime?.state : transit?.state;
    const firstFailed = startupRestored() && startupFailed() && !session.hasCurrent;
    chartLoading.update({ hasChart: !routePending() && !routeFailed() && session.hasCurrent, holdLoading: initialPage.active,
      failed: routeFailed() || firstFailed || (lifetimeLoading ? lifetimeLoadFailed || state?.status === 'error' : transit?.state.unavailable),
      loading: routePending() || !firstFailed && (lifetimeLoading ? !lifetimeLoadFailed && (!state || state.status === 'loading') : transit?.state.loading) });
    updateInitialPage();
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
  chartHighlight.subscribe(() => renderGraph());
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
    if (session.selectedId === id) void accountLibrary.markOpened(id);
    gestures.reset();
    const destination = routeForChart(id);
    if (!fromRoute) publishRoute(destination, replace);
  }
  const birthClient = createBirthClient();
  const chartClient = createChartClient({getSession: account.getSession});
  let libraryChannel: BroadcastChannel | null = null;
  try {libraryChannel = new window.BroadcastChannel('forma-library');} catch { /* Resuming a tab also checks its local library. */ }
  const notifyLibrary = () => {try {libraryChannel?.postMessage({kind: 'changed'});} catch {}};
  const libraryStorage = calculationClients?.library ?? createAccountLibraryStore({pressure: storagePressure});
  storagePressure?.setSources({
    diagnostics: guard => journal?.discardForSpace?.(guard) ?? Promise.resolve('unavailable'),
    natalDays: (keep, exclude, guard) => calculationClients?.evictForSpace?.('natal', keep, exclude, guard) ?? Promise.resolve('unavailable'),
    returnCharts: (keep, exclude, guard) => calculationClients?.evictForSpace?.('return-charts', keep, exclude, guard) ?? Promise.resolve('unavailable'),
  });
  const accountLibrary = createAccountLibrary({client: chartClient, storage: libraryStorage,
    online: () => getConnectionMode() !== 'offline',
    restoreAllowed: account.canRestoreLibrary, notify: notifyLibrary});
  const chartLink = attachChartLink({button: $<HTMLButtonElement>('copyChartLink'), root: shell, boundary: $('chartSummary')});
  let formIntent: ChartWriteIntent | null = null, privateLibraryShown = false, librarySelection = 0;
  const chartActions = createChartActions({client: chartClient, library: accountLibrary,
    getSession: account.getSession, calculate: birthClient.calculate, initialPending: savedView?.pendingChartWrites,
    prepareWrite: () => viewSession!.checkpoint('write'),
    onPending: () => {viewSession?.flush();}});
  function saveShownChart():Promise<void> {
    if(getConnectionMode()==='offline'){toast(UI_MESSAGES.offline);return Promise.resolve();}
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
    const availability=actionAvailability({connection:getConnectionMode(),requiresConnection:true,
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
  $('saveShownChart').addEventListener('click',()=>saveShownChart());
  $('accountPage').addEventListener('click',event=>{
    const button=(event.target as Element).closest<HTMLButtonElement>('[data-account-action]');
    if(button && !button.disabled && ['back','close','cancel'].includes(button.dataset.accountAction!))cancelChartSave();
  },true);
  const actionError = (code: string, message: string) => Object.assign(new Error(message), {code});
  const canAccessCharts = () => !accountLibrary.accountId || Boolean(account.getSession());
  const canEditCharts = () => canAccessCharts()
    && !actionAvailability({ connection: getConnectionMode(), requiresConnection: true }).disabled;
  function projectAccountLibrary() {
    if (!privateLibraryShown && !accountLibrary.accountId) return;
    privateLibraryShown = true;
    const publicId=store.publicChart?.id, priorPublic=publicId?store.charts.find(chart=>chart.id===publicId):null;
    // Confirmed disappearance within the same account also revokes a prior public view.
    // Logout/account switching have a different owner and preserve the public tab source.
    if(priorPublic && 'accountId' in priorPublic && priorPublic.accountId===accountLibrary.accountId
      && !accountLibrary.get(priorPublic.id))store.clearPublic(priorPublic.id);
    // Account projection may replace the same ID with a private or not-yet-ready
    // record. It does not supersede the accepted source of an explicit save.
    const preserveSaveSource = Boolean(application?.write.source && session.record === application.write.source);
    if(preserveSaveSource)store.showPublic(application!.write.source);
    const previous = session.record, editedId = birthForm.editedId;
    store.projectLibrary(accountLibrary.charts, accountLibrary.storageAvailable,
      accountLibrary.charts.map(chart => chart.id));
    birthForm.refresh();
    if (startupRestored() && !preserveSaveSource && editedId && !store.get(editedId)) {
      librarySelection++; selectChart('current-transit', {replace:true});
      return;
    } else if (startupRestored() && !preserveSaveSource && session.selectedId !== 'current-transit') {
      const next = store.get(session.selectedId);
      if (!next || !store.has(next.id)) { librarySelection++; selectChart('current-transit', {replace:true}); }
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
      if (privateLibraryShown && id !== 'current-transit' && id !== store.temporaryChart?.id && !accountLibrary.get(id)) return;
      if (accountLibrary.get(id)) await accountLibrary.open(id);
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
      const result=await performAccountChartSubmission(input,signal);
      observation?.finishSuccess();return result;
    }catch(error){void observation?.reportError(error,{stage:'commit'});throw error;}
  }
  async function performAccountChartSubmission(input: BirthSubmission, signal: AbortSignal) {
    const access = account.getSession();
    await libraryReady; signal.throwIfAborted();
    if (!access || account.getSession()?.accountId !== access.accountId || account.getSession()?.sessionId !== access.sessionId)
      throw actionError('account_changed', UI_MESSAGES.chartSaveSignIn);
    let result: ChartActionResult;
    if (formIntent) result = await chartActions.recover(formIntent, signal);
    else {
      const previous = input.previous as (SavedChart & Partial<AccountChart>) | undefined;
      if (previous) {
        if (previous.accountId !== access.accountId || !previous.noteRevision) throw actionError('auth_required', UI_MESSAGES.chartSaveSignIn);
        const name = previous.name === input.name ? {} : {name: input.name};
        const note = previous.note === input.note ? {} : {note: {value: input.note, seenRevision: previous.noteRevision}};
        if (!input.birth && !Object.keys(name).length && !Object.keys(note).length)
          return {id: previous.id, persisted: accountLibrary.storageAvailable, metadataOnly: true};
        result = await chartActions.update({chartId: previous.id, ...name, ...note, ...(input.birth ? {birth: input.birth} : {})}, signal);
      } else {
        if (!input.birth) throw actionError('invalid_request', UI_MESSAGES.chartSaveFailed);
        result = await chartActions.create({name: input.name, note: input.note, birth: input.birth}, signal);
      }
    }
    if (result.kind === 'unknown') {
      formIntent = result.intent;
      throw actionError('write_unknown', UI_MESSAGES.chartSaveUnconfirmed);
    }
    if (result.kind !== 'settled' || !result.active) throw actionError('account_changed', UI_MESSAGES.chartSaveSignIn);
    const outcome = result.receipt.outcome;
    if (outcome.kind === 'rejected') throw actionError(outcome.code, UI_MESSAGES.chartSaveFailed);
    if (!result.chart) {
      formIntent = {operationId: result.receipt.operationId, expectedAccountId: result.receipt.expectedAccountId};
      throw actionError('chart_unavailable', UI_MESSAGES.chartUnavailable);
    }
    formIntent = null;
    return {id: result.chart.id, persisted: accountLibrary.storageAvailable, metadataOnly: Boolean(input.previous && !input.birth)};
  }
  async function removeAccountChart(id: string, signal: AbortSignal) {
    const observation=journal?.begin({action:'chart_delete',component:'chart'});
    try {
      const result=await performAccountChartRemoval(id,signal);
      if(result.kind==='unknown')void observation?.reportFailure({stage:'response',reason:'outcome_unknown',outcome:'unknown'});
      else observation?.finishSuccess();
      return result;
    }catch(error){void observation?.reportError(error,{stage:'request'});throw error;}
  }
  async function performAccountChartRemoval(id: string, signal: AbortSignal): Promise<{kind:'deleted'|'unknown'|'inactive'|'rejected'; error?:unknown}> {
    const access = account.getSession();
    if (!access) return {kind:'inactive'};
    let result = await chartActions.remove(id, signal);
    const active = () => !signal.aborted && account.getSession()?.accountId === access.accountId
      && account.getSession()?.sessionId === access.sessionId;
    if (!active()) return {kind:'inactive'};
    // A lost response permits only a GET of the receipt, never another delete.
    if (result.kind === 'unknown' && getConnectionMode() === 'online') {
      try {result = await chartActions.recover(result.intent, signal);}
      catch (error) {return active() ? {kind:'unknown',error} : {kind:'inactive'};}
      if (!active()) return {kind:'inactive'};
    }
    if (result.kind === 'unknown') return {kind:'unknown', error:result.error};
    if (result.kind !== 'settled' || !result.active) return {kind:'inactive'};
    const deleted=result.receipt.outcome.kind === 'deleted' || result.receipt.outcome.kind === 'absent';
    if(deleted && store.clearPublic(id))viewSession?.flush();
    return {kind:deleted ? 'deleted' : 'rejected'};
  }
  let libraryInitialized = false;
  function beginAccountBoundary(request:AccountBoundaryRequest):AccountBoundaryWork {
    const access=request.access, previousAccount=accountLibrary.accountId, logout=request.logoutIds;
    // These owners fence the old generation before any asynchronous continuation.
    const clearing=logout?accountLibrary.clear():null;
    const connecting=logout?Promise.resolve():accountLibrary.connect(access);
    application?.send({type:'CancelPublicRefresh'});syncJournalAccount();
    chartLibrary?.closeDelete();
    const resetPersonal=!!logout || !!access && (previousAccount!==null && previousAccount!==access.accountId
      || chartActions.pending.some(intent=>intent.expectedAccountId!==access.accountId)
      || !!temporaryChartSave && temporaryChartSave.expectedAccountId!==access.accountId);
    // The calculation owner retains failed cleanup across session boundaries.
    const cleanup=resetPersonal?calculationClients?.resetPersonal():calculationClients?.retryPersonalCleanup();
    let snapshotReady=true;
    if(logout){
      if(!journal){journalBoundaryPending=true;for(const id of logout)journalBoundaryIds.add(id);}
      journal?.leave(logout);
      cancelChartSave();pendingBirthForm=null;discardPendingInput();
      temporaryChartSave=null;chartActions.clear();formIntent=null;librarySelection++;birthForm.close();
      // Replace the private snapshot once, retaining only independent tab sources.
      snapshotReady=checkpoint.clear(store.temporaryChart || store.publicChart?{version:1,
        temporaryChart:store.temporaryChart,publicChart:store.publicChart,
        selectedId:session.selectedId===store.temporaryChart?.id || session.selectedId===store.publicChart?.id
          ? session.selectedId:'current-transit'}:undefined).kind==='stored';
    }else if(resetPersonal && access){
      if(pendingBirthForm && pendingBirthForm.accountId!==null && pendingBirthForm.accountId!==access.accountId)pendingBirthForm=null;
      temporaryChartSave=null;cancelChartSave();chartActions.clear();formIntent=null;librarySelection++;
      const draft=birthForm.snapshot;
      if(birthForm.opened && (!draft || draft.accountId!==null && draft.accountId!==access.accountId))birthForm.close();
    }
    let clearResult:Awaited<ReturnType<typeof accountLibrary.clear>>|null=null;
    const unavailable=()=>actionError('storage_unavailable','Account cleanup is not complete');
    const checkCleanup=(result:{status:string}|null|undefined)=>{if(result && result.status!=='cleared')throw unavailable();};
    const ready=(async()=>{
      await connecting;clearResult=await clearing;
      checkCleanup(await cleanup);
      if(clearResult?.status==='unavailable' || !snapshotReady)throw unavailable();
    })();
    return {ready,
      async retry(){
        await connecting;
        if(clearResult?.status==='unavailable'){
          if(!clearResult.accountId)throw unavailable();
          clearResult={...clearResult,status:await accountLibrary.retryClear(clearResult.accountId)};
          if(clearResult.status==='unavailable')throw unavailable();
        }
        checkCleanup(await calculationClients?.retryPersonalCleanup());
        // A later checkpoint reads current tab state; it never replays an old snapshot.
        if(!snapshotReady)snapshotReady=viewSession!.flush();
        if(!snapshotReady)throw unavailable();
      },
      settled(){
        if(account.getSession())application!.send({type:'ResumeWrite'});
        if(libraryInitialized){application!.send({type:'RecoverWrites'});void accountLibrary.load().catch(()=>{});}
      },
    };
  }
  const libraryReady = (async () => {
    try{await accountLibrary.restore();}catch(error){if((error as {code?:string})?.code!=='account_changed')throw error;}
    await account.ready;
    if(application!.view.lifecycle!=='running')return;
    await application!.requestSession(account.getSession());
    if(application!.view.lifecycle!=='running')return;
    libraryInitialized=true;
    if (!accountLibrary.storageAvailable) toast('Хранилище браузера недоступно. Изменения не будут сохранены.');
  })();

  chartLibrary = attachChartLibrary({ serverDeletion: {handles: id => Boolean(accountLibrary.get(id)), checking: chartActions.isCheckingRemoval, submit:removeAccountChart}, initialSelection: savedView?.librarySelection, panels, view: libraryView, getSelectedId: () => workspace.screen === 'chart' ? session.selectedId : null,
    document, getCharts: () => store.displayCharts,
    removeChart: id => {if(store.clearTemporary(id)){temporaryChartSave=null;viewSession?.flush();}}, getConnectionMode, subscribeConnection, session, onSelect: (id, options) => {void openLibraryChart(id, options);}, onUpdate: updatePage, canEdit: canAccessCharts,
    onEdit: id => {void openLibraryChart(id, undefined, true);}, onNew: () => birthForm.open(),
    beforeOpen: () => { activationPopover.close(); hoverPreview?.clear(); },
  });
  const allCharts = attachAllCharts({ button: $('openAllCharts'), dialog: $('allChartsDialog'),
    list: $('allChartsList'), getCharts: () => store.displayCharts, canEdit: canEditCharts, onRowsChange: () => chartLibrary.refreshAvailability(), initialView: savedView?.charts, onChange: () => viewSession?.schedule(),
    onOpen: () => { navigateWorkspace('charts'); },
  });
  $('openAccount').addEventListener('click', () => { navigateWorkspace('account'); });
  const birthForm = attachBirthForm({
    getAccountId: () => accountLibrary.accountId,
    onDraftChange: () => { pendingBirthForm = null; viewSession?.schedule(); },
    document, getChart: id => id ? store.get(id) : undefined,
    saveChart: chart => { store.setTemporary(chart);temporaryChartSave=null; return true; },
    isCheckingSubmission: () => Boolean(formIntent),
    submitChart: (input, signal) => input.previous && input.previous.id === store.temporaryChart?.id
      ? null : account.getSession() || accountLibrary.accountId ? submitAccountChart(input, signal) : null,
    ...birthClient, getConnectionMode, subscribeConnection, session, toast,
    onSave: (id, { metadataOnly = false } = {}) => {
      if (id !== session.selectedId) selectChart(id, {replace: navigation?.snapshot.route?.kind === 'temporary-chart'});
      else if (metadataOnly) session.refreshRecord();
      else graph.changeChart(id);
      workspace.setScreen('chart');
      publishRoute(routeForChart(id), navigation?.snapshot.route?.kind === 'temporary-chart');
      viewSession?.flush();
    },
    beforeOpen: () => { formIntent = null; returns?.close(); activationPopover.close(); hoverPreview?.clear(); },
  });
  const natalDayClient = calculationClients?.natal ?? createNatalDayClient({ memory: dayClient.memory,library:libraryStorage });
  natalDay = attachNatalDayExplorer({
    dayClient: natalDayClient,
    toggle: $('natalDayToggle'), panel: $('natalDayControls'), range: $('natalDayTime'), marker: $('natalDayReference'),
    status: $('natalDayStatus'), retryButton: $('natalDayRetry'), hourMarks: $('natalDayHourMarks'),
    onMomentInput: () => viewSession?.interrupt(),
    onRender: exploration!.publishDay, onStateChange: () => { updateTimelineTools(); viewSession?.schedule(); },
  });
  returnMarkers = attachReturnMarkers({ container: $('lifetimeTime').parentElement!,
    onTargetsChange: () => lifetimeControls?.refreshTargets(),
    onSelect: event => { viewSession?.interrupt(); return returns!.selectEvent(event.id); } });
  returns = createReturnsController({
    observe: action => journal?.begin(action),
    getOwner(chart) {
      const access = account.getSession(), record = (chart.id ? accountLibrary.get(chart.id) : null);
      return access && record && record.accountId === access.accountId && record.source === 'calculated'
        && record.utc === chart.utc && record.timezone === chart.timezone
        ? {chartId: record.id, expectedAccountId: access.accountId,record} : null;
    },
    client: calculationClients?.cycles ?? createCyclesClient({ memory: dayClient.memory,library:libraryStorage }),
    onRequest: exploration!.requestReturn, onRender: exploration!.publishReturn,
    onStateChange() {
      updateTimelineTools(); viewSession?.schedule();
    },
  });
  $('summaryBreakComparison').addEventListener('click', () => { viewSession?.interrupt(); exploration!.resetMoment(); });
  $('natalDayToggle').addEventListener('click', () => changeTimeline('day', () => exploration!.toggleDay()));
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
  $('chartDialog').addEventListener('close', () => { if (!session.hasCurrent) transit!.refresh(); });
  attachTransitNavigation($('nowButton'), {
    onSelect: selectChart, refresh: transit!.refresh,
  });
  if (!startupGestures) attachCameraControls({ fitButton: $('fitButton') }, gestures);
  attachPerformanceMonitor({
    document, button: $('togglePerformance'), panel: $('performancePanel'), drawing: $('bodygraph'), inputSurface: $('canvasWrap'),
    ranges: [$('transitTime'), $('natalDayTime'), $('lifetimeTime')],
    motionButtons: [$('fitButton'), $('mandalaSwitch'), $('transitReference'), $('natalDayReference')],
  });

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
    const layoutRendered = updateTimelineTools();
    updateChartCaption();updateChartSaveControl();
    chartLibrary!.render(); allCharts?.update(); updateWorkspaceNavigation();
    if (!layoutRendered) renderGraph();
    updateLoading();
    viewSession?.schedule();
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
  workspace.subscribe(applyWorkspace);
  applyWorkspace();

  // Views have subscribed first, so their DOM is ready before measuring.
  panels.subscribe(() => {
    panelResizePending = true;
    refreshStudioLayout({ preserveScale: true });
    viewSession?.schedule();
  });

  returns!.select(session.record);
  natalDay!.select(session.record, session.baseChart);
  updatePage();
  for (const name of ['transitionend', 'transitioncancel'] as const) $('canvasWrap').addEventListener(name, event => {
    if (event.target === $('canvasWrap') && ['left', 'width'].includes(event.propertyName) && panelResizePending) {
      refreshStudioLayout({ preserveScale: true });
    }
  });
  const layoutObserver = createLayoutObserver(() => refreshStudioLayout());
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
  application = createApplication({runtimeId:crypto.randomUUID(),navigation,update:{
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
      application!.send({type:'RecoverWrites'});void accountLibrary.load().catch(()=>{});
    },
    report(){toast('Не удалось восстановить положение страницы.');},
    changed(){
      if(startupRestored())initialPresentation=null;
      updateTimelineTools();updateLoading();restoreInitialInput();notifyOfflineReady();
    },
  },publicRefresh:{
    source:()=>store.publicChart,getSession:account.getSession,read:chartClient.public,
    available:()=>!application?.write.source && startupRestored() && getConnectionMode()==='online'
      && !accountLibrary.get(store.publicChart!.id),
    accept(previous,next){
      store.acceptPublic(next);
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
    actions:chartActions,online:()=>getConnectionMode()!=='offline',getSession:account.getSession,
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
      changed(){updateChartSaveControl();notifyOfflineReady();},checkpoint(){viewSession?.flush();},
      report(kind,error){toast(error===undefined?kind==='unconfirmed'?UI_MESSAGES.chartSaveUnconfirmed
        :kind==='unavailable'?UI_MESSAGES.chartUnavailable:UI_MESSAGES.chartSaveFailed:failureMessage(error,UI_MESSAGES.chartSaveFailed));},
    },
  }, account:{
    subscribeSession(listener){return account.subscribeSession(()=>listener(account.getSession()));},
    subscribeLogout(listener){return account.subscribeNotices(notice=>{if(notice.kind==='logout')listener(notice.ids);});},
    begin:beginAccountBoundary,
    stop(){application?.send({type:'CancelPublicRefresh'});void accountLibrary.connect(null).catch(()=>{});},
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
            let chart;
            try { chart=getConnectionMode()==='offline' && cached ? cached : await chartClient.public(route.id, signal); }
            catch(error) {
              const code=(error as {code?:string})?.code;
              if(!cached || !['offline','connection_failed','server_unavailable'].includes(code??''))throw error;
              chart=cached;
            }
            if (current()) store.acceptPublic(chart);
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
    application.subscribe(updateLoading);
    application.start();
  accountLibrary.subscribe(projectAccountLibrary);
  if (libraryChannel) libraryChannel.onmessage = async event => {
    if (event.data?.kind === 'changed' && libraryInitialized) await accountLibrary.refreshLocal().catch(() => {});
  };
  document.addEventListener('visibilitychange', () => {
    if(!document.hidden)void journal?.wake();
    if (!document.hidden && libraryInitialized) {
      void accountLibrary.refreshLocal().catch(() => {});
      application!.send({type:'RecoverWrites'});
      syncTransitCacheWindow(transit?.state.timeline, true);
      if (getConnectionMode() === 'online') application!.send({type:'RefreshPublicSource'});
    }
  });
  let previousConnection = getConnectionMode();
  subscribeConnection(() => {
    const connection = getConnectionMode(), returned = previousConnection !== 'online' && connection === 'online';
    previousConnection = connection;updateChartSaveControl();
    void natalDay?.refreshAvailability();
    void returns?.refreshAvailability();
    lifetime?.refreshAvailability(); updateTimelineTools();
    if (returned) {syncTransitCacheWindow(transit?.state.timeline, true);void journal?.wake();application!.send({type:'RefreshPublicSource'});}
    if (!libraryInitialized) return;
    if (getConnectionMode() !== 'offline') application!.send({type:'RetryAccountBoundary'});
    application!.send({type:'RecoverWrites'}); void accountLibrary.load().catch(() => {});
  });
  const restoration = application.whenRestored();
  studio.dataset.panelsReady = 'true';

  function loadReturnsView(): Promise<ReturnsPanel | null> {
    if (returnsView) return Promise.resolve(returnsView);
    if (returnsViewLoading) return returnsViewLoading;
    returnsViewLoading = import('./views/returns-panel.ts').then(({ attachReturnsPanel }) => {
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
      if (initialPage.active) { initialPage.contentFailed = true; }
      if (returns!.opened) { returns!.close(); toast('Не удалось открыть возвраты. Попробуйте ещё раз.'); }
      return null;
    }).finally(() => { returnsViewLoading = null; updateInitialPage(); });
    return returnsViewLoading;
  }

  function updateTimelineTools() {
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
      nowAvailable: getConnectionMode() !== 'offline' || transit?.state.referenceIndex != null };
    chartSummary!.setReturnsVisible(view.returnsVisible);
    if (returnsView) returnsView!.update(viewState);
    else if (view.returnsVisible) void loadReturnsView();
    const lifetimeToggle = $('lifetimeToggle');
    lifetimeToggle.hidden = !view.lifetimeAvailable;
    (lifetimeToggle as HTMLButtonElement).disabled = !view.toggleEnabled && (getConnectionMode() === 'offline'
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
    if (lifetime) return lifetime;
    if (lifetimeLoading) return lifetimeLoading;
    if (lifetimeLoadFailed) return null;
    $('lifetimeToggle').setAttribute('aria-busy', 'true');
    lifetimeLoading = (async () => {
      try {
        const [{ createLifetimeExplorer }, { attachLifetimeControls }] = await Promise.all([
          import('./state/lifetime.ts'), import('./views/lifetime-controls.ts'),
        ]);
        const getDayState = () => session.selectedId === 'current-transit' ? transit!.state : null;
        const getPersonalRecord = () => returns!.available ? returns!.natal : null;
        let controls: LifetimeControls | undefined;
        const controller = createLifetimeExplorer({
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
        lifetime = controller;
        lifetimeControls = controls;
        return lifetime;
      } catch {
        lifetimeLoadFailed = true; updateLoading(); updateTimelineTools();
        return null;
      } finally {
        lifetimeLoading = null;
        $('lifetimeToggle').removeAttribute('aria-busy');
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
  });
  for (const field of [$('lifetimeFromDate'), $('lifetimeToDate')]) {
    field.addEventListener('input', () => { viewSession?.interrupt(); exploration!.invalidateTimeline(); }, true);
  }
  initialPage.attached = true;
  updateInitialPage();
  commitLoadingLayout(document);
  const offlineRestored = () => application!.isRestored();
  return { saveShownChart,cancelChartSave,restoration,offlineRestored,
    subscribeOfflineReady(listener:()=>void){offlineListeners.add(listener);return()=>{offlineListeners.delete(listener);};},
    prepareOfflineUpdate:()=>application!.prepareUpdate(),
    // P17 extends the shared lifetime to the remaining owners; this stops all P02 resources.
    stopApplication: () => application?.stop() ?? Promise.resolve(),
    flushView: () => viewSession!.flush(),
    attachJournal(value:AppJournal){
      if(journal===value)return;
      const current=syncJournalAccount();journal=value;
      if(lastJournalAccount!==null)journal.setAccount(lastJournalAccount,lastJournalSession,lastJournalProof);
      if(journalBoundaryPending)journal.leave([...journalBoundaryIds]);
      if(lastJournalAccount===null || current!==lastJournalAccount || journalBoundaryPending)journal.setAccount(current,account.getSession()?.sessionId,account.getSession()?.diagnosticProof);
      journalBoundaryPending=false;journalBoundaryIds.clear();
    } };
}
