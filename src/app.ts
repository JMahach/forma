import { createLayoutObserver } from './ui/layout/resize-observer.ts';
import type { createJournal } from './journal.ts';
import type { StoragePressure } from './data/storage-pressure.ts';
import type { createCalculationUpdates } from './data/calculation-updates.ts';
import { createLocalDayTimeline } from './domain/day-timeline.ts';
import type { CalculationClients } from './data/calculation-clients.ts';
import type { AppRoute } from '../shared/app-routes.ts';
import { appRoutePath } from '../shared/app-routes.ts';
import { attachChartLink } from './views/chart-link.ts';
import type { Navigation, NavigationSnapshot } from './state/navigation.ts';
import type { AccountChart, ChartWriteIntent } from '../shared/chart-record-contract.ts';
import type { SavedChart } from '../shared/chart-types.ts';
import type { BirthSubmission } from './views/birth-form.ts';
import type { ChartActionResult, ChartSaveAction } from './state/chart-actions.ts';
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
  calculationUpdates?: Pick<ReturnType<typeof createCalculationUpdates>, 'refresh' | 'onTimelineChanged'>;
  calculationClients?: Pick<CalculationClients, 'natal' | 'cycles' | 'resetPersonal' | 'retryPersonalCleanup'> & Partial<Pick<CalculationClients,'evictForSpace'>>;
  account: Pick<AccountWorkspace, 'ready' | 'snapshot' | 'restoreInputFocus' | 'setVisible' | 'getSession' | 'subscribeSession' | 'subscribeNotices' | 'canRestoreLibrary'>;
  dayClient: TransitDayClient; layout: StudioLayout; toast: Toast; viewStore: ViewStore;
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
import { eligibleCycleChart, lifeTimelineForChart, cycleTimeZone } from './domain/cycles.ts';
import { attachReturnMarkers } from './views/returns-markers.ts';
import { returnsVisibleWindow } from './domain/returns-window.ts';
import { studioPresentation } from './ui/studio-presentation.ts';

