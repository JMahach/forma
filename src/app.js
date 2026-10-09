import { attachKnowledgeEntry } from './views/knowledge-entry.js';
import { attachActivationPopover } from './views/activation-popover.js';
import { attachHoverPreview } from './selection/hover-preview.js';
import { attachGestures } from './scene/gestures.js';
import { pointerTarget } from './scene/pointer-target.js';
import { createCameraView } from './scene/camera-view.js';
import { attachMandalaMode } from './scene/modes/mandala.js';
import { createMandalaMotion } from './scene/modes/mandala-motion.js';
import { mandalaPreviewFromPointer, mandalaPreviewFromFocus, mandalaSelectionFromTarget } from './scene/mandala-preview.js';
import { createGraphController } from './scene/updates.js';
import { attachCameraControls, createCameraChangeHandler } from './views/camera-controls.js';
import { createChartStore } from './data/chart-store.js';
import { createChartSession } from './state/chart-session.js';
import { createChartExploration } from './state/chart-exploration.js';
import { createViewSession } from './state/view-session.js';
import { createTransitPlanetFilter } from './state/transit-planets.js';
import { chartCaption } from './views/chart-display.js';
import { createChartHeadingLayout } from './views/chart-heading-layout.js';
import { attachChartLibrary } from './views/library.js';
import { attachBirthForm } from './views/birth-form.js';
import { attachLiveTransit, attachTransitNavigation } from './views/live-transit.js';
import { attachTransitControls } from './views/transit-controls.js';
import { attachNatalDayExplorer } from './views/natal-day-controls.js';
import { attachChartSummary } from './views/chart-summary-panel.js';
import { attachTelegramGestures } from './ui/telegram-gestures.js';
import { attachPerformanceMonitor } from './views/performance-monitor.js';
import { attachChartLoading } from './views/chart-loading.js';
import { createReturnsController } from './state/returns.js';
import { createCyclesClient } from './data/cycles-client.js';
import { ageText, completedAge } from './domain/personal-age.js';
import { updateReturnsEntry } from './views/returns-clock.js';
import { eligibleCycleChart, lifeTimelineForChart, cycleTimeZone } from './domain/cycles.js';
import { attachReturnMarkers } from './views/returns-markers.js';
import { returnsVisibleWindow } from './domain/returns-window.js';

