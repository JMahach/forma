import { attachKnowledge } from './views/knowledge.js';
import { attachActivationPopover } from './views/activation-popover.js';
import { attachHoverPreview } from './selection/hover-preview.js';
import { attachGestures } from './scene/gestures.js';
import { createCameraView } from './scene/camera-view.js';
import { attachMandalaMode } from './scene/modes/mandala.js';
import { createMandalaMotion } from './scene/modes/mandala-motion.js';
import { mandalaPreviewFromPointer, mandalaPreviewFromFocus, mandalaSelectionFromTarget } from './scene/mandala-preview.js';
import { createGraphController } from './scene/updates.js';
import { attachCameraControls, createCameraChangeHandler } from './views/camera-controls.js';
import { createChartStore } from './data/chart-store.js';
import { createChartSession } from './state/chart-session.js';
import { createTransitPlanetFilter } from './state/transit-planets.js';
import { chartTitle, chartSubtitle } from './views/chart-display.js';
import { createChartHeadingLayout } from './views/chart-heading-layout.js';
import { attachChartLibrary } from './views/library.js';
import { attachBirthForm } from './views/birth-form.js';
import { attachLiveTransit, attachTransitNavigation } from './views/live-transit.js';
import { attachTransitControls } from './views/transit-controls.js';
import { attachChartDayExplorer } from './views/natal-day-controls.js';
import { attachChartSummary } from './views/chart-summary-panel.js';
import { createToast } from './ui/toast.js';
import { attachTelegramGestures } from './ui/telegram-gestures.js';
import { attachPerformanceMonitor } from './views/performance-monitor.js';
import { attachChartLoading } from './views/chart-loading.js';

