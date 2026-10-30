import { createWorkspaceView } from './views/workspace.ts';
import { returnsVisibleWindow } from './domain/returns-window.ts';
import { createChartToolsView } from './views/chart-tools-view.ts';
import { createActionNotice } from './ui/feedback.ts';
import { createChartEditing } from './application/chart-editing.ts';
import { readLibraryPackageKey } from './domain/library-maintenance.ts';
import type {LibraryLocalChange,LibraryLocalNotice} from './domain/library-maintenance.ts';
import { createResourceScope } from './runtime/resource-scope.ts';
import { createViewCheckpoint } from './state/view-checkpoint.ts';
import type { ViewCheckpoint } from './state/view-checkpoint.ts';
import { createLayoutObserver } from './ui/layout/resize-observer.ts';
import type { createJournal } from './journal.ts';
import type { StoragePressure } from './data/storage-pressure.ts';
import type { CalculationClients } from './data/calculation-clients.ts';
import type { AppRoute } from '../shared/app-routes.ts';
import { appRoutePath } from '../shared/app-routes.ts';
import { attachChartLink } from './views/chart-link.ts';
import type { Navigation } from './platform/browser/navigation.ts';
import { createApplication } from './application/application.ts';
import type { Application } from './application/application.ts';
import type {ReleaseCheckPort} from './application/background-work.ts';
import { createBackgroundCoordinator } from './platform/browser/background-coordinator.ts';
import { createPageLifecycle } from './platform/browser/lifecycle.ts';
import { createLibraryFillTransfer } from './data/library-fill-transfer.ts';
import type {LibraryFillPacket} from './data/library-fill-transfer.ts';
import type { SavedChart } from '../shared/chart-types.ts';
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
import type { MomentTimeline } from './state/moment-timeline.ts';
import type { LifetimeControls } from './views/lifetime-controls.ts';
import type { ReturnsPanel } from './views/returns-panel.ts';
type AppJournal=Pick<ReturnType<typeof createJournal>,'begin'|'setAccount'> & Partial<Pick<ReturnType<typeof createJournal>,'discardForSpace'|'close'>> & {leave(ids?:readonly string[]):unknown;wake():unknown};
interface AppOptions {
  connection?: ConnectionSource;
  journal?:AppJournal;
  storagePressure?:StoragePressure;
  navigation?: Navigation;
  calculationClients?: Pick<CalculationClients, 'natal' | 'cycles' | 'resetPersonal' | 'retryPersonalCleanup'> & Partial<Pick<CalculationClients,'evictForSpace'|'syncTodayTransitWindow'|'library'|'close'>>;
  account: Pick<AccountWorkspace, 'ready' | 'snapshot' | 'restoreInputFocus' | 'setVisible' | 'getSession' | 'subscribeSession' | 'subscribeNotices' | 'canRestoreLibrary'> & Partial<Pick<AccountWorkspace,'destroy'>>;
  dayClient: TransitDayClient; layout: StudioLayout; toast: Toast; viewStore: ViewStore;
  viewCheckpoint?: ViewCheckpoint;
  savedView: Partial<SavedView> | null; panels: PanelState; workspace: WorkspaceState;
  store: ChartStore; libraryView: ChartLibraryView; camera: Camera;
  cameraView: ReturnType<typeof createCameraView>; gestures?: Gestures | null;
  releaseStartupResources?:()=>Promise<void>;
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
import { createViewSession, viewForRoute, prepareSavedView } from './state/view-session.ts';
import { createTransitPlanetFilter } from './state/transit-planets.ts';
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
import { attachChartLoading } from './views/chart-loading.ts';
import { createReturnsController } from './state/returns.ts';
import { createCyclesClient } from './data/cycles-client.ts';
import { createNatalDayClient } from './data/natal-day-client.ts';
import { ageText, completedAge } from './domain/personal-age.ts';
import { eligibleCycleChart, personalTimelineTarget, cycleTimeZone } from './domain/cycles.ts';
import { attachReturnMarkers } from './views/returns-markers.ts';

// Composition root: each feature owns its state; these callbacks connect them.
export function startApp({ connection, journal, storagePressure, navigation, calculationClients, account, dayClient, layout, toast, viewStore, viewCheckpoint, savedView, panels, workspace, store, libraryView, camera, cameraView, gestures: startupGestures = null, initialPresentation = null, releaseLoadingContent = null, releaseStartupResources }: AppOptions) {
  const scope=createResourceScope();
  try {
  scope.own(()=>releaseStartupResources?.());
  scope.own(()=>calculationClients?.close?.());
  scope.own(()=>account.destroy?.());
  scope.own(()=>journal?.close?.());
  scope.own(()=>layout.destroy());
  const connectionMode = connection ? () => connection.current : getConnectionMode;
  const observeConnection = connection ? (listener: Parameters<ConnectionSource['subscribe']>[0]) => connection.subscribe(listener) : subscribeConnection;
  const checkpoint=viewCheckpoint??createViewCheckpoint({store:viewStore,eventTarget:document.defaultView,interactionTarget:document});
  if(!viewCheckpoint)scope.own(checkpoint.destroy);
  let application: Application | null = null;
  let releaseCheck:ReleaseCheckPort|null=null;
  const backgroundClock={now:Date.now,after(ms:number,run:()=>void){const timer=setTimeout(run,ms);return()=>clearTimeout(timer);}};
  const activityChanged=()=>application?.send({type:'BackgroundActivityChanged'});
  const routePending = () => application?.view.destination === 'preparing' && application.view.request?.snapshot.route?.kind === 'chart';
  const routeFailed = () => application?.view.destination === 'failed' && !application.view.request?.selection;
  let pendingBirthForm = savedView?.birthForm ?? null;
  // An operation is linked to this accepted tab source, never inferred from its content.
  const offlineListeners=new Set<()=>void>();
  const notifyOfflineReady=()=>{for(const listener of offlineListeners)listener();};
  function cancelChartSave(){application?.send({type:'CancelWrite'});}
  savedView = viewForRoute(navigation?.snapshot.route ?? null, savedView);
  const $ = <T extends Element = HTMLElement>(id: string) => document.getElementById(id) as unknown as T;
  scope.own(attachTelegramGestures([$('canvasWrap'), $('transitTime'), $('natalDayTime'), $('lifetimeTime')]));
  const studio = $('canvasWrap').parentElement!, shell = document.querySelector<HTMLElement>('.app-shell')!;
  const startupRestored=()=>application?.startup.restored===true;
  const startupFailed=()=>application?.startup.failed===true || initialPage.contentFailed;
  const workspaceView=createWorkspaceView({document,signal:scope.signal,workspace,studio,shell,saved:savedView,libraryView,account,releaseContent:releaseLoadingContent,
    get allCharts(){return allCharts;},get knowledge(){return knowledge;},get chartSummary(){return chartSummary;},get chartLibrary(){return chartLibrary;},
    get activationPopover(){return activationPopover;},get hoverPreview(){return hoverPreview;},get transit(){return transit;},get viewSession(){return viewSession;},
    get chartTools(){return chartTools;},get session(){return session;},get lifetimeControls(){return lifetimeControls;},get lifetime(){return lifetime;},
    get natalDay(){return natalDay;},get returns(){return returns;},get lifetimeFailed(){return lifetimeLoadFailed;},
    get lifetimeLoading(){return !!lifetimeLoading;},get returnsLoading(){return !!returnsViewLoading;},
    drawing:{get pending(){return chartPaintPending;},render:renderGraph},
    layout:{beginChange(){panelResizePending=true;},refresh:()=>refreshStudioLayout({preserveScale:true})},
    restored:startupRestored,failed:startupFailed,loadingChanged:()=>{updateLoading();activityChanged();}});
  const initialPage=workspaceView.initial;
  const {inputSnapshot,discardInput:discardPendingInput,restoreInput:restoreInitialInput}=workspaceView;
  function updateInitialPage(){workspaceView.update();}
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
  let lifetime: MomentTimeline | null = null, lifetimeControls: LifetimeControls | null = null;
  let viewSession: ReturnType<typeof createViewSession> | null = null;
  let chartPaintPending = false;
  let lifetimeLoading: Promise<MomentTimeline | null> | null = null, lifetimeLoadFailed = false;
  let returns: ReturnType<typeof createReturnsController> | null = null, returnsView: ReturnsPanel | null = null;
  let returnsViewLoading: Promise<ReturnsPanel | null> | null = null;
  scope.own(()=>{transit?.stop();natalDay?.select(null);lifetime?.close();returns?.select(null);});
  let returnMarkers: ReturnType<typeof attachReturnMarkers> | null = null;
  let exploration: ReturnType<typeof createChartExploration> | null = null, timelineLayoutKey = '';
  let phoneLayout = layout.phone, mandalaColumns = layout.showMandalaColumns;
  const activationPopover = attachActivationPopover($('activationPopover'), $('bodygraph'), { viewportLayout: layout,signal:scope.signal });
  const transitPlanets = createTransitPlanetFilter();
  const session = createChartSession({ store, initialSelectedId: savedView?.selectedId, getTransit: () => transit, getNatalDay: () => natalDay,
    getLifetime: () => lifetime, getReturns: () => returns,
    filterTransit: transitPlanets.filter, resetTransitFilter: transitPlanets.reset,
    onSelect: () => exploration?.selected(), onChange: presentChart });
  exploration = createChartExploration({ connection: connectionMode, session, getTransit: () => transit, getNatalDay: () => natalDay!,
    getLifetime: () => lifetime, getReturns: () => returns, loadLifetime,
    onTimelineReady: () => { updateTimelineTools(); refreshStudioLayout(); },
    onModeChange: updateTimelineTools, onChange: () => { syncLifetimeTransit(); viewSession?.schedule(); } });
  scope.own(exploration.dispose);
  const chartTools=createChartToolsView({document,signal:scope.signal,session,workspace,heading:headingLayout,initialPage,
    get returns(){return returns;},get lifetime(){return lifetime;},get natalDay(){return natalDay;},get exploration(){return exploration;},
    get transit(){return transit;},get chartSummary(){return chartSummary;},get returnsView(){return returnsView;},
    get lifetimeControls(){return lifetimeControls;},get returnMarkers(){return returnMarkers;},
    get initialPresentation(){return initialPresentation;},get loadFailed(){return lifetimeLoadFailed;},
    restored:startupRestored,connection:connectionMode,nowUtc:()=>new Date().toISOString(),loadReturnsView,
    layout:refreshTimelineLayout,updated:updateInitialPage});
  function updateChartCaption(){chartTools.caption();}
  function updateTimelineTools(){return chartTools.update();}
  function presentation(){return chartTools.presentation();}
  const currentChart = () => session.current;
  const lifetimeOwnsLoading = () => session.selectedId === 'current-transit' && Boolean(
    lifetime?.state.opened && lifetime.state.mode === 'range' || viewSession?.pendingLifetime?.mode === 'range');
  const chartLoading = attachChartLoading({ signal: scope.signal,
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
  if(!releaseStartupResources)scope.own(gestures.dispose);
  if (startupGestures) gestures.setHandlers(gestureHandlers);
  const activationHover = attachActivationHover($('bodygraph'));
  scope.own(activationHover.dispose);
  hoverPreview = attachHoverPreview($('bodygraph'), { signal:scope.signal,
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
  scope.own(knowledge.dispose);
  chartSummary = attachChartSummary({ panels, initialReturnsVisible: initialPresentation?.returnsVisible === true, isAvailable: () => workspace.screen === 'chart',
    panel: $('chartSummary'), summaryScreen: $('summaryScreen'), returnsPanel: $('returnsPanel'),
    switcher: $('summarySwitch'), backdrop: $('summaryBackdrop'),
    returnsButton: $('summaryReturns'), onReturns: () => { viewSession?.interrupt(); void exploration!.openReturnsList(); },
    onOpen: () => { activationPopover.close(); hoverPreview?.clear(); },
  });
  scope.own(chartSummary.dispose);
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
  scope.own(mandalaMode.dispose);
  // Explicit navigation reveals its destination on a phone. State projection
  // and restoration do not use this command, so a restored menu stays open.
  const routeForChart=(id:string)=>application!.routeForChart(id);
  const publishRoute=(route:AppRoute,replace=false)=>application!.publishRoute(route,replace);
  const navigateWorkspace=(screen:WorkspaceScreen,options?:{keepMenuOpen?:boolean;fromRoute?:boolean})=>application!.navigateWorkspace(screen,options);
  const selectChart=(id:string,options?:{keepMenuOpen?:boolean;fromRoute?:boolean;replace?:boolean})=>application!.selectChart(id,options);
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
  const actionNotice = createActionNotice(shell);
  scope.own(actionNotice.dispose);
  const chartLink = attachChartLink({notice: actionNotice, button: $<HTMLButtonElement>('copyChartLink'), root: shell, boundary: $('chartSummary')});
  scope.own(chartLink.dispose);
  const chartActions = createChartActions({client: chartClient, library: accountLibrary,
    getSession: account.getSession, initialPending: savedView?.pendingChartWrites,
    prepareWrite: () => viewSession!.checkpoint('write'),
    onPending: () => {viewSession?.flush();}});
  const chartEditing=createChartEditing({actions:chartActions,ready:()=>application!.requireAccount(),session:account.getSession,
    accountId:()=>accountLibrary.accountId,temporaryId:()=>store.temporaryChart?.id??null,
    observe:action=>journal?.begin({action,component:'chart'}),
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
  const openLibraryChart=(id:string,options?:{keepMenuOpen:boolean},edit=false)=>application!.openChart(id,{...options,edit});

  chartLibrary = attachChartLibrary({ serverDeletion: {handles: id => accountLibrary.has(id), checking: chartActions.isCheckingRemoval, submit:chartEditing.remove}, initialSelection: savedView?.librarySelection, panels, view: libraryView, getSelectedId: () => workspace.screen === 'chart' ? session.selectedId : null,
    document, getCharts: () => store.displayCharts,
    removeChart: id => {if(store.clearTemporary(id)){application?.send({type:'ClearTemporaryWrite'});viewSession?.flush();}}, getConnectionMode: connectionMode, subscribeConnection: observeConnection, session, onSelect: (id, options) => {void openLibraryChart(id, options);}, onUpdate:()=>viewSession?.schedule(), canEdit: canAccessCharts,
    onEdit: id => {void openLibraryChart(id, undefined, true);}, onNew: () => birthForm.open(),
    beforeOpen: () => { activationPopover.close(); hoverPreview?.clear(); },
  });
  scope.own(()=>chartLibrary?.dispose());
  const allCharts = attachAllCharts({ button: $('openAllCharts'), dialog: $('allChartsDialog'),
    list: $('allChartsList'), getCharts: () => store.displayCharts, canEdit: canEditCharts, onRowsChange: () => chartLibrary.refreshAvailability(), initialView: savedView?.charts, onChange: () => viewSession?.schedule(),
    onOpen: () => { navigateWorkspace('charts'); },
  });
  scope.own(allCharts.dispose);
  $('openAccount').addEventListener('click', () => { navigateWorkspace('account'); }, {signal:scope.signal});
  const birthForm = attachBirthForm({
    getAccountId: () => accountLibrary.accountId,
    onDraftChange: () => { pendingBirthForm = null; viewSession?.schedule(); },
    document, getChart: id => id ? store.get(id) : undefined,
    saveChart: chart => { store.setTemporary(chart);application?.send({type:'ClearTemporaryWrite'}); return true; },
    isCheckingSubmission: () => chartEditing.checking,
    submitChart: chartEditing.submit,
    ...birthClient, getConnectionMode: connectionMode, subscribeConnection: observeConnection, session, toast,
    onSave:(id,options)=>application!.formSaved(id,options),
    beforeOpen: () => { chartEditing.reset(); returns?.close(); activationPopover.close(); hoverPreview?.clear(); },
  });
  scope.own(birthForm.dispose);
  const natalDayClient = calculationClients?.natal ?? createNatalDayClient({ memory: dayClient.memory,library:libraryStorage });
  natalDay = attachNatalDayExplorer({ signal:scope.signal,
    connection: connectionMode,
    dayClient: natalDayClient,
    toggle: $('natalDayToggle'), panel: $('natalDayControls'), range: $('natalDayTime'), marker: $('natalDayReference'),
    status: $('natalDayStatus'), retryButton: $('natalDayRetry'), hourMarks: $('natalDayHourMarks'),
    onMomentInput: () => viewSession?.interrupt(),
    onRender: exploration!.publishDay, onStateChange: () => { updateTimelineTools(); viewSession?.schedule();activityChanged(); },
  });
  returnMarkers = attachReturnMarkers({ container: $('lifetimeTime').parentElement!,
    onTargetsChange: () => lifetimeControls?.refreshTargets(),
    onSelect: event => { viewSession?.interrupt(); return returns!.selectEvent(event.id); } });
  scope.own(returnMarkers.dispose);
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
      updateTimelineTools(); viewSession?.schedule();activityChanged();
    },
  });
  $('summaryBreakComparison').addEventListener('click', () => { viewSession?.interrupt(); exploration!.resetMoment(); }, {signal:scope.signal});
  $('natalDayToggle').addEventListener('click', () => changeTimeline('day', () => exploration!.toggleDay()), {signal:scope.signal});
  transit = attachLiveTransit({ signal:scope.signal,
    document, button: $('nowButton'), dayClient, isFormOpen: () => birthForm.opened,
    isChartVisible: () => workspace.screen === 'chart',
    onRender: exploration!.publishTransit, onStateChange: state => {
      application?.send({type:'TransitWindowObserved'});
      activityChanged();
      transitControls?.setCoveredByLifetime(session.selectedId !== 'current-transit' || Boolean(lifetime?.state.opened));
      transitControls?.update(state); syncLifetimeTransit(); updateLoading(); refreshTimelineLayout(); viewSession?.schedule();
      if (returns?.available) updateChartCaption();
    },
  });
  transitControls = attachTransitControls({ signal:scope.signal,
    panel: $('transitControls'), range: $('transitTime'), marker: $('transitReference'),
    status: $('transitStatus'), retryButton: $('transitRetry'), hourMarks: $('transitHourMarks'),
    onScrub: value => { viewSession?.interrupt(); return transit!.scrub(value); },
    onNow: () => { viewSession?.interrupt(); return transit!.goNow(); },
  });
  transitControls!.update(transit!.state);
  $('chartDialog').addEventListener('close', () => { if (!session.hasCurrent) transit!.refresh(); }, {signal:scope.signal});
  attachTransitNavigation($('nowButton'), { signal:scope.signal,
    onSelect: selectChart, refresh: transit!.refresh,
  });
  if (!startupGestures) scope.own(attachCameraControls({ fitButton: $('fitButton') }, gestures).dispose);
  const performanceMonitor=attachPerformanceMonitor({
    document, button: $('togglePerformance'), panel: $('performancePanel'), drawing: $('bodygraph'), inputSurface: $('canvasWrap'),
    ranges: [$('transitTime'), $('natalDayTime'), $('lifetimeTime')],
    motionButtons: [$('fitButton'), $('mandalaSwitch'), $('transitReference'), $('natalDayReference')],
  });

  scope.own(performanceMonitor.destroy);


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

  function presentLibrary() {
    chartLibrary?.render();allCharts?.update();updateChartSaveControl();
  }
  function presentChart(change:'moment'|'record'='moment') {
    if(scope.stopped)return;
    const layoutRendered = updateTimelineTools();
    updateChartCaption();
    if(change==='record'){
      chartLibrary?.render();updateChartSaveControl();
      application?.send({type:'BackgroundChanged'});
    }
    if (!layoutRendered) renderGraph();
    updateLoading();viewSession?.schedule();
  }


  scope.own(workspaceView.start());

  // Views have subscribed first, so their DOM is ready before measuring.
  scope.own(panels.subscribe(() => {
    panelResizePending = true;
    refreshStudioLayout({ preserveScale: true });
    viewSession?.schedule();
  }));

  returns!.select(session.record);
  natalDay!.select(session.record, session.baseChart);
  presentChart();presentLibrary();
  for (const name of ['transitionend', 'transitioncancel'] as const) $('canvasWrap').addEventListener(name, event => {
    if (event.target === $('canvasWrap') && ['left', 'width'].includes(event.propertyName) && panelResizePending) {
      refreshStudioLayout({ preserveScale: true });
    }
  }, {signal:scope.signal});
  const layoutObserver = createLayoutObserver(() => refreshStudioLayout());
  scope.own(()=>layoutObserver.disconnect());
  layoutObserver.observe($('canvasWrap'));
  const restoreView=prepareSavedView(savedView,store);
  viewSession = createViewSession({
    checkpoint, exploration, store: { read: () => restoreView, write: viewStore.write }, chartStore: store, session,
    onInterrupt:()=>application?.send({type:'StartupInterrupted'}),
    mandala: { get enabled() { return mandalaMode.enabled; },
      restore: enabled => mandalaMode.setEnabled(enabled, { animate: false }) }, camera: gestures, cameraRestored: true, panels, workspace, transit, natalDay: natalDay, planetFilter: transitPlanets,
    getBirthForm: () => pendingBirthForm ?? birthForm.snapshot,
    getLifetimeDraft: () => workspaceView.pendingLifetimeDraft ?? lifetimeControls?.snapshot ?? null, onPersisted:notifyOfflineReady,
    getTemporaryChartSave: () => application ? application.write.binding : savedView?.temporaryChartSave,
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
  function acceptLocalLibraryChange(change:LibraryLocalChange) {
    for(const key of change.keys){
      const ref=readLibraryPackageKey(key);
      if(ref){void natalDay?.refreshStoredPackage(ref);void returns?.refreshStoredPackage(ref);}
    }
    if(change.keys.includes(session.selectedId))notifyOfflineReady();
  }
  const libraryTransfer=createLibraryFillTransfer({store:libraryStorage,charts:chartClient,cycles:cyclesClient,lease:()=>accountLibrary.workingLease});
  application = createApplication({runtimeId:crypto.randomUUID(),navigation,libraryProjection:{
    library:accountLibrary,sources:store,selection:session,form:birthForm,
    view:{isChartScreen:()=>workspace.screen==='chart',changeChart:graph.changeChart,library:presentLibrary,checkpoint:()=>{viewSession?.flush();}},
  },background:{coordinator:backgroundCoordinator,
    clock:backgroundClock,library:accountLibrary,
    get release(){return releaseCheck;},get journal(){return journal??null;},
    calculations:calculationClients?.syncTodayTransitWindow?{syncTodayTransitWindow:calculationClients.syncTodayTransitWindow}:undefined,
    environment:{visible:()=>pageLifecycle.visible,online:()=>connectionMode()==='online',connected:()=>connectionMode()!=='offline',transitTimeZone:()=>transit?.state.timeline?.timeZone,
      busy:()=>Boolean(initialPage.active || birthForm.pending || account.snapshot?.verificationPending || account.snapshot?.telegramPending
        || transit?.state.loading || natalDay?.pending || returns?.pending || lifetimeLoading || lifetime?.pending)},
    local:{changed:acceptLocalLibraryChange,broadcast:notifyLibrary},
  },
    libraryFill:{...libraryTransfer,clock:backgroundClock,id:()=>crypto.randomUUID(),entries:()=>accountLibrary.completeCatalog?.entries??null,
      control:libraryStorage.fill,inventory:libraryStorage.maintenance.inventory,
      accepted(_candidate,payload,authority){
        const packet=payload as LibraryFillPacket;
        if(packet.kind==='card' && accountLibrary.acceptStored(packet.chart,packet.marker,authority.permit.lease,authority.permit.sessionId) && session.selectedId===packet.chart.id)notifyOfflineReady();
      }},
    libraryAudit:{clock:backgroundClock,id:()=>crypto.randomUUID(),store:libraryStorage.maintenance},
    update:{
    restored:()=>workspaceView.status==='ready',
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
    sources:{get temporaryId(){return store.temporaryChart?.id??null;},get publicId(){return store.publicChart?.id??null;},
      hasOwn:id=>!!accountLibrary.get(id),canRestore:accountLibrary.canRestore},
    checkpoint:()=>viewSession!.flush(),
  },startup:{
    library:accountLibrary,view:viewSession,
    form:{get pending(){return pendingBirthForm;},get opened(){return birthForm.opened;},
      clearPending(){pendingBirthForm=null;},restore:draft=>birthForm.restore(draft)},
    report(){toast('Не удалось восстановить положение страницы.');},
    changed(){
      if(startupRestored())initialPresentation=null;
      updateTimelineTools();updateLoading();restoreInitialInput();notifyOfflineReady();
    },
  },publicRefresh:{
    sources:store,session,library:accountLibrary,getSession:account.getSession,read:chartClient.public,id:()=>crypto.randomUUID(),
    view:{isChartScreen:()=>workspace.screen==='chart',selectTransit:()=>selectChart('current-transit',{replace:true}),
      changeChart:graph.changeChart,refresh:presentChart,checkpoint:()=>{viewSession?.flush();}},
  }, write:{
    actions:chartActions,online:()=>connectionMode()!=='offline',getSession:account.getSession,
    ready:()=>application!.requireAccount(),
    selection:session,temporary:()=>store.temporaryChart,hasOwn:id=>!!accountLibrary.get(id),
    initialBinding:savedView?.temporaryChartSave?.sourceId===store.temporaryChart?.id?savedView?.temporaryChartSave:null,
    retire(source){store.clearTemporary(source.id);store.releasePublicSource(source);},
    public:chartClient.public,acceptPublic:store.acceptPublic,clearPublic:store.clearPublic,
    view:{
      signIn(){navigateWorkspace('account');},select(id){selectChart(id,{replace:true});},
      isChartScreen:()=>workspace.screen==='chart',showChart:()=>workspace.setScreen('chart'),
      publishChart:id=>publishRoute({kind:'chart',id},true),changeChart:id=>graph.changeChart(id),refresh:presentChart,
      changed(){updateChartSaveControl();notifyOfflineReady();},checkpoint(){viewSession?.flush();},
      report(kind,error){toast(error===undefined?kind==='unconfirmed'?UI_MESSAGES.chartSaveUnconfirmed
        :kind==='unavailable'?UI_MESSAGES.chartUnavailable:UI_MESSAGES.chartSaveFailed:failureMessage(error,UI_MESSAGES.chartSaveFailed));},
    },
  }, account:{
    subscribeSession(listener){return account.subscribeSession(()=>listener(account.getSession()));},
    subscribeLogout(listener){return account.subscribeNotices(notice=>{if(notice.kind==='logout')listener(notice.ids);});},
    ready:account.ready,getSession:account.getSession,journal,
    library:accountLibrary,calculations:calculationClients,writes:chartActions,editing:chartEditing,
    binding:{get accountId(){return application?.write.binding?.expectedAccountId??null;},clear(){application?.send({type:'ClearTemporaryWrite'});}},
    form:{get pending(){return pendingBirthForm;},get snapshot(){return birthForm.snapshot;},get opened(){return birthForm.opened;},
      clearPending(){pendingBirthForm=null;},discardInput:discardPendingInput,close:()=>birthForm.close()},
    checkpoint:{clearPersonal:()=>checkpoint.clearPersonal({temporaryChart:store.temporaryChart,publicChart:store.publicChart,selectedId:session.selectedId}),
      flush:()=>viewSession!.flush()},closeDelete:()=>chartLibrary?.closeDelete(),
    changed:notifyOfflineReady,
    storageUnavailable(){toast('Хранилище браузера недоступно. Изменения не будут сохранены.');},
  },route:{
    library:accountLibrary,sources:store,session,online:()=>connectionMode()!=='offline',now:Date.now,readPublic:chartClient.public,
    observe(stage){const observation=journal?.begin({action:'chart_open',component:'chart'});
      return observation?{failed(error){void observation.reportError(error,{stage});},finish:()=>observation.finishSuccess()}:null;},
    view:{
      workspace(screen,keepMenuOpen){if(layout.phone && !keepMenuOpen)chartLibrary?.close();workspace.setScreen(screen);},
      select:graph.changeChart,resetCamera:()=>gestures.reset(),edit:id=>birthForm.open(true,id),
      interrupt:()=>viewSession?.interrupt(),settled(){initialPresentation=null;updateLoading();},checkpoint:()=>{viewSession?.flush();},
      report(error){toast(failureMessage(error,UI_MESSAGES.chartUnavailable));},
      firstTransit:()=>transit!.start(null,{firstChart:true}),transitReady(ready){initialPage.contentFailed=!ready;updateLoading();},
      markOpened:id=>application!.send({type:'LibraryUsed',id}),publicRead(checkedAt,receivedAt){application!.send({type:'PublicSourceRead',source:store.publicChart!,checkedAt,receivedAt});},
    },
  }});
    scope.own(()=>application!.stop());
    scope.own(application.subscribe(updateLoading));
    application.start();
  scope.own(accountLibrary.subscribe(()=>application!.libraryChanged()));
  scope.own(libraryStorage.subscribeLocal(change=>application!.send({type:'LibraryLocalChanged',change})));
  scope.own(pageLifecycle.subscribe(returned=>application!.environmentChanged({reason:'lifecycle',returned})));
  if(libraryChannel)libraryChannel.onmessage=event=>application!.receiveLibrary(event.data);
  document.addEventListener('visibilitychange',()=>application!.environmentChanged({reason:'visibility'}),{signal:scope.signal});
  scope.own(observeConnection(()=>{
    updateChartSaveControl();void natalDay?.refreshAvailability();void returns?.refreshAvailability();
    lifetime?.refreshAvailability();updateTimelineTools();application!.environmentChanged({reason:'connection'});
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
      scope.own(returnsView.dispose);
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


  // Both a toolbar click and page restoration use the same lazy controller.
  // Importing it alone never opens Lifetime or resets a restored date range.
  async function loadLifetime(): Promise<MomentTimeline | null> {
    if(scope.stopped)return null;
    if (lifetime) return lifetime;
    if (lifetimeLoading) return lifetimeLoading;
    if (lifetimeLoadFailed) return null;
    $('lifetimeToggle').setAttribute('aria-busy', 'true');
    lifetimeLoading = (async () => {
      try {
        const [{ createMomentTimeline }, { attachLifetimeControls }] = await Promise.all([
          import('./state/moment-timeline.ts'), import('./views/lifetime-controls.ts'),
        ]);
        if(scope.stopped)return null;
        const getDayState = () => session.selectedId === 'current-transit' ? transit!.state : null;
        const getPersonalRecord = () => returns!.available ? returns!.natal : null;
        let controls: LifetimeControls | undefined;
        const controller = createMomentTimeline({
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
            updateTimelineTools(); updateLoading();activityChanged();
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
        updateInitialPage();activityChanged();
      }
    })();
    activityChanged();return lifetimeLoading;
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
  workspaceView.attach();
  // The startup owner keeps its checkpoint if assembly throws before handoff.
  if(viewCheckpoint)scope.own(checkpoint.destroy);
  const offlineRestored = () => application!.isRestored();
  return { saveShownChart,cancelChartSave,restoration,offlineRestored,
    attachReleaseCheck(port:ReleaseCheckPort){if(scope.stopped){port.stop();return;}releaseCheck?.stop();releaseCheck=port;application?.send({type:'BackgroundChanged'});},
    subscribeOfflineReady(listener:()=>void){offlineListeners.add(listener);return()=>{offlineListeners.delete(listener);};},
    prepareOfflineUpdate:(signal?:AbortSignal)=>application!.prepareUpdate(signal),
    stopApplication: scope.stop,
    flushView: () => viewSession!.flush(),
    attachJournal(value:AppJournal){
      if(scope.stopped){void value.close?.();return;}
      if(journal===value)return;
      journal=value;application!.attachJournal(value);application!.send({type:'BackgroundChanged'});
    } };
  } catch(error) {
    void scope.stop().catch(cleanupError=>console.error('Application cleanup failed',cleanupError));
    throw error;
  }
}