// Composition root: each feature owns its state; these callbacks connect them.
export function startApp({ dayClient, layout, toast, viewStore, savedView }) {
  const $ = id => document.getElementById(id);
  attachTelegramGestures([$('canvasWrap'), $('transitTime'), $('natalDayTime'), $('lifetimeTime')]);
  const store = createChartStore({ onStorageError: toast });
  const headingLayout = createChartHeadingLayout({
    header: $('chartHeader'), title: $('chartTitle'), subtitle: $('chartSubtitle'), canvas: $('canvasWrap'),
    leftControls: document.querySelector('.topbar-leading'), rightControls: document.querySelector('.chart-tools'),
    getMandalaTop: () => $('canvasWrap').getBoundingClientRect().top + layout.mandalaTop,
  });
  let hoverPreview = null, chartSummary = null, mandalaMode = null, library = null, transit = null, transitControls = null, natalDay = null, lifetime = null;
  let viewSession = null, lifetimeLoading = null, lifetimeLoadFailed = false;
  let returns = null, returnsView = null, returnsViewLoading = null, returnMarkers = null;
  const returnsEntry = { footer: $('returnsControls'), entry: $('returnsToggle') };
  let exploration = null, timelineLayoutKey = '';
  const activationPopover = attachActivationPopover($('activationPopover'), $('bodygraph'));
  const transitPlanets = createTransitPlanetFilter();
  const session = createChartSession({ store, getTransit: () => transit, getNatalDay: () => natalDay,
    getLifetime: () => lifetime, getReturns: () => returns,
    filterTransit: transitPlanets.filter, onSelect: () => exploration?.selected(), onChange: updatePage });
  exploration = createChartExploration({ session, getTransit: () => transit, getNatalDay: () => natalDay,
    getLifetime: () => lifetime, getReturns: () => returns, loadLifetime,
    onTimelineReady: () => { layout.refresh(); gestures.resize(); updatePersonalTimeline(); },
    onModeChange: updatePersonalTimeline, onChange: () => viewSession?.schedule() });
  const currentChart = () => session.current;
  const lifetimeOwnsLoading = () => session.selectedId === 'current-transit' && Boolean(
    lifetime?.state.opened && lifetime.state.mode === 'lifetime' || viewSession?.pendingLifetime?.mode === 'lifetime');
  const chartLoading = attachChartLoading({
    canvas: $('canvasWrap'), drawing: $('bodygraph'), art: $('chartLoadingArt'),
    message: $('chartLoadingMessage'), status: $('chartLoadingStatus'), retry: $('chartLoadingRetry'), heading: $('chartHeader'),
    onRetry: () => {
      if (lifetimeOwnsLoading()) {
        if (lifetimeLoadFailed) window.location.reload();
        else void lifetime?.retry();
      } else void transit?.retry();
    },
  });
  const updateLoading = () => {
    const lifetimeLoading = lifetimeOwnsLoading(), state = lifetimeLoading ? lifetime?.state : transit?.state;
    chartLoading.update({ hasChart: session.hasCurrent,
      failed: lifetimeLoading ? lifetimeLoadFailed || state?.status === 'error' : state?.unavailable,
      loading: lifetimeLoading ? !lifetimeLoadFailed && (!state || state.status === 'loading') : state?.loading });
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
      library.close();
    },
  });
  const cameraChanged = createCameraChangeHandler({
    heading: $('chartHeader'), fitButton: $('fitButton'), studio: $('canvasWrap').parentElement, activationPopover,
    getHoverPreview: () => hoverPreview, getSummary: () => chartSummary,
  });
  const gestures = attachGestures($('bodygraph'), {
    cameraView: createCameraView({ svg: $('bodygraph'), surface: $('canvasWrap') }),
    fitInsets: () => layout.insets(),
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
    getFrame: () => mandalaMode?.frame,
    getHomeFrame: () => mandalaMode?.homeFrame,
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
  attachKnowledgeEntry({ button: $('openKnowledge'), dialog: $('knowledgeDialog'), onSelect: graph.choose,
    getSelection: () => graph.selectionState.primary, beforeOpen: () => library.close(), onError: toast });
  chartSummary = attachChartSummary({
    panel: $('chartSummary'), summaryScreen: $('summaryScreen'), returnsPanel: $('returnsPanel'), returnsEntry: $('returnsToggle'), content: $('chartSummaryContent'), overview: $('summaryOverview'),
    search: $('summarySearch'), switcher: $('summarySwitch'), backdrop: $('summaryBackdrop'),
    onSelect: graph.choose, onLines: graph.chooseSummary,
    onOpen: () => { returns?.close(); activationPopover.close(); hoverPreview?.clear(); library.close(); },
    onClose: () => returns?.close(),
  });
  const mandalaMotion = createMandalaMotion({
    viewport: $('viewport'), onUpdate: () => activationPopover.reposition(),
    onFinish: enabled => mandalaMode?.finishTransition(enabled),
  });
  mandalaMode = attachMandalaMode({
    button: $('mandalaSwitch'), canvas: $('canvasWrap'), gestures, render: graph.render,
    motion: mandalaMotion, layout, onStateChange: () => viewSession?.schedule(),
    beforeChange: () => { activationPopover.close(); hoverPreview?.clear({ notify: false }); },
  });
  library = attachChartLibrary({
    document, store, session, onSelect: graph.changeChart, onUpdate: updatePage,
    onEdit: id => birthForm.open(true, id), onNew: () => birthForm.open(),
    beforeOpen: () => { returns?.close(); chartSummary.close(); activationPopover.close(); hoverPreview?.clear(); },
  });
  const birthForm = attachBirthForm({
    document, store, session, toast,
    onSave: (id, { metadataOnly = false } = {}) => {
      if (metadataOnly && id === session.selectedId) session.refreshOriginal();
      else graph.changeChart(id);
    },
    beforeOpen: () => { returns?.close(); library.close(); chartSummary.close(); },
  });
  natalDay = attachNatalDayExplorer({
    toggle: $('natalDayToggle'), panel: $('natalDayControls'), range: $('natalDayTime'), marker: $('natalDayReference'),
    status: $('natalDayStatus'), retryButton: $('natalDayRetry'), hourMarks: $('natalDayHourMarks'),
    onMomentInput: () => viewSession?.interrupt(),
    onRender: exploration.publishDay, onStateChange: () => { updatePersonalTimeline(); viewSession?.schedule(); },
  });
  returnsEntry.entry.addEventListener('click', () => {
    if (returns.state.opened) { returns.close(); return; }
    library.close(); chartSummary.close(); activationPopover.close(); hoverPreview?.clear();
    void returns.open();
  });
  returnMarkers = attachReturnMarkers({ container: $('lifetimeTime').parentElement,
    onTargetsChange: () => lifetime?.refreshTargets(),
    onSelect: event => { viewSession?.interrupt(); return returns.selectEvent(event.id); } });
  returns = createReturnsController({
    client: createCyclesClient({ cacheVersion: document.body.dataset.cyclesVersion }),
    onRequest: exploration.requestReturn, onRender: exploration.publishReturn,
    onStateChange() {
      updatePersonalTimeline(); viewSession?.schedule();
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
      transitControls?.update(state); lifetime?.syncTransit(); updateLoading(); refreshTimelineLayout(); viewSession?.schedule();
      if (returns?.state.available) updateChartCaption();
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
    closeLibrary: library.close,
    onSelect: graph.changeChart, refresh: transit.refresh,
  });
  attachCameraControls({ fitButton: $('fitButton') }, gestures);
  attachPerformanceMonitor({
    document, button: $('togglePerformance'), panel: $('performancePanel'), drawing: $('bodygraph'), inputSurface: $('canvasWrap'),
    ranges: [$('transitTime'), $('natalDayTime'), $('lifetimeTime')],
    motionButtons: [$('fitButton'), $('mandalaSwitch'), $('transitReference'), $('natalDayReference')],
    initiallyEnabled: new URLSearchParams(location.search).get('fps') === '1',
    onToggle: () => library.close(),
  });

  function updateChartCaption() {
    const chart = currentChart();
    // The accepted composition describes the shown moment, even while another
    // source is loading. A pending owner must not change the natal caption.
    const caption = chartCaption(chart, session.original, false,
      { useUtc: session.shownSource === 'lifetime',
        showAge: Boolean(returns?.state.available),
        ageUtc: new Date().toISOString() });
    headingLayout.updateText(caption.title, caption.subtitle);
  }

  function refreshTimelineLayout() {
    if (!transitControls) return;
    const key = ['transitControls', 'natalDayControls', 'lifetimeControls', 'returnsControls']
      .map(id => $(id).hidden).concat($('lifetimeControls').dataset.personalLife).join(':');
    if (key === timelineLayoutKey) return;
    timelineLayoutKey = key;
    layout.refresh(); gestures.resize(); headingLayout.refresh();
  }

  function updatePage() {
    updatePersonalTimeline();
    if (!lifetime) $('lifetimeToggle').hidden = !(session.selectedId === 'current-transit' || returns?.state.available);
    library.render();
    graph.render();
    updateLoading();
    viewSession?.schedule();
  }

  returns.select(session.original);
  natalDay.select(session.original);
  updatePage();
  gestures.reset();
  let phoneLayout = layout.phone;
  let mandalaColumns = layout.showMandalaColumns;
  const resizeLayout = () => {
    layout.refresh();
    headingLayout.refresh();
    if (phoneLayout !== layout.phone || mandalaColumns !== layout.showMandalaColumns) {
      phoneLayout = layout.phone;
      mandalaColumns = layout.showMandalaColumns;
      activationPopover.close();
      hoverPreview?.clear({ notify: false });
      graph.render();
    }
    gestures.resize();
  };
  const layoutObserver = new ResizeObserver(resizeLayout);
  layoutObserver.observe($('canvasWrap'));
  if (!store.storageAvailable) toast('Хранилище браузера недоступно. Изменения не будут сохранены.');
  const savedChart = store.get(savedView?.selectedId);
  const savedLife = eligibleCycleChart(savedChart) && savedView?.lifetime?.opened ? lifeTimelineForChart(savedChart) : null;
  const restoreView = savedLife ? { ...savedView, lifetime: { ...savedView.lifetime, ...savedLife,
    minimumUtc: savedChart.utc, mode: 'lifetime', openEnded: false } } : savedView;
  viewSession = createViewSession({
    store: { read: () => restoreView, write: viewStore.write }, chartStore: store, session,
    mandala: mandalaMode, camera: gestures, transit, natalDay: natalDay, planetFilter: transitPlanets,
    getPersonalPreview: () => returns.state.available ? exploration.preview : undefined,
    getPersonalLive: () => returns.state.available ? exploration.live : undefined,
    restorePersonalPreview: exploration.restorePreview,
    restorePersonalLive: exploration.restoreLive,
    acceptLifetimeMode: exploration.acceptLifetimeMode,
    getReturns: () => returns, getLifetime: () => lifetime, loadLifetime,
    openReturnsTimeline: exploration.openTimeline, canRestoreLifetime: () => (session.selectedId === 'current-transit' || returns.state.available),
  });
  void viewSession.restore().catch(() => toast('Не удалось восстановить положение страницы.')).finally(() => {
    exploration.finishRestore({ saved: restoreView, interrupted: viewSession.interrupted,
      pendingLifetime: viewSession.pendingLifetime, pendingReturns: viewSession.pendingReturns });
  });

  function loadReturnsView() {
    if (returnsView) return Promise.resolve(returnsView);
    if (returnsViewLoading) return returnsViewLoading;
    returnsEntry.entry.setAttribute('aria-busy', 'true');
    returnsViewLoading = import('./views/returns-panel.js').then(({ attachReturnsPanel }) => {
      returnsView = attachReturnsPanel({ getLayout: () => layout.returnsLayout,
        document, onClose: () => chartSummary.close({ focus: true }), onBack: () => chartSummary.open(),
        onYear: value => returns.setYear(value),
        onBodies: value => returns.setBodies(value),
        onSelect: async value => { viewSession?.interrupt(); const selected = await returns.selectEvent(value); if (selected && returnsView.sheet()) returns.close(); },
        onBirth: () => { viewSession?.interrupt(); returns.setYear(null); exploration.resetMoment(); if (returnsView.sheet()) returns.close(); },
        onNow: () => { viewSession?.interrupt(); returns.setYear(null); if (exploration.followNow() && returnsView.sheet()) returns.close(); },
        onRetry: () => returns.retry(),
        onLayout: () => { layout.refresh(); gestures.resize(); headingLayout.refresh(); },
      });
      // Loading only supplies the view. The controller still owns whether its
      // drawer is open, including another click or navigation during the import.
      updatePersonalTimeline();
      return returnsView;
    }).catch(() => {
      if (returns.state.opened) { returns.close(); toast('Не удалось открыть возвраты. Попробуйте ещё раз.'); }
      return null;
    }).finally(() => { returnsViewLoading = null; returnsEntry.entry.removeAttribute('aria-busy'); });
    return returnsViewLoading;
  }

  function updatePersonalTimeline() {
    if (!returns) return;
    const state = returns.state, lifetimeState = lifetime?.state, metadata = lifetimeState?.metadata;
    const timelineVisible = Boolean(state.available && lifetimeState?.opened && lifetimeState.mode === 'lifetime' && !natalDay.state.opened);
    const heading = $('lifetimeControls').querySelector('.lifetime-heading');
    heading.hidden = state.available; heading.inert = state.available;
    $('lifetimeControls').dataset.personalLife = String(state.available);
    // The footer and source labels describe the same resolved chart as the scene.
    const chart = currentChart();
    const viewState = { ...state, timelineVisible,
      birthSelected: !exploration.live && chart.primary === session.original && !chart.secondary, live: exploration.live };
    updateReturnsEntry(returnsEntry, viewState);
    chartSummary.setReturnsVisible(Boolean(returnsView && timelineVisible && state.opened));
    if (returnsView) returnsView.update(viewState);
    else if (timelineVisible && state.opened) void loadReturnsView();
    const lifetimeToggle = $('lifetimeToggle');
    const reloadLabel = 'Обновить страницу и загрузить летопись';
    lifetimeToggle.title = lifetimeLoadFailed ? reloadLabel : state.available ? 'Возвраты' : 'Летопись';
    lifetimeToggle.setAttribute('aria-label', lifetimeLoadFailed ? reloadLabel : state.available ? 'Возвраты' : 'Летопись');
    lifetimeToggle.setAttribute('aria-controls', 'lifetimeControls');
    const enabled = state.available ? exploration?.returnsEnabled ?? timelineVisible
      : exploration?.transitEnabled ?? false;
    lifetimeToggle.setAttribute('aria-expanded', String(enabled));
    lifetimeToggle.setAttribute('aria-pressed', String(enabled));
    const valid = timelineVisible && metadata;
    const window = valid ? returnsVisibleWindow(state.natal, state.year, lifetimeState) : null;
    lifetime?.setVisibleWindow(window);
    returnMarkers?.update({ events: state.events, natal: state.natal, displayedUtc: chart?.utc,
      fromUtc: window?.minUtc ?? NaN,
      toUtc: window?.maxUtc ?? NaN,
      visible: Boolean(valid) });
    updateChartCaption();
    refreshTimelineLayout();
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
        const { attachLifetimeControls } = await import('./views/lifetime-controls.js');
        lifetime = attachLifetimeControls({
          dayClient,
          planetFilter: transitPlanets,
          available: session.selectedId === 'current-transit' || returns.state.available,
          getDayState: () => session.selectedId === 'current-transit' ? transit.state : null,
          getPersonalChart: () => returns.state.available ? returns.state.natal : null,
          formatEndpoints: state => {
            const natal = session.original;
            if (eligibleCycleChart(natal) && !natalDay.state.opened && Number.isInteger(returns.state.year)) {
              const visible = returnsVisibleWindow(natal, returns.state.year, state);
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
            if (returns.state.available) returns.setYear(null);
            if (!exploration.followNow()) return false;
            returns.close(); return true;
          },
          resolveTap: (event, metrics) => returnMarkers?.hitTest(event, metrics),
          beforeScrub: exploration.beforeScrub,
          onMomentInput: () => viewSession?.interrupt(),
          toggle: $('lifetimeToggle'), panel: $('lifetimeControls'), range: $('lifetimeTime'), marker: $('lifetimeReference'),
          status: $('lifetimeStatus'), hourMarks: $('lifetimeHourMarks'),
          fromDate: $('lifetimeFromDate'), toDate: $('lifetimeToDate'),
          fromError: $('lifetimeFromError'), toError: $('lifetimeToError'),
          fromCalendar: $('lifetimeFromCalendar'), toCalendar: $('lifetimeToCalendar'),
          retryButton: $('lifetimeRetry'),
          onRender: exploration.publishLifetime,
          onModeAccepted: exploration.acceptLifetimeMode,
          onStateChange(state) {
            transitControls.setCoveredByLifetime(state.opened || session.selectedId !== 'current-transit');
            viewSession?.schedule();
            exploration.lifetimeChanged(state);
            updatePersonalTimeline(); updateLoading();
          },
        });
        return lifetime;
      } catch {
        lifetimeLoadFailed = true; updateLoading(); updatePersonalTimeline();
        return null;
      } finally {
        lifetimeLoading = null;
        $('lifetimeToggle').removeAttribute('aria-busy');
      }
    })();
    return lifetimeLoading;
  }
  $('lifetimeToggle').addEventListener('click', () => {
    if (session.selectedId !== 'current-transit' && !returns.state.available) return;
    viewSession?.interrupt();
    library.close(); chartSummary.close(); activationPopover.close(); hoverPreview?.clear();
    if (lifetimeLoadFailed) { window.location.reload(); return; }
    if (session.selectedId === 'current-transit') {
      void exploration.toggleTransit();
    } else void exploration.toggleReturns();
  });
  for (const field of [$('lifetimeFromDate'), $('lifetimeToDate')]) {
    field.addEventListener('input', () => { viewSession?.interrupt(); exploration.invalidateTimeline(); }, true);
  }
}