// Composition root: each feature owns its state; these callbacks connect them.
export function startApp({ dayClient, layout }) {
  const $ = id => document.getElementById(id);
  const lifetimeEnabled = document.body.dataset.lifetimeEnabled === 'true';
  attachTelegramGestures([$('canvasWrap'), $('transitTime'), $('chartDayTime'), $('lifetimeTime')]);
  const toast = createToast($('toast'));
  const store = createChartStore({ onStorageError: toast });
  const headingLayout = createChartHeadingLayout({
    header: $('chartHeader'), title: $('chartTitle'), subtitle: $('chartSubtitle'), canvas: $('canvasWrap'),
    leftControls: document.querySelector('.topbar-leading'), rightControls: document.querySelector('.chart-tools'),
    getMandalaTop: () => $('canvasWrap').getBoundingClientRect().top + layout.mandalaTop,
  });
  let hoverPreview = null, chartSummary = null, mandalaMode = null, library = null, transit = null, transitControls = null, chartDay = null, lifetime = null;
  const activationPopover = attachActivationPopover($('activationPopover'), $('bodygraph'));
  const transitPlanets = createTransitPlanetFilter();
  const session = createChartSession({ store, getTransit: () => transit, getNatalDay: () => chartDay, getLifetime: () => lifetime,
    filterTransit: transitPlanets.filter, onChange: updatePage });
  const currentChart = () => session.current;
  const chartLoading = attachChartLoading({
    canvas: $('canvasWrap'), drawing: $('bodygraph'), art: $('chartLoadingArt'),
    message: $('chartLoadingMessage'), status: $('chartLoadingStatus'), retry: $('chartLoadingRetry'), heading: $('chartHeader'),
    onRetry: () => transit?.refresh(true),
  });
  const updateLoading = (state = transit?.state) => chartLoading.update({
    hasChart: session.hasCurrent, failed: state?.unavailable, loading: state?.loading,
  });

  const graph = createGraphController({
    getChart: currentChart, hasChart: () => session.hasCurrent,
    viewport: $('viewport'),
    getActiveElement: () => document.activeElement, activationPopover,
    getShowActivations: () => !(mandalaMode?.enabled && !layout.showMandalaColumns),
    getHoverPreview: () => hoverPreview, getSummary: () => chartSummary, getMandala: () => mandalaMode,
    onChartChange(id) {
      session.select(id);
      library.close();
    },
  });
  const gestures = attachGestures($('bodygraph'), {
    cameraView: createCameraView({ svg: $('bodygraph'), surface: $('canvasWrap') }),
    fitInsets: () => layout.insets(),
    onSelect(selection) {
      if (selection.type !== 'planet-filter') { graph.choose(selection); return; }
      if (session.selectedId !== 'current-transit') return;
      const [source, planet] = selection.id.startsWith('design:') ? selection.id.split(':') : ['personality', selection.id];
      if (planet === 'all') transitPlanets.toggleAllPlanets(source);
      else transitPlanets.togglePlanet(planet, source);
      session.refresh();
    },
    getFrame: () => mandalaMode?.frame,
    getHomeFrame: () => mandalaMode?.homeFrame,
    resolveSelection: (target, event) => mandalaSelectionFromTarget(event, target, hoverPreview?.currentSelection),
    onBackgroundTap: graph.clear,
    onChange: createCameraChangeHandler({
      heading: $('chartHeader'), fitButton: $('fitButton'),
      activationPopover,
      getHoverPreview: () => hoverPreview, getSummary: () => chartSummary,
    }),
  });
  hoverPreview = attachHoverPreview($('bodygraph'), {
    resolvePreview: mandalaPreviewFromPointer, resolveKeyboard: mandalaPreviewFromFocus,
    coalesceMandala: true, onPreview: graph.preview,
  });
  const knowledge = attachKnowledge($('knowledgeDialog'), graph.choose);
  $('openKnowledge').addEventListener('click', () => { library.close(); knowledge.show(graph.selectionState.primary); });
  chartSummary = attachChartSummary({
    panel: $('chartSummary'), content: $('chartSummaryContent'), overview: $('summaryOverview'),
    search: $('summarySearch'), switcher: $('summarySwitch'), backdrop: $('summaryBackdrop'),
    onSelect: graph.choose, onLines: graph.chooseSummary,
    onOpen: () => { activationPopover.close(); hoverPreview?.clear(); library.close(); },
  });
  const mandalaMotion = createMandalaMotion({
    viewport: $('viewport'), onUpdate: () => activationPopover.reposition(),
    onFinish: enabled => mandalaMode?.finishTransition(enabled),
  });
  mandalaMode = attachMandalaMode({
    button: $('mandalaSwitch'), canvas: $('canvasWrap'), gestures, render: graph.render,
    motion: mandalaMotion, layout,
    beforeChange: () => { activationPopover.close(); hoverPreview?.clear({ notify: false }); },
  });
  library = attachChartLibrary({
    document, store, session, toast, onSelect: graph.changeChart, onUpdate: updatePage,
    onEdit: id => birthForm.open(true, id), onNew: () => birthForm.open(),
    beforeOpen: () => { chartSummary.close(); activationPopover.close(); hoverPreview?.clear(); },
  });
  const birthForm = attachBirthForm({
    document, store, session, toast, onSave: graph.changeChart,
    beforeOpen: () => { chartDay?.close(); library.close(); chartSummary.close(); },
  });
  chartDay = attachChartDayExplorer({
    toggle: $('chartDayToggle'), panel: $('chartDayControls'), range: $('chartDayTime'), marker: $('chartDayReference'),
    date: $('chartDayDate'), time: $('chartDayMoment'), status: $('chartDayStatus'), resetButton: $('chartDayReset'),
    onRender: session.refresh,
  });
  transit = attachLiveTransit({
    document, button: $('nowButton'), dayClient, isFormOpen: () => birthForm.opened,
    onRender: session.refresh, onStateChange: state => { transitControls?.update(state); lifetime?.refreshDay(); lifetime?.syncClock(); updateLoading(state); },
  });
  transitControls = attachTransitControls({
    panel: $('transitControls'), range: $('transitTime'), marker: $('transitReference'), date: $('transitDate'), time: $('transitMoment'),
    status: $('transitStatus'), nowButton: $('transitNow'), onScrub: transit.scrub, onNow: transit.goNow,
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
    ranges: [$('transitTime'), $('chartDayTime'), $('lifetimeTime')],
    motionButtons: [$('fitButton'), $('mandalaSwitch'), $('transitReference'), $('chartDayReference')],
    initiallyEnabled: new URLSearchParams(location.search).get('fps') === '1',
    onToggle: () => library.close(),
  });

  function updateChartCaption() {
    const chart = currentChart();
    headingLayout.updateText(chartTitle(chart), chartSubtitle(chart));
  }

  function updatePage() {
    lifetime?.setAvailable(session.selectedId === 'current-transit');
    lifetime?.syncDay();
    if (!lifetime) $('lifetimeToggle').hidden = !lifetimeEnabled || session.selectedId !== 'current-transit';
    updateChartCaption();
    library.render();
    graph.render();
    updateLoading();
  }

  chartDay.select(session.original);
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
  transit.start();

  // Keep the entry visible independently of its optional module. A failed
  // download must not silently remove the feature from a phone's toolbar.
  if (lifetimeEnabled) {
    let loading = false, loadFailed = false;
    $('lifetimeToggle').addEventListener('click', async () => {
      if (lifetime || loading || session.selectedId !== 'current-transit') return;
      // Browsers cache a failed module import for this document. A deliberate
      // second press reloads the page instead of repeating the cached failure.
      if (loadFailed) { window.location.reload(); return; }
      loading = true;
      $('lifetimeToggle').setAttribute('aria-busy', 'true');
      try {
        const { attachLifetimeControls } = await import('./views/lifetime-controls.js');
        let wasOpen = false, previousMode = 'day';
        lifetime = attachLifetimeControls({
          dayClient,
          planetFilter: transitPlanets,
          available: session.selectedId === 'current-transit',
          getDayState: () => transit.state,
          onDayScrub: transit.scrub, onDayNow: transit.goNow,
          toggle: $('lifetimeToggle'), panel: $('lifetimeControls'), range: $('lifetimeTime'), marker: $('lifetimeReference'),
          date: $('lifetimeDate'), time: $('lifetimeMoment'), status: $('lifetimeStatus'),
          fromDate: $('lifetimeFromDate'), toDate: $('lifetimeToDate'),
          fromCalendar: $('lifetimeFromCalendar'), toCalendar: $('lifetimeToCalendar'),
          retryButton: $('lifetimeRetry'),
          onRender: session.refresh,
          onStateChange(state) {
            transitControls.setCoveredByYears(state.opened);
            if (state.opened === wasOpen && state.mode === previousMode) return;
            const opening = state.opened && !wasOpen;
            wasOpen = state.opened; previousMode = state.mode;
            if (opening) {
              chartDay.close(); library.close(); chartSummary.close();
              activationPopover.close(); hoverPreview?.clear();
            }
            const wanted = session.selectedId === 'current-transit' && (!state.opened || state.mode === 'day');
            if (transit.state.wanted !== wanted) transit.setWanted(wanted);
          },
        });
        $('chartDayToggle').addEventListener('click', () => lifetime.close(), true);
        if (session.selectedId === 'current-transit') lifetime.open();
      } catch {
        loadFailed = true;
        $('lifetimeToggle').title = 'Обновить страницу и загрузить годы';
      } finally {
        loading = false;
        $('lifetimeToggle').removeAttribute('aria-busy');
      }
    });
  }
}
