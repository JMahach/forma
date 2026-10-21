import { attachKnowledgeEntry } from './views/knowledge-entry.js';
import { attachActivationPopover } from './views/activation-popover.js';
import { attachHoverPreview } from './selection/hover-preview.js';
import { attachGestures } from './scene/gestures.js';
import { pointerTarget } from './scene/pointer-target.js';
import { attachMandalaMode } from './scene/modes/mandala.js';
import { createMandalaMotion } from './scene/modes/mandala-motion.js';
import { mandalaPreviewFromPointer, mandalaPreviewFromFocus, mandalaSelectionFromTarget } from './scene/mandala-preview.js';
import { createGraphController } from './scene/updates.js';
import { attachCameraControls, createCameraChangeHandler } from './views/camera-controls.js';
import { createChartSession } from './state/chart-session.js';
import { createChartExploration } from './state/chart-exploration.js';
import { createViewSession } from './state/view-session.js';
import { createTransitPlanetFilter } from './state/transit-planets.js';
import { chartCaption } from './views/chart-display.js';
import { createChartHeadingLayout } from './ui/layout/chart-heading.js';
import { attachChartLibrary } from './views/library.js';
import { attachAllCharts } from './views/all-charts.js';
import { attachBirthForm } from './views/birth-form.js';
import { attachLiveTransit, attachTransitNavigation } from './views/live-transit.js';
import { attachTransitControls } from './views/transit-controls.js';
import { attachNatalDayExplorer } from './views/natal-day-controls.js';
import { attachChartSummary } from './views/chart-summary-panel.js';
import { attachTelegramGestures } from './ui/telegram-gestures.js';
import { attachPerformanceMonitor } from './views/performance-monitor.js';
import { attachChartLoading, holdLoadingContent } from './views/chart-loading.js';
import { createReturnsController } from './state/returns.js';
import { createCyclesClient } from './data/cycles-client.js';
import { createNatalDayClient } from './data/natal-day-client.js';
import { ageText, completedAge } from './domain/personal-age.js';
import { eligibleCycleChart, lifeTimelineForChart, cycleTimeZone } from './domain/cycles.js';
import { attachReturnMarkers } from './views/returns-markers.js';
import { returnsVisibleWindow } from './domain/returns-window.js';
import { studioPresentation } from './ui/studio-presentation.js';