// Composition root: each feature owns its state; these callbacks connect them.
export function startApp({ journal, storagePressure, navigation, calculationClients, calculationUpdates, account, dayClient, layout, toast, viewStore, savedView, panels, workspace, store, libraryView, camera, cameraView, gestures: startupGestures = null, initialPresentation = null, releaseLoadingContent = null }: AppOptions) {
  let pendingBirthForm = savedView?.birthForm ?? null;
  // An operation is linked to this accepted tab source, never inferred from its content.
  let temporaryChartSave = savedView?.temporaryChartSave?.sourceId === store.temporaryChart?.id
    ? savedView?.temporaryChartSave ?? null : null;
  let publicRefreshRequest:AbortController|null=null;
  let calculationObsolete = false, returnsObsolete = false;
  let restorationException = false;
  const offlineListeners=new Set<()=>void>();
  const notifyOfflineReady=()=>{for(const listener of offlineListeners)listener();};
  let chartSave:{action:ChartSaveAction;source:SavedChart;work:Promise<void>|null}|null=null;
  function cancelChartSave(){chartSave?.action.cancel();chartSave=null;updateChartSaveControl();}
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
  const initialPage = { active: true, attached: false, restored: false, restoreFailed: false,
    screenPending: false, screenFailed: false, screenRevision: 0 };
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
  let library: ReturnType<typeof attachChartLibrary> | null = null;
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
      initialPage.restoreFailed = false;
      if (routeFailed && navigation?.snapshot.route?.kind === 'chart') {void applyRoute(navigation.snapshot);return;}
      if (lifetimeOwnsLoading()) {
        if (lifetimeLoadFailed) window.location.reload();
        else void lifetime?.retry();
      } else void transit?.retry();
    },
  });
  let routePending = false, routeFailed = false;
  const updateLoading = () => {
    const lifetimeLoading = lifetimeOwnsLoading(), state = lifetimeLoading ? lifetime?.state : transit?.state;
    const firstFailed = initialPage.restored && initialPage.restoreFailed && !session.hasCurrent;
    chartLoading.update({ hasChart: !routePending && !routeFailed && session.hasCurrent, holdLoading: initialPage.active,
      preserveHeading: calculationObsolete,
      failed: routeFailed || firstFailed || (lifetimeLoading ? lifetimeLoadFailed || state?.status === 'error' : transit?.state.unavailable),
      loading: routePending || !firstFailed && (lifetimeLoading ? !lifetimeLoadFailed && (!state || state.status === 'loading') : transit?.state.loading) });
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
      const alreadyShown = workspace.screen === 'library';
      navigateWorkspace('library');
      if (alreadyShown) void knowledge.show();
    },
    isCurrent: () => workspace.screen === 'library',
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
  let publishingRoute = false, routeRequest: AbortController | null = null;
  function routeForChart(id: string): AppRoute {
    return id === 'current-transit' ? {kind:'transit'}
      : accountLibrary.get(id) || store.get(id) && 'revision' in store.get(id)!
        ? {kind:'chart',id} : {kind:'temporary-chart'};
  }
  function publishRoute(route: AppRoute, replace = false) {
    if (!navigation) return;
    publicRefreshRequest?.abort();
    routeRequest?.abort(); routePending = routeFailed = false;
    viewSession?.interrupt();
    initialPage.restored = true; initialPresentation = null;
    publishingRoute = true;
    try { navigation.navigate(route, {replace}); } finally { publishingRoute = false; }
    updateLoading();
  }
  function navigateWorkspace(screen: WorkspaceScreen, { keepMenuOpen = false, fromRoute = false } = {}) {
    if(chartSave && !(screen==='account' && chartSave.action.waitingForLogin))cancelChartSave();
    if (layout.phone && !keepMenuOpen) library?.close();
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
  const libraryStorage = createAccountLibraryStore({pressure: storagePressure});
  storagePressure?.setSources({
    diagnostics: guard => journal?.discardForSpace?.(guard) ?? Promise.resolve('unavailable'),
    natalDays: (keep, exclude, guard) => calculationClients?.evictForSpace?.('natal', keep, exclude, guard) ?? Promise.resolve('unavailable'),
    returnCharts: (keep, exclude, guard) => calculationClients?.evictForSpace?.('return-charts', keep, exclude, guard) ?? Promise.resolve('unavailable'),
    charts: (keep, ids, guard) => libraryStorage.evictForSpace(keep, ids, guard),
  });
  const accountLibrary = createAccountLibrary({client: chartClient, storage: libraryStorage,
    calculationVersion: document.body.dataset.calculationVersion ?? '', online: () => getConnectionMode() !== 'offline',
    restoreAllowed: account.canRestoreLibrary, notify: notifyLibrary});
  const chartLink = attachChartLink({button: $<HTMLButtonElement>('copyChartLink'), root: shell, boundary: $('chartSummary')});
  let formIntent: ChartWriteIntent | null = null, privateLibraryShown = false, librarySelection = 0;
  const chartActions = createChartActions({client: chartClient, library: accountLibrary,
    getSession: account.getSession, calculate: birthClient.calculate, initialPending: savedView?.pendingChartWrites,
    onPending: pending => {
      if (viewSession) viewSession.flush();
      else viewStore.write({...savedView, version: 1, temporaryChartSave, pendingChartWrites: pending});
    }});
  function continueChartSave(intent:NonNullable<typeof chartSave>):Promise<void> {
    if(intent.work)return intent.work;
    intent.work=(async()=>{
      try {
        await libraryReady;
        if(chartSave!==intent)return;
        if(account.getSession())await connectLibrary();
        if(chartSave!==intent)return;
        const result=await intent.action.run();
        if(chartSave!==intent)return;
        if(result.kind==='sign-in'){navigateWorkspace('account');return;}
        if(result.kind==='inactive')return;
        if(result.kind==='unknown'){toast(UI_MESSAGES.chartSaveUnconfirmed);return;}
        if(result.kind!=='settled' || !result.active)return;
        if(result.receipt.outcome.kind==='rejected') {
          if(temporaryChartSave?.sourceId===intent.source.id)temporaryChartSave=null;
          if(result.receipt.outcome.code==='source_changed') {
            const fresh=await chartClient.public(intent.source.id);
            if(chartSave!==intent)return;
            store.acceptPublic(fresh);
            selectChart(fresh.id,{replace:true});
          } else if(result.receipt.outcome.code==='not_found')selectChart('current-transit',{replace:true});
          else toast(UI_MESSAGES.chartSaveFailed);
          cancelChartSave();viewSession?.flush();return;
        }
        if(!result.chart){toast(UI_MESSAGES.chartUnavailable);return;}
        const id=result.chart.id,temporary=!('revision' in intent.source);
        // Adopting the saved identity redraws the list; retire its temporary row first.
        if(temporary){
          temporaryChartSave=null;
          store.clearTemporary(intent.source.id);
          store.showPublic(null);
        }
        if(session.adopt(id,intent.source.id)) {
          workspace.setScreen('chart');publishRoute({kind:'chart',id},true);
        } else selectChart(id,{replace:true});
        cancelChartSave();viewSession?.flush();
      }catch(error){if(chartSave===intent)toast(failureMessage(error,UI_MESSAGES.chartSaveFailed));}
      finally{intent.work=null;updateChartSaveControl();notifyOfflineReady();}
    })();updateChartSaveControl();return intent.work;
  }
  function saveShownChart():Promise<void> {
    if(getConnectionMode()==='offline'){toast(UI_MESSAGES.offline);return Promise.resolve();}
    const source=session.record;
    if(!source || accountLibrary.get(source.id))return Promise.resolve();
    const publicSource=source as SavedChart & {revision?:number};
    const action=chartActions.prepareSave(typeof publicSource.revision==='number'
      ?{kind:'shared',chart:{...publicSource,revision:publicSource.revision}}
      :{kind:'temporary',chart:source},()=>session.selectedId===source.id && session.record===source, {
        intent: store.temporaryChart===source && temporaryChartSave?.sourceId===source.id ? temporaryChartSave : undefined,
        onIntent: intent => {
          if(store.temporaryChart!==source)return;
          temporaryChartSave=intent?{...intent,sourceId:source.id}:null;
          if(!intent)viewSession?.flush();
        },
      });
    if(chartSave?.action!==action)chartSave={action,source,work:null};
    return continueChartSave(chartSave);
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
      available:visible && (!calculationObsolete || source?.source === 'manual'),pending:Boolean(chartSave?.work && !chartSave.action.waitingForLogin)});
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
    const preserveSaveSource = Boolean(chartSave && session.record === chartSave.source);
    if(preserveSaveSource)store.showPublic(chartSave!.source);
    const previous = session.record, editedId = birthForm.editedId;
    store.projectLibrary(accountLibrary.charts, accountLibrary.storageAvailable,
      accountLibrary.charts.filter(chart => chart.calculationVersion === accountLibrary.calculationVersion).map(chart => chart.id));
    birthForm.refresh();
    if (initialPage.restored && !preserveSaveSource && editedId && !store.get(editedId)) {
      librarySelection++; selectChart('current-transit', {replace:true});
      return;
    } else if (initialPage.restored && !preserveSaveSource && session.selectedId !== 'current-transit') {
      const next = store.get(session.selectedId);
      if (!next || !store.has(next.id)) { librarySelection++; selectChart('current-transit', {replace:true}); }
      else if (previous?.utc !== next.utc || JSON.stringify(previous?.activations) !== JSON.stringify(next.activations)) graph.changeChart(next.id);
      else session.refreshRecord();
      // The accepted session already updates every page projection.
      return;
    }
    if (initialPage.restored) updatePage();
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
  let connectionKey: string | null = null, lastSessionId: string | null = null, connecting = Promise.resolve(), libraryInitialized = false;
  function connectLibrary() {
    const access = account.getSession(), key = access ? access.accountId + ':' + access.sessionId : '';
    if (connectionKey === key) return connecting;
    const previousAccount = accountLibrary.accountId;
    if (connectionKey !== null) library?.closeDelete();
    connectionKey = key;
    if (access) lastSessionId = access.sessionId;
    if (access && (previousAccount && previousAccount !== access.accountId
      || chartActions.pending.some(intent => intent.expectedAccountId !== access.accountId)
      || temporaryChartSave && temporaryChartSave.expectedAccountId!==access.accountId)) {
      void calculationClients?.resetPersonal().catch(() => {});
      if(pendingBirthForm && pendingBirthForm.accountId!==null && pendingBirthForm.accountId!==access.accountId)pendingBirthForm=null;
      temporaryChartSave=null;cancelChartSave(); chartActions.clear(); formIntent = null; librarySelection++;
      const draft=birthForm.snapshot;
      if(birthForm.opened && (!draft || draft.accountId!==null && draft.accountId!==access.accountId))birthForm.close();
    }
    connecting = accountLibrary.connect(access);
    return connecting;
  }
  async function recoverWrites() {
    if (getConnectionMode() === 'offline') return;
    const access = account.getSession(); if (!access) return;
    const pending=[...chartActions.pending], binding=temporaryChartSave, source=store.temporaryChart;
    // A confirmed write may still await its readable chart after the generic pointer settled.
    if(binding && !pending.some(intent=>intent.operationId===binding.operationId && intent.expectedAccountId===binding.expectedAccountId))pending.push({operationId:binding.operationId,expectedAccountId:binding.expectedAccountId});
    for (const intent of pending) {
      if (intent.expectedAccountId !== access.accountId) continue;
      try {
        const result=await chartActions.recover(intent);
        if(result.kind==='settled' && result.active && (result.receipt.outcome.kind==='deleted' || result.receipt.outcome.kind==='absent')) {
          const id=result.receipt.outcome.chartId;
          if(store.clearPublic(id)) {
            if(session.selectedId===id && !accountLibrary.get(id)) {
              if(workspace.screen==='chart')selectChart('current-transit',{replace:true});else graph.changeChart('current-transit');
            }
            viewSession?.flush();
          }
        }
        if(!binding || temporaryChartSave!==binding || binding.operationId!==intent.operationId
          || binding.expectedAccountId!==intent.expectedAccountId || store.temporaryChart!==source
          || result.kind!=='settled' || !result.active)continue;
        if(result.receipt.outcome.kind==='rejected' || result.receipt.outcome.kind==='deleted' || result.receipt.outcome.kind==='absent') {
          temporaryChartSave=null;viewSession?.flush();
        } else if(result.chart && source) {
          const selected=session.record===source;
          if(selected && !session.adopt(result.chart.id,source.id))graph.changeChart(result.chart.id);
          store.clearTemporary(source.id);temporaryChartSave=null;
          if(chartSave?.source===source){store.showPublic(null);cancelChartSave();}
          // Reconcile identity in place; a newer screen keeps its route and focus.
          if(selected && workspace.screen==='chart')publishRoute({kind:'chart',id:result.chart.id},true);
          updatePage();viewSession?.flush();
        }
      } catch { /* Keep unknown pointers; a later explicit/reconnect lookup can resolve them. */ }
    }
  }
  const libraryReady = (async () => {
    await accountLibrary.restore(); await account.ready; await connectLibrary(); libraryInitialized = true;
    if (!accountLibrary.storageAvailable) toast('Хранилище браузера недоступно. Изменения не будут сохранены.');
  })();

  library = attachChartLibrary({ serverDeletion: {handles: id => Boolean(accountLibrary.get(id)), checking: chartActions.isCheckingRemoval, submit:removeAccountChart}, initialSelection: savedView?.librarySelection, panels, view: libraryView, getSelectedId: () => workspace.screen === 'chart' ? session.selectedId : null,
    document, getCharts: () => store.displayCharts,
    removeChart: id => {if(store.clearTemporary(id)){temporaryChartSave=null;viewSession?.flush();}}, getConnectionMode, subscribeConnection, session, onSelect: (id, options) => {void openLibraryChart(id, options);}, onUpdate: updatePage, canEdit: canAccessCharts,
    onEdit: id => {void openLibraryChart(id, undefined, true);}, onNew: () => birthForm.open(),
    beforeOpen: () => { activationPopover.close(); hoverPreview?.clear(); },
  });
  const allCharts = attachAllCharts({ button: $('openAllCharts'), dialog: $('allChartsDialog'),
    list: $('allChartsList'), getCharts: () => store.displayCharts, canEdit: canEditCharts, onRowsChange: () => library.refreshAvailability(), initialView: savedView?.charts, onChange: () => viewSession?.schedule(),
    onOpen: () => { navigateWorkspace('charts'); },
  });
  $('openAccount').addEventListener('click', () => { navigateWorkspace('account'); });
  const birthForm = attachBirthForm({
    canCalculate: () => !calculationObsolete,
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
  const natalDayClient = calculationClients?.natal ?? createNatalDayClient({ memory: dayClient.memory, calculationVersion: document.body.dataset.calculationVersion });
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
        ? {chartId: record.id, expectedAccountId: access.accountId} : null;
    },
    client: calculationClients?.cycles ?? createCyclesClient({ memory: dayClient.memory, cacheVersion: document.body.dataset.cyclesVersion }),
    onRequest: exploration!.requestReturn, onRender: exploration!.publishReturn,
    onStateChange() {
      updateTimelineTools(); viewSession?.schedule();
    },
  });
  $('summaryBreakComparison').addEventListener('click', () => { viewSession?.interrupt(); exploration!.resetMoment(); });
  $('natalDayToggle').addEventListener('click', () => changeTimeline('day', () => exploration!.toggleDay()));
  let cacheTimeline: ReturnType<typeof createLocalDayTimeline> | null = null;
  transit = attachLiveTransit({
    document, button: $('nowButton'), dayClient, isFormOpen: () => birthForm.opened,
    isChartVisible: () => workspace.screen === 'chart',
    onRender: exploration!.publishTransit, onStateChange: state => {
      // Persistent transit covers today's local day, even while exploring a past date.
      if (calculationUpdates && state.timeline && (!cacheTimeline || Date.now() >= cacheTimeline.endUtc
          || cacheTimeline.timeZone !== state.timeline.timeZone)) {
        cacheTimeline = createLocalDayTimeline(Date.now(), state.timeline.timeZone);
        void calculationUpdates.onTimelineChanged(cacheTimeline);
      }
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
    if (initialPage.active && !initialPage.restored && initialPresentation) return initialPresentation;
    const timeline = exploration!.pendingTimeline || lifetime?.state;
    return studioPresentation({ isTransit: session.selectedId === 'current-transit',
      personalAvailable: Boolean(returns?.available), dayOpened: Boolean(natalDay?.state.opened),
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
    library!.render(); allCharts?.update(); updateWorkspaceNavigation();
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
      knowledgeReady = screen === 'library' ? knowledge.show() : (knowledge.hide(), null);
      $('accountPage').hidden = screen !== 'account';
      account.setVisible(screen === 'account');
      chartSummary!.layout(); library!.render(); updateWorkspaceNavigation();
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
      initialPage.screenPending = screen === 'library' || screen === 'charts' || screen === 'account';
      const ready = screen === 'library' ? knowledgeReady : screen === 'charts'
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
  function inputSnapshot<T extends {focus?: unknown} | null | undefined>(current: T, previous: T, screen: 'account' | 'charts' | 'library'): T {
    return pendingInputRestore && workspace.screen === screen && current && previous?.focus
      ? {...current, focus:previous.focus} : current;
  }
  function restoreInitialInput() {
    if ((!pendingInputRestore && !pendingLifetimeDraft) || initialPage.active || !initialPage.restored) return;
    if (viewSession?.interrupted) {discardPendingInput();return;}
    if (workspace.screen === 'chart' && pendingLifetimeDraft) {
      if (!lifetimeControls?.restoreDraft(pendingLifetimeDraft,{restoreFocus:pendingInputRestore})) return;
    } else if (pendingInputRestore && workspace.screen === 'account' && savedView?.account?.focus) account.restoreInputFocus(savedView.account.focus);
    else if (pendingInputRestore && workspace.screen === 'charts' && savedView?.charts?.focus) allCharts.restoreInputFocus();
    else if (pendingInputRestore && workspace.screen === 'library' && savedView?.knowledge?.focus) knowledge.restoreInputFocus();
    pendingInputRestore = false; pendingLifetimeDraft = null;
    viewSession?.schedule();
  }
  function updateInitialPage() {
    if (!initialPage.active || !initialPage.attached || !fontsSettled || initialPage.screenPending) return;
    let failed = initialPage.screenFailed;
    if (workspace.screen === 'chart') {
      if (!initialPage.restored) return;
      const view = presentation(), cycles = returns!.state, day = natalDay!.state, life = lifetime?.state;
      const cyclesVisible = view.returnsVisible || view.personalTimelineVisible;
      failed ||= initialPage.restoreFailed || lifetimeLoadFailed || day.opened && day.status === 'error'
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
  const savedChart = store.get(savedView?.selectedId!);
  const savedLife = eligibleCycleChart(savedChart) && savedView?.lifetime?.opened ? lifeTimelineForChart(savedChart) : null;
  const restoreView = savedLife ? { ...savedView, lifetime: { ...savedView!.lifetime!, ...savedLife,
    minimumUtc: savedChart!.utc!, mode: 'lifetime' as const, openEnded: false } } : savedView;
  viewSession = createViewSession({
    store: { read: () => restoreView, write: viewStore.write }, chartStore: store, session,
    mandala: { get enabled() { return mandalaMode.enabled; },
      restore: enabled => mandalaMode.setEnabled(enabled, { animate: false }) }, camera: gestures, cameraRestored: true, panels, workspace, transit, natalDay: natalDay, planetFilter: transitPlanets,
    getBirthForm: () => pendingBirthForm ?? birthForm.snapshot,
    getLifetimeDraft: () => pendingLifetimeDraft ?? lifetimeControls?.snapshot ?? null, onPersisted:notifyOfflineReady,
    getTemporaryChartSave: () => temporaryChartSave,
    getPendingChartWrites: () => [...chartActions.pending], getAccountView: () => inputSnapshot(account.snapshot,savedView?.account,'account'),
    getKnowledgeView: () => inputSnapshot(knowledge.snapshot,savedView?.knowledge,'library'),
    getChartsView: () => inputSnapshot(allCharts.snapshot,savedView?.charts,'charts'), getLibrarySelection: () => library?.selection,
    getPersonalPreview: () => returns!.available ? exploration!.preview : undefined,
    getPersonalLive: () => returns!.available ? exploration!.live : undefined,
    restorePersonalPreview: exploration!.restorePreview,
    restorePersonalLive: exploration!.restoreLive,
    acceptLifetimeMode: exploration!.acceptLifetimeMode,
    getReturns: () => returns, getLifetime: () => lifetime, getLifetimeIntent: () => exploration!.pendingTimeline, loadLifetime,
    openReturnsTimeline: exploration!.openTimeline, canRestoreLifetime: () => (session.selectedId === 'current-transit' || returns!.available),
  });
  async function refreshPublicChart() {
    const previous=store.publicChart;
    if(!previous || chartSave || !initialPage.restored || getConnectionMode()!=='online'
      || accountLibrary.get(previous.id) || publicRefreshRequest && !publicRefreshRequest.signal.aborted)return;
    const controller=publicRefreshRequest=new AbortController();
    const access=account.getSession(),accountKey=access?access.accountId+':'+access.sessionId:'';
    const current=()=>{
      const access=account.getSession();
      return publicRefreshRequest===controller && !controller.signal.aborted && store.publicChart===previous
        && accountKey===(access?access.accountId+':'+access.sessionId:'');
    };
    try {
      const next=await chartClient.public(previous.id,controller.signal);
      if(!current())return;
      store.acceptPublic(next);
      if(session.selectedId===next.id && !accountLibrary.get(next.id)) {
        if(previous.utc!==next.utc || JSON.stringify(previous.activations)!==JSON.stringify(next.activations))graph.changeChart(next.id);
        else session.refreshRecord();
      }
      updatePage();viewSession?.flush();
    } catch(error) {
      if(!current() || (error as {code?:string})?.code!=='not_found')return;
      store.clearPublic(previous.id);
      if(session.selectedId===previous.id && !accountLibrary.get(previous.id)) {
        if(workspace.screen==='chart')selectChart('current-transit',{replace:true});else graph.changeChart('current-transit');
      }
      updatePage();viewSession?.flush();
    } finally {if(publicRefreshRequest===controller)publicRefreshRequest=null;}
  }
  async function applyRoute(snapshot: NavigationSnapshot, initial = false) {
    if (!navigation || !snapshot.route) return;
    const observation=snapshot.route.kind==='chart'?journal?.begin({action:'chart_open',component:'chart'}):undefined;
    publicRefreshRequest?.abort();
    routeRequest?.abort();
    const controller = routeRequest = new AbortController(), route = snapshot.route;
    if (!initial) {cancelChartSave();viewSession?.interrupt();}
    librarySelection++;
    routePending = route.kind === 'chart'; routeFailed = false;
    navigateWorkspace(route.kind === 'chart' || route.kind === 'temporary-chart' || route.kind === 'transit' ? 'chart' : route.kind, {fromRoute:true});
    updateLoading();
    try {
      if (route.kind === 'chart') {
        await libraryReady;
        if (!navigation.isCurrent(snapshot) || controller.signal.aborted) return;
        if (accountLibrary.get(route.id)) await accountLibrary.open(route.id);
        else {
          const cached=store.publicChart?.id===route.id && store.publicChart.calculationVersion===accountLibrary.calculationVersion
            ? store.publicChart : null;
          let chart;
          try { chart=getConnectionMode()==='offline' && cached ? cached : await chartClient.public(route.id, controller.signal); }
          catch(error) {
            const code=(error as {code?:string})?.code;
            if(!cached || !['offline','connection_failed','server_unavailable'].includes(code??''))throw error;
            chart=cached;
          }
          if (!navigation.isCurrent(snapshot) || controller.signal.aborted) return;
          store.acceptPublic(chart);
        }
        if (!navigation.isCurrent(snapshot) || controller.signal.aborted) return;
        if (!initial) selectChart(route.id, {fromRoute:true});
      } else if (!initial && route.kind === 'transit') selectChart('current-transit', {fromRoute:true});
      else if (!initial && route.kind === 'temporary-chart') selectChart(store.temporaryChart?.id ?? 'current-transit', {fromRoute:true});
    } catch (error) {
      if (!navigation.isCurrent(snapshot) || controller.signal.aborted) return;
      void observation?.reportError(error,{stage:'request'});
      if(route.kind==='chart' && (error as {code?:string})?.code==='not_found') {
        store.clearPublic(route.id);selectChart('current-transit',{replace:true});viewSession?.flush();
        if(initial) {
          const redirected=navigation.snapshot,ready=await transit!.start(null,{firstChart:true});
          if(navigation.isCurrent(redirected)){initialPage.restoreFailed=ready===false;updateLoading();}
        }
      } else routeFailed = true;
      toast(failureMessage(error, UI_MESSAGES.chartUnavailable));
    } finally {
      observation?.finishSuccess();
      if (navigation.isCurrent(snapshot) && !controller.signal.aborted) {
        routePending = false;
        if (!initial) { initialPage.restored = true; initialPresentation = null; }
        updateLoading();
      }
    }
  }
  navigation?.subscribe(snapshot => { if (!publishingRoute) void applyRoute(snapshot); });
  accountLibrary.subscribe(projectAccountLibrary);
  if (libraryChannel) libraryChannel.onmessage = async event => {
    if (event.data?.kind === 'changed' && libraryInitialized) await accountLibrary.refreshLocal().catch(() => {});
  };
  document.addEventListener('visibilitychange', () => {
    if(!document.hidden)void journal?.wake();
    if (!document.hidden && libraryInitialized) {
      void accountLibrary.refreshLocal().catch(() => {});
      void recoverWrites();
      if (getConnectionMode() === 'online') {void calculationUpdates?.refresh();void refreshPublicChart();}
    }
  });
  const publicAccessKey = () => {
    const access = account.getSession();
    return JSON.stringify([access?.accountId, access?.sessionId, access?.diagnosticProof]);
  };
  let lastPublicAccessKey = publicAccessKey();
  account.subscribeSession(() => {
    const nextPublicAccessKey = publicAccessKey();
    if (nextPublicAccessKey !== lastPublicAccessKey) {
      lastPublicAccessKey = nextPublicAccessKey;
      publicRefreshRequest?.abort();
    }
    syncJournalAccount();
    if(account.getSession() && chartSave?.action.waitingForLogin)void continueChartSave(chartSave);
    if (!libraryInitialized) return;
    const access = account.getSession(), key = access ? access.accountId + ':' + access.sessionId : '';
    if (connectionKey === key) return;
    void connectLibrary().then(() => {void recoverWrites(); void accountLibrary.load().catch(() => {});}).catch(() => {});
  });
  account.subscribeNotices(notice => {
    if (notice.kind !== 'logout') return;
    const ownSessionId = account.getSession()?.sessionId ?? lastSessionId;
    if (ownSessionId && !notice.ids.includes(ownSessionId)) return;
    lastSessionId = null;publicRefreshRequest?.abort();
    if(!journal){journalBoundaryPending=true;for(const id of notice.ids)journalBoundaryIds.add(id);}
    cancelChartSave();
    journal?.leave(notice.ids);
    library?.closeDelete();
    void calculationClients?.resetPersonal().catch(() => {});
    pendingBirthForm = null; discardPendingInput();
    temporaryChartSave=null;chartActions.clear(); formIntent = null; librarySelection++;
    birthForm.close();
    void accountLibrary.clear().catch(() => {});
    viewStore.clear();
    // The independent tab card survives logout; never restore the old account snapshot.
    if(store.temporaryChart || store.publicChart)viewStore.write({version:1,temporaryChart:store.temporaryChart,publicChart:store.publicChart,
      selectedId:session.selectedId===store.temporaryChart?.id || session.selectedId===store.publicChart?.id ? session.selectedId : 'current-transit'});
  });
  let previousConnection = getConnectionMode();
  subscribeConnection(() => {
    const connection = getConnectionMode(), returned = previousConnection !== 'online' && connection === 'online';
    previousConnection = connection;updateChartSaveControl();
    void natalDay?.refreshAvailability();
    void returns?.refreshAvailability();
    lifetime?.refreshAvailability(); updateTimelineTools();
    if (returned) {void calculationUpdates?.refresh();void journal?.wake();void refreshPublicChart();}
    if (!libraryInitialized) return;
    if (getConnectionMode() !== 'offline') void calculationClients?.retryPersonalCleanup().catch(() => {});
    void recoverWrites(); void accountLibrary.load().catch(() => {});
  });
  const restoration = (async () => {
    const initialRoute = navigation?.snapshot;
    const routeCurrent = () => !initialRoute || navigation!.isCurrent(initialRoute);
    try {
      await libraryReady;
      if (!routeCurrent()) return;
      projectAccountLibrary();
      if (initialRoute) await applyRoute(initialRoute, true);
      if (!routeCurrent()) return;
      if (initialRoute?.route?.kind !== 'chart' && accountLibrary.get(savedView?.selectedId ?? '')) {
        try {await accountLibrary.open(savedView!.selectedId!);} catch { /* Only compatible downloaded charts may be restored. */ }
      }
      if (!routeCurrent()) return;
      const restored = await viewSession!.restore();
      if (!viewSession!.interrupted) initialPage.restoreFailed = restored === false;
    }
    catch { restorationException = true; initialPage.restoreFailed = true; toast('Не удалось восстановить положение страницы.'); }
    if (viewSession!.interrupted || !routeCurrent()) return;
    try {
      const resumed = await exploration!.finishRestore({ saved: restoreView, interrupted: viewSession!.interrupted,
        pendingLifetime: viewSession!.pendingLifetime, pendingReturns: viewSession!.pendingReturns });
      initialPage.restoreFailed ||= resumed === false;
    } catch { restorationException = true; initialPage.restoreFailed = true; toast('Не удалось восстановить положение страницы.'); }
    if (viewSession!.interrupted || !routeCurrent()) return;
    const draft = pendingBirthForm; pendingBirthForm = null;
    if(draft && !birthForm.opened)birthForm.restore(draft);
    viewSession!.flush();
    initialPage.restored = true; initialPresentation = null; updateTimelineTools(); updateLoading();
    restoreInitialInput();
    void recoverWrites(); void accountLibrary.load().catch(() => {});
  })();
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
      if (initialPage.active) { restorationException = true; initialPage.restoreFailed = true; }
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
      nowAvailable: !calculationObsolete && (getConnectionMode() !== 'offline' || transit?.state.referenceIndex != null) };
    chartSummary!.setReturnsVisible(view.returnsVisible);
    if (returnsView) returnsView!.update(viewState);
    else if (view.returnsVisible) void loadReturnsView();
    const lifetimeToggle = $('lifetimeToggle');
    lifetimeToggle.hidden = !view.lifetimeAvailable;
    (lifetimeToggle as HTMLButtonElement).disabled = !view.toggleEnabled && (calculationObsolete || getConnectionMode() === 'offline'
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
        if (calculationObsolete) lifetime.invalidateCalculations();
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
    if (loading) { initialPage.restored = false; initialPage.restoreFailed = false; }
    initialPresentation = null;
    viewSession?.interrupt();
    let result;
    try {
      const closePending = kind === 'day' ? pending?.timelinePanel === 'natal-day' : pending?.toggleEnabled;
      result = closePending ? exploration!.closeScales() : command();
    }
    finally {
      if (loading) initialPage.restored = true;
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
  // An obsolete calculation may deliberately remain pending in the durable view
  // snapshot. Waiting for it to calculate with old code would deadlock the update.
  // Exceptions, missing records/screens and unconfirmed writes still block it.
  const offlineRestored = () => initialPage.restored
    && (!initialPage.restoreFailed || (calculationObsolete || returnsObsolete) && !restorationException)
    && !initialPage.screenPending && !initialPage.screenFailed && !routePending && !routeFailed;
  return { saveShownChart,cancelChartSave,restoration,offlineRestored,
    invalidateCalculations({ calculation = true, returns: obsoleteReturns = true }: {calculation?:boolean;returns?:boolean} = {}) {
      calculationObsolete ||= calculation; returnsObsolete ||= obsoleteReturns || calculation;
      session.invalidateCalculations({calculation:calculationObsolete,returns:returnsObsolete});
      if (calculationObsolete) { natalDay?.invalidateCalculations(); lifetime?.invalidateCalculations(); transit?.invalidateCalculations(); }
      if (returnsObsolete) returns?.invalidateCalculations();
      birthForm.refreshAvailability(); updateChartSaveControl(); updateTimelineTools(); updateLoading();
    },
    subscribeOfflineReady(listener:()=>void){offlineListeners.add(listener);return()=>{offlineListeners.delete(listener);};},
    prepareOfflineUpdate() {
      const ready=()=>{
      if(!offlineRestored() || chartSave?.work || birthForm.pending
        || account.snapshot?.verificationPending || account.snapshot?.telegramPending)return false;
      // Do not discard a RAM-only temporary/shared chart or unfinished field.
      // Those owners join this transition only after their restore contract exists.
      if(birthForm.opened && !birthForm.snapshot)return false;
      const focused=document.activeElement;
      const savedFocus = birthForm.snapshot?.focus
        || workspace.screen === 'account' && focused?.id === 'accountEmail' && account.snapshot?.focus
        || workspace.screen === 'charts' && focused?.id === 'allChartsSearch' && allCharts.snapshot.focus
        || workspace.screen === 'library' && focused?.id === 'knowledgeSearch' && knowledge.snapshot?.focus
        || workspace.screen === 'chart' && ['lifetimeFromDate','lifetimeToDate'].includes(focused?.id ?? '') && lifetimeControls?.snapshot?.focus;
      if(focused?.matches?.('input,textarea,[contenteditable="true"]') && !savedFocus)return false;
      return true;
      };
      if(!ready())return false;
      const selected=session.selectedId;
      const finish=()=>selected===session.selectedId && ready() && viewSession!.flush()===true;
      // Ask the durable owner again immediately before reload; quota relief in
      // this or another tab may have removed a card still visible in RAM.
      return selected==='current-transit' || selected===store.temporaryChart?.id
        || !accountLibrary.get(selected) && selected===store.publicChart?.id && store.publicChart.calculationVersion===accountLibrary.calculationVersion ? finish()
        : accountLibrary.canRestore(selected).then(durable=>durable && finish(),()=>false);
    },
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
