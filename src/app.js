import { attachKnowledge } from './views/knowledge.js';
import { attachActivationPopover } from './views/activation-popover.js';
import { attachHoverPreview } from './selection/hover-preview.js';
import { attachGestures } from './scene/gestures.js';
import { createCameraView } from './scene/camera-view.js';
import { attachMandalaMode } from './scene/modes/mandala.js';
import { createMandalaMotion } from './scene/modes/mandala-motion.js';
import { createStudioLayout } from './scene/studio-controller.js';
import { mandalaPreviewFromPointer, mandalaPreviewFromFocus, mandalaSelectionFromTarget } from './scene/mandala-preview.js';
import { createGraphController } from './scene/updates.js';
import { attachCameraControls, createCameraChangeHandler } from './views/camera-controls.js';
import { createChartStore } from './data/chart-store.js';
import { createChartSession } from './state/chart-session.js';
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

// Composition root: each feature owns its state; these callbacks connect them.
const $ = id => document.getElementById(id);
attachTelegramGestures([$('canvasWrap'), $('transitTime'), $('chartDayTime')]);
const toast = createToast($('toast'));
const store = createChartStore({ onStorageError: toast });
const layout = createStudioLayout({ canvas: $('canvasWrap'), drawing: $('bodygraph'), panels: [$('transitControls'), $('chartDayControls')] });
const headingLayout = createChartHeadingLayout({
  header: $('chartHeader'), title: $('chartTitle'), subtitle: $('chartSubtitle'), canvas: $('canvasWrap'),
  leftControls: document.querySelector('.topbar-leading'), rightControls: document.querySelector('.chart-tools'),
  getMandalaTop: () => $('canvasWrap').getBoundingClientRect().top + layout.mandalaTop,
});
let hoverPreview = null, chartSummary = null, mandalaMode = null, library = null, transit = null, transitControls = null, chartDay = null;
const activationPopover = attachActivationPopover($('activationPopover'), $('bodygraph'));
const session = createChartSession({ store, getTransit: () => transit, getNatalDay: () => chartDay, onChange: updatePage });
const currentChart = () => session.current;

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
  onSelect: graph.choose,
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
  document, button: $('nowButton'), toast, isFormOpen: () => birthForm.opened,
  onRender: session.refresh, onStateChange: state => transitControls?.update(state),
});
transitControls = attachTransitControls({
  panel: $('transitControls'), range: $('transitTime'), marker: $('transitReference'), date: $('transitDate'), time: $('transitMoment'),
  status: $('transitStatus'), nowButton: $('transitNow'), onScrub: transit.scrub, onNow: transit.goNow,
});
transitControls.update(transit.state);
attachTransitNavigation($('nowButton'), {
  closeLibrary: library.close,
  onSelect: graph.changeChart, refresh: transit.refresh,
});
attachCameraControls({ fitButton: $('fitButton') }, gestures);
attachPerformanceMonitor({
  document, button: $('togglePerformance'), panel: $('performancePanel'), drawing: $('bodygraph'), inputSurface: $('canvasWrap'),
  ranges: [$('transitTime'), $('chartDayTime')],
  motionButtons: [$('fitButton'), $('mandalaSwitch'), $('transitReference'), $('chartDayReference')],
  initiallyEnabled: new URLSearchParams(location.search).get('fps') === '1',
  onToggle: () => library.close(),
});

function updateChartCaption() {
  const chart = currentChart();
  $('chartTitle').textContent = chartTitle(chart);
  $('chartSubtitle').textContent = chartSubtitle(chart);
  headingLayout.refresh();
}

function updatePage() {
  updateChartCaption();
  library.render();
  graph.render();
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