// Composition root: each feature owns its state; these callbacks connect them.
export function startApp({ dayClient, layout, toast, viewStore, savedView, panels, workspace, store, libraryView, camera, cameraView, initialPresentation = null, releaseLoadingContent = null, previewLoading = false }) {
  const $ = id => document.getElementById(id);
  attachTelegramGestures([$('canvasWrap'), $('transitTime'), $('natalDayTime'), $('lifetimeTime')]);
  const studio = $('canvasWrap').parentElement, shell = document.querySelector('.app-shell');
  // One initial reveal owns the visible screen. Later refreshes stay local to
  // their tools; a failed first attempt reveals the existing recovery UI.
  const initialPage = { active: true, attached: false, restored: false, restoreFailed: false,
    screenPending: false, screenFailed: false, screenRevision: 0 };
  const releaseInitialContent = releaseLoadingContent || holdLoadingContent(document);
  shell.dataset.pageState = 'loading'; shell.inert = false; shell.setAttribute('aria-busy', 'true');
  let fontsSettled = false;
  const fontsReady = Promise.resolve(document.fonts?.ready).catch(() => {});
  void fontsReady.then(() => { fontsSettled = true; updateInitialPage(); });
  let panelResizePending = false;
  const headingLayout = createChartHeadingLayout({
    header: $('chartHeader'), title: $('chartTitle'), subtitle: $('chartSubtitle'), canvas: $('canvasWrap'),
    content: $('chartHeader').querySelector('.chart-heading'),
    leftControls: document.querySelector('.topbar-leading'), rightControls: document.querySelector('.chart-tools'),
    getMandalaTop: () => $('canvasWrap').getBoundingClientRect().top + layout.mandalaTop,
  });
  let hoverPreview = null, chartSummary = null, mandalaMode = null, library = null, transit = null, transitControls = null, natalDay = null, lifetime = null, lifetimeControls = null;
  let viewSession = null, lifetimeLoading = null, lifetimeLoadFailed = false;
  let returns = null, returnsView = null, returnsViewLoading = null, returnMarkers = null;
  let exploration = null, timelineLayoutKey = '';
  let phoneLayout = layout.phone, mandalaColumns = layout.showMandalaColumns;
  const activationPopover = attachActivationPopover($('activationPopover'), $('bodygraph'), { viewportLayout: layout });
  const transitPlanets = createTransitPlanetFilter();
  const session = createChartSession({ store, initialSelectedId: savedView?.selectedId, getTransit: () => transit, getNatalDay: () => natalDay,
    getLifetime: () => lifetime, getReturns: () => returns,
    filterTransit: transitPlanets.filter, resetTransitFilter: transitPlanets.reset,
    onSelect: () => exploration?.selected(), onChange: updatePage });
  exploration = createChartExploration({ session, getTransit: () => transit, getNatalDay: () => natalDay,
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
      if (lifetimeOwnsLoading()) {
        if (lifetimeLoadFailed) window.location.reload();
        else void lifetime?.retry();
      } else void transit?.retry();
    },
  });
  const updateLoading = () => {
    const lifetimeLoading = lifetimeOwnsLoading(), state = lifetimeLoading ? lifetime?.state : transit?.state;
    const firstFailed = initialPage.restored && initialPage.restoreFailed && !session.hasCurrent;
    chartLoading.update({ hasChart: session.hasCurrent, holdLoading: initialPage.active,
      failed: firstFailed || (lifetimeLoading ? lifetimeLoadFailed || state?.status === 'error' : state?.unavailable),
      loading: !firstFailed && (lifetimeLoading ? !lifetimeLoadFailed && (!state || state.status === 'loading') : state?.loading) });
    updateInitialPage();
  };

  const graph = createGraphController({
    getChart: currentChart, hasChart: () => session.hasCurrent,
    viewport: $('viewport'),
    getActiveElement: () => document.activeElement, activationPopover,
    getShowActivations: () => !(mandalaMode?.enabled && !layout.showMandalaColumns),
    getHoverPreview: () => hoverPreview, getSummary: () => chartSummary, getMandala: () => mandalaMode,
    onChartChange(id) {
      viewSession?.interrupt();
      void exploration.select(id);
    },
  });
  const cameraChanged = createCameraChangeHandler({
    heading: $('chartHeader'), fitButton: $('fitButton'), activationPopover,
    getHoverPreview: () => hoverPreview, getSummary: () => chartSummary,
  });
  const gestures = attachGestures($('bodygraph'), {
    camera, cameraView,
    onSelect(selection) {
      if (selection.type !== 'planet-filter') { graph.choose(selection); return; }
      if (session.selectedId !== 'current-transit') return;
      const [source, planet] = selection.id.startsWith('design:') ? selection.id.split(':') : ['personality', selection.id];
      const owner = session.owner === 'lifetime' && lifetime?.current ? lifetime : transitPlanets;
      if (planet === 'all') owner.toggleAllPlanets(source);
      else owner.togglePlanet(planet, source);
      if (owner === transitPlanets) session.refilter();
      viewSession?.schedule();
    },
    resolvePointerTarget: event => pointerTarget($('bodygraph'), event, $('canvasWrap')),
    resolveSelection: (target, event) => mandalaSelectionFromTarget(event, target, hoverPreview?.currentSelection),
    onBackgroundTap: graph.clear,
    onChange(view, fitted, metadata) {
      cameraChanged(view, fitted, metadata);
      viewSession?.schedule();
    },
  });
  hoverPreview = attachHoverPreview($('bodygraph'), {
    resolvePreview: mandalaPreviewFromPointer, resolveKeyboard: mandalaPreviewFromFocus,
    coalesceMandala: true, onPreview: graph.preview,
  });
  const knowledge = attachKnowledgeEntry({ button: $('openKnowledge'), dialog: $('knowledgeDialog'),
    onSelect: selection => { navigateWorkspace('chart'); graph.choose(selection); },
    onOpen: () => {
      const alreadyShown = workspace.screen === 'library';
      navigateWorkspace('library');
      if (alreadyShown) void knowledge.show();
    },
    isCurrent: () => workspace.screen === 'library',
    getSelection: () => graph.selectionState.primary, onError: toast });
  chartSummary = attachChartSummary({ panels, isAvailable: () => workspace.screen === 'chart', focusSearch: () => !layout.phone,
    panel: $('chartSummary'), summaryScreen: $('summaryScreen'), returnsPanel: $('returnsPanel'), content: $('chartSummaryContent'), overview: $('summaryOverview'),
    search: $('summarySearch'), switcher: $('summarySwitch'), backdrop: $('summaryBackdrop'),
    returnsButton: $('summaryReturns'), onReturns: () => { viewSession?.interrupt(); void exploration.openReturnsList(); },
    onSelect: graph.choose, onLines: graph.chooseSummary,
    onOpen: () => { returns?.close(); activationPopover.close(); hoverPreview?.clear(); },
    onClose: () => returns?.close(),
  });
  const mandalaMotion = createMandalaMotion({
    viewport: $('canvasWrap'), onUpdate: () => activationPopover.reposition(),
    onFinish: enabled => mandalaMode?.finishTransition(enabled),
  });
  mandalaMode = attachMandalaMode({
    button: $('mandalaSwitch'), canvas: $('canvasWrap'), gestures, render: graph.render,
    motion: mandalaMotion, layout, onStateChange: () => viewSession?.schedule(),
    beforeChange: () => { activationPopover.close(); hoverPreview?.clear({ notify: false }); },
  });
  // Explicit navigation reveals its destination on a phone. State projection
  // and restoration do not use this command, so a restored menu stays open.
  function navigateWorkspace(screen) {
    if (layout.phone) library?.close();
    workspace.setScreen(screen);
  }
  // Opening a chart uses Home; updating the current chart keeps its camera.
  function selectChart(id) {
    navigateWorkspace('chart');
    graph.changeChart(id);
    gestures.reset();
  }
  library = attachChartLibrary({ panels, view: libraryView, getSelectedId: () => workspace.screen === 'chart' ? session.selectedId : null,
    document, store, session, onSelect: selectChart, onUpdate: updatePage,
    onEdit: id => birthForm.open(true, id), onNew: () => birthForm.open(),
    beforeOpen: () => { activationPopover.close(); hoverPreview?.clear(); },
  });
  const allCharts = attachAllCharts({ button: $('openAllCharts'), dialog: $('allChartsDialog'),
    list: $('allChartsList'), store, session,
    onOpen: () => { navigateWorkspace('charts'); },
  });
  $('openAccount').addEventListener('click', () => { navigateWorkspace('account'); });
  const birthForm = attachBirthForm({
    document, store, session, toast,
    onSave: (id, { metadataOnly = false } = {}) => {
      if (id !== session.selectedId) selectChart(id);
      else if (metadataOnly) session.refreshRecord();
      else graph.changeChart(id);
      workspace.setScreen('chart');
    },
    beforeOpen: () => { returns?.close(); activationPopover.close(); hoverPreview?.clear(); },
  });
  const natalDayClient = createNatalDayClient({ memory: dayClient.memory, calculationVersion: document.body.dataset.calculationVersion });
  natalDay = attachNatalDayExplorer({
    dayClient: natalDayClient,
    toggle: $('natalDayToggle'), panel: $('natalDayControls'), range: $('natalDayTime'), marker: $('natalDayReference'),
    status: $('natalDayStatus'), retryButton: $('natalDayRetry'), hourMarks: $('natalDayHourMarks'),
    onMomentInput: () => viewSession?.interrupt(),
    onRender: exploration.publishDay, onStateChange: () => { updateTimelineTools(); viewSession?.schedule(); },
  });
  returnMarkers = attachReturnMarkers({ container: $('lifetimeTime').parentElement,
    onTargetsChange: () => lifetimeControls?.refreshTargets(),
    onSelect: event => { viewSession?.interrupt(); return returns.selectEvent(event.id); } });
  returns = createReturnsController({
    client: createCyclesClient({ memory: dayClient.memory, cacheVersion: document.body.dataset.cyclesVersion }),
    onRequest: exploration.requestReturn, onRender: exploration.publishReturn,
    onStateChange() {
      updateTimelineTools(); viewSession?.schedule();
    },
  });
  $('natalDayToggle').addEventListener('click', () => {
    viewSession?.interrupt();
    void exploration.toggleDay();
  });
  transit = attachLiveTransit({
    document, button: $('nowButton'), dayClient, isFormOpen: () => birthForm.opened,
    onRender: exploration.publishTransit, onStateChange: state => {
      transitControls?.setCoveredByLifetime(session.selectedId !== 'current-transit' || Boolean(lifetime?.state.opened));
      transitControls?.update(state); syncLifetimeTransit(); updateLoading(); refreshTimelineLayout(); viewSession?.schedule();
      if (returns?.available) updateChartCaption();
    },
  });
  transitControls = attachTransitControls({
    panel: $('transitControls'), range: $('transitTime'), marker: $('transitReference'),
    status: $('transitStatus'), retryButton: $('transitRetry'), hourMarks: $('transitHourMarks'),
    onScrub: value => { viewSession?.interrupt(); return transit.scrub(value); },
    onNow: () => { viewSession?.interrupt(); return transit.goNow(); },
  });
  transitControls.update(transit.state);
  $('chartDialog').addEventListener('close', () => { if (!session.hasCurrent) transit.refresh(); });
  attachTransitNavigation($('nowButton'), {
    onSelect: selectChart, refresh: transit.refresh,
  });
  attachCameraControls({ fitButton: $('fitButton') }, gestures);
  attachPerformanceMonitor({
    document, button: $('togglePerformance'), panel: $('performancePanel'), drawing: $('bodygraph'), inputSurface: $('canvasWrap'),
    ranges: [$('transitTime'), $('natalDayTime'), $('lifetimeTime')],
    motionButtons: [$('fitButton'), $('mandalaSwitch'), $('transitReference'), $('natalDayReference')],
    initiallyEnabled: new URLSearchParams(location.search).get('fps') === '1',
  });

  function updateChartCaption() {
    const chart = currentChart();
    // The accepted composition describes the shown moment, even while another
    // source is loading. A pending owner must not change the natal caption.
    const caption = chartCaption(chart, session.record,
      { useUtc: session.shownSource === 'lifetime',
        showAge: Boolean(returns?.available),
        ageUtc: new Date().toISOString() });
    headingLayout.updateText(caption.title, caption.subtitle);
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
      graph.render();
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
    return studioPresentation({ isTransit: session.selectedId === 'current-transit',
      personalAvailable: Boolean(returns?.available), dayOpened: Boolean(natalDay?.state.opened),
      lifetime: lifetime?.state, returnsOpened: Boolean(returns?.opened),
      returnsEnabled: exploration.returnsEnabled, transitEnabled: exploration.transitEnabled,
      loadFailed: lifetimeLoadFailed });
  }

  function refreshTimelineLayout(view = presentation()) {
    if (!transitControls) return;
    if (initialPage.active && !initialPage.restored && initialPresentation) view = initialPresentation;
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
    updateChartCaption();
    library.render(); allCharts?.update(); updateWorkspaceNavigation();
    if (!layoutRendered) graph.render();
    updateLoading();
    viewSession?.schedule();
  }

  function updateWorkspaceNavigation() {
    libraryView.setScreen(workspace.screen);
  }
  async function waitForInitialCharts(revision) {
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
    studio.dataset.workspaceScreen = screen;
    allCharts.setVisible(screen === 'charts');
    const knowledgeReady = screen === 'library' ? knowledge.show() : (knowledge.hide(), null);
    $('accountPage').hidden = screen !== 'account';
    chartSummary.layout(); library.render(); updateWorkspaceNavigation();
    activationPopover.close(); hoverPreview?.clear();
    panelResizePending = true;
    refreshStudioLayout({ preserveScale: true });
    viewSession?.schedule();
    if (initialPage.active) {
      initialPage.screenFailed = false;
      initialPage.screenPending = screen === 'library' || screen === 'charts';
      const ready = screen === 'library' ? knowledgeReady : screen === 'charts'
        ? waitForInitialCharts(revision) : null;
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
  function updateInitialPage() {
    if (!initialPage.active || !initialPage.attached || !fontsSettled || initialPage.screenPending || previewLoading) return;
    let failed = initialPage.screenFailed;
    if (workspace.screen === 'chart') {
      if (!initialPage.restored) return;
      const view = presentation(), cycles = returns.state, day = natalDay.state, life = lifetime?.state;
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
    studio.getBoundingClientRect();
    delete shell.dataset.booting;
  }
  workspace.subscribe(applyWorkspace);
  applyWorkspace();

  // Views have subscribed first, so their DOM is ready before measuring.
  panels.subscribe(() => {
    panelResizePending = true;
    refreshStudioLayout({ preserveScale: true });
    viewSession?.schedule();
  });

  returns.select(session.record);
  natalDay.select(session.record, session.baseChart);
  updatePage();
  for (const name of ['transitionend', 'transitioncancel']) $('canvasWrap').addEventListener(name, event => {
    if (event.target === $('canvasWrap') && ['left', 'width'].includes(event.propertyName) && panelResizePending) {
      refreshStudioLayout({ preserveScale: true });
    }
  });
  const layoutObserver = new ResizeObserver(refreshStudioLayout);
  layoutObserver.observe($('canvasWrap'));
  if (!store.storageAvailable) toast('Хранилище браузера недоступно. Изменения не будут сохранены.');
  const savedChart = store.get(savedView?.selectedId);
  const savedLife = eligibleCycleChart(savedChart) && savedView?.lifetime?.opened ? lifeTimelineForChart(savedChart) : null;
  const restoreView = savedLife ? { ...savedView, lifetime: { ...savedView.lifetime, ...savedLife,
    minimumUtc: savedChart.utc, mode: 'lifetime', openEnded: false } } : savedView;
  viewSession = createViewSession({
    store: { read: () => restoreView, write: previewLoading ? () => false : viewStore.write }, chartStore: store, session,
    mandala: mandalaMode, camera: gestures, cameraRestored: true, panels, workspace, transit, natalDay: natalDay, planetFilter: transitPlanets,
    getPersonalPreview: () => returns.available ? exploration.preview : undefined,
    getPersonalLive: () => returns.available ? exploration.live : undefined,
    restorePersonalPreview: exploration.restorePreview,
    restorePersonalLive: exploration.restoreLive,
    acceptLifetimeMode: exploration.acceptLifetimeMode,
    getReturns: () => returns, getLifetime: () => lifetime, loadLifetime,
    openReturnsTimeline: exploration.openTimeline, canRestoreLifetime: () => (session.selectedId === 'current-transit' || returns.available),
  });
  void (async () => {
    try { initialPage.restoreFailed = await viewSession.restore() === false; }
    catch { initialPage.restoreFailed = true; toast('Не удалось восстановить положение страницы.'); }
    try {
      const resumed = await exploration.finishRestore({ saved: restoreView, interrupted: viewSession.interrupted,
        pendingLifetime: viewSession.pendingLifetime, pendingReturns: viewSession.pendingReturns });
      initialPage.restoreFailed ||= resumed === false;
    } catch { initialPage.restoreFailed = true; toast('Не удалось восстановить положение страницы.'); }
    initialPage.restored = true; updateTimelineTools(); updateLoading();
  })();
  studio.dataset.panelsReady = 'true';

  function loadReturnsView() {
    if (returnsView) return Promise.resolve(returnsView);
    if (returnsViewLoading) return returnsViewLoading;
    returnsViewLoading = import('./views/returns-panel.js').then(({ attachReturnsPanel }) => {
      returnsView = attachReturnsPanel({ getLayout: () => layout.returnsLayout, viewportLayout: layout,
        document, onClose: () => chartSummary.close({ focus: true }), onBack: () => chartSummary.open(),
        onYear: value => returns.setYear(value),
        onBodies: value => returns.setBodies(value),
        onSelect: async value => { viewSession?.interrupt(); const selected = await returns.selectEvent(value); if (selected && returnsView.sheet()) returns.close(); },
        onBirth: () => { viewSession?.interrupt(); returns.setYear(null); exploration.resetMoment(); if (returnsView.sheet()) returns.close(); },
        onNow: () => { viewSession?.interrupt(); returns.setYear(null); if (exploration.followNow() && returnsView.sheet()) returns.close(); },
        onRetry: () => returns.retry(),
        onLayout: refreshStudioLayout,
      });
      // Loading only supplies the view. The controller still owns whether its
      // drawer is open, including another click or navigation during the import.
      updateTimelineTools();
      return returnsView;
    }).catch(() => {
      if (initialPage.active) initialPage.restoreFailed = true;
      if (returns.opened) { returns.close(); toast('Не удалось открыть возвраты. Попробуйте ещё раз.'); }
      return null;
    }).finally(() => { returnsViewLoading = null; updateInitialPage(); });
    return returnsViewLoading;
  }

  function updateTimelineTools() {
    if (!returns) return;
    const state = returns.state, lifetimeState = lifetime?.state, metadata = lifetimeState?.metadata;
    const view = presentation();
    const heading = $('lifetimeControls').querySelector('.lifetime-heading');
    heading.hidden = !view.lifetimeHeadingVisible; heading.inert = !view.lifetimeHeadingVisible;
    $('lifetimeControls').dataset.personalLife = String(state.available);
    $('summaryReturns').hidden = !state.available;
    // Source labels describe the same resolved chart as the scene.
    const chart = currentChart();
    const viewState = { ...state, visible: view.returnsVisible,
      birthSelected: !exploration.live && chart.primary === session.baseChart && !chart.secondary, live: exploration.live };
    chartSummary.setReturnsVisible(Boolean(returnsView && view.returnsVisible));
    if (returnsView) returnsView.update(viewState);
    else if (view.returnsVisible) void loadReturnsView();
    const lifetimeToggle = $('lifetimeToggle');
    lifetimeToggle.hidden = !view.lifetimeAvailable;
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
      fromUtc: window?.minUtc ?? NaN,
      toUtc: window?.maxUtc ?? NaN,
      visible: Boolean(valid) });
    const changed = refreshTimelineLayout(view);
    updateInitialPage();
    return changed;
  }

  // Both a toolbar click and page restoration use the same lazy controller.
  // Importing it alone never opens Lifetime or resets a restored date range.
  async function loadLifetime() {
    if (lifetime) return lifetime;
    if (lifetimeLoading) return lifetimeLoading;
    if (lifetimeLoadFailed) return null;
    $('lifetimeToggle').setAttribute('aria-busy', 'true');
    lifetimeLoading = (async () => {
      try {
        const [{ createLifetimeExplorer }, { attachLifetimeControls }] = await Promise.all([
          import('./state/lifetime.js'), import('./views/lifetime-controls.js'),
        ]);
        const getDayState = () => session.selectedId === 'current-transit' ? transit.state : null;
        const getPersonalRecord = () => returns.available ? returns.natal : null;
        let controls;
        const controller = createLifetimeExplorer({
          dayClient, natalDayClient, planetFilter: transitPlanets,
          getDayState, getPersonalRecord, getMomentState: exploration.momentState,
          onRender: exploration.publishLifetime,
          onModeAccepted: exploration.acceptLifetimeMode,
          onStateChange(state) {
            controls?.update(state);
            transitControls.setCoveredByLifetime(state.opened || session.selectedId !== 'current-transit');
            viewSession?.schedule();
            exploration.lifetimeChanged(state);
            updateTimelineTools(); updateLoading();
          },
        });
        controls = attachLifetimeControls({
          explorer: controller, viewportLayout: layout, getDayState, getPersonalRecord,
          formatEndpoints: state => {
            const natal = session.record;
            if (eligibleCycleChart(natal) && !natalDay.state.opened && Number.isInteger(returns.year)) {
              const visible = returnsVisibleWindow(natal, returns.year, state);
              if (visible) {
                const label = new Intl.DateTimeFormat('ru', { timeZone: cycleTimeZone(natal.timezone), month: 'short', year: 'numeric' });
                return [label.format(visible.minUtc), label.format(visible.maxUtc)];
              }
            }
            return eligibleCycleChart(natal) && !natalDay.state.opened
              ? ['Рождение', ageText(completedAge(`${state.toDate}T23:59:59Z`, natal))] : null;
          },
          getMomentState: exploration.momentState,
          onDayScrub: transit.scrub, onDayNow: transit.goNow,
          onLifetimeNow: () => {
            if (returns.available) returns.setYear(null);
            if (!exploration.followNow()) return false;
            returns.close(); return true;
          },
          resolveTap: (event, metrics) => returnMarkers?.hitTest(event, metrics),
          beforeScrub: exploration.beforeScrub,
          onMomentInput: () => viewSession?.interrupt(),
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
      }
    })();
    return lifetimeLoading;
  }
  $('lifetimeToggle').addEventListener('click', () => {
    if (session.selectedId !== 'current-transit' && !returns.available) return;
    viewSession?.interrupt();
    activationPopover.close(); hoverPreview?.clear();
    if (lifetimeLoadFailed) { window.location.reload(); return; }
    if (session.selectedId === 'current-transit') {
      void exploration.toggleTransit();
    } else void exploration.toggleReturns();
  });
  for (const field of [$('lifetimeFromDate'), $('lifetimeToDate')]) {
    field.addEventListener('input', () => { viewSession?.interrupt(); exploration.invalidateTimeline(); }, true);
  }
  initialPage.attached = true;
  updateInitialPage();
}
