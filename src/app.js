import { attachKnowledge } from './library/knowledge.js';
import { attachActivationPopover } from './activations/activation-popover.js';
import { attachHoverPreview } from './selection/hover-preview.js';
import { attachGestures } from './bodygraph/gestures.js';
import { attachMandalaMode } from './bodygraph/mandala-mode.js';
import { attachLotusMode } from './bodygraph/lotus-mode.js';
import { createMandalaMotion } from './bodygraph/mandala-motion.js';
import { createStudioLayout } from './bodygraph/studio-layout.js';
import { mandalaPreviewFromPointer, mandalaPreviewFromFocus, mandalaSelectionFromTarget } from './bodygraph/mandala-preview.js';
import { createGraphController } from './bodygraph/graph-controller.js';
import { attachCameraControls, createCameraChangeHandler, createCanvasInsetsReader } from './bodygraph/camera-controls.js';
import { createChartStore } from './charts/chart-store.js';
import { chartTitle, chartSubtitle } from './charts/chart-display.js';
import { createChartHeadingLayout } from './charts/chart-heading-layout.js';
import { attachChartLibrary } from './charts/chart-library.js';
import { attachBirthForm } from './charts/birth-form.js';
import { createLiveTransit, attachTransitNavigation } from './charts/live-transit.js';
import { attachTransitControls } from './charts/transit-controls.js';
import { attachChartDayExplorer } from './charts/chart-day-explorer.js';
import { attachChartSummary } from './charts/chart-summary-panel.js';
import { createToast } from './ui/toast.js';
import { attachTelegramGestures } from './ui/telegram-gestures.js';

// Composition root: each feature owns its state; these callbacks connect them.
const $ = id => document.getElementById(id);
attachTelegramGestures([$('bodygraph'), $('transitTime'), $('chartDayTime')]);
const toast = createToast($('toast'));
const store = createChartStore({ onStorageError: toast });
const layout = createStudioLayout({ canvas: $('canvasWrap'), drawing: $('bodygraph'), panels: [$('transitControls'), $('chartDayControls')] });
const headingLayout = createChartHeadingLayout({
  header: $('chartHeader'), title: $('chartTitle'), subtitle: $('chartSubtitle'), canvas: $('canvasWrap'),
  leftControls: document.querySelector('.topbar-leading'), rightControls: document.querySelector('.chart-tools'),
  getMandalaTop: () => $('canvasWrap').getBoundingClientRect().top + layout.mandalaTop,
});
const readCanvasInsets = createCanvasInsetsReader($('canvasWrap'));
let hoverPreview = null, chartSummary = null, mandalaMode = null, lotusMode = null, library = null, transit = null, transitControls = null, chartDay = null;
const activationPopover = attachActivationPopover($('activationPopover'), $('bodygraph'));
const currentChart = () => store.selectedId === 'current-transit' ? transit?.current || store.current : chartDay?.current || store.current;

const graph = createGraphController({
  getChart: currentChart, hasChart: () => store.selectedId === 'current-transit' && Boolean(transit?.current) || store.has(store.selectedId),
  viewport: $('viewport'),
  getActiveElement: () => document.activeElement, activationPopover,
  getShowActivations: () => !(mandalaMode?.enabled && !layout.showMandalaColumns),
  getHoverPreview: () => hoverPreview, getSummary: () => chartSummary, getMandala: () => mandalaMode,
  getLotus: () => lotusMode,
  onChartChange(id) {
    chartDay?.close();
    store.select(id);
    chartDay?.select(store.current);
    transit?.setWanted(id === 'current-transit');
    // Chart content changes; the shared camera does not.
    updatePage();
    library.close();
  },
});
const gestures = attachGestures($('bodygraph'), $('viewport'), {
  fitInsets: () => layout.insets(readCanvasInsets()),
  onSelect: graph.choose,
  getFrame: () => mandalaMode?.frame,
  getHomeFrame: () => mandalaMode?.homeFrame,
  resolveSelection: (target, event) => mandalaSelectionFromTarget(event, target, hoverPreview?.currentSelection),
  onBackgroundTap: graph.clear,
  onChange: createCameraChangeHandler({
    heading: $('chartHeader'), fitButton: $('fitButton'),
    activationPopover,
    getHoverPreview: () => hoverPreview, getSummary: () => chartSummary,
    getMandala: () => mandalaMode,
    // CSS hides only a caption that actually overlaps the mandala field.
    showMandalaHeading: () => true,
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
  search: $('summarySearch'), switcher: $('summarySwitch'), canvas: $('canvasWrap'), backdrop: $('summaryBackdrop'),
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
lotusMode = attachLotusMode({ button: $('lotusSwitch'), render: graph.render });
library = attachChartLibrary({
  document, store, toast, onSelect: graph.changeChart, onUpdate: updatePage,
  onEdit: id => birthForm.open(true, id), onNew: () => birthForm.open(),
  beforeOpen: () => { chartSummary.close(); activationPopover.close(); hoverPreview?.clear(); },
});
const birthForm = attachBirthForm({
  document, store, toast, onSave: graph.changeChart,
  beforeOpen: () => { chartDay?.close(); library.close(); chartSummary.close(); },
});
chartDay = attachChartDayExplorer({
  toggle: $('chartDayToggle'), panel: $('chartDayControls'), range: $('chartDayTime'), marker: $('chartDayReference'),
  date: $('chartDayDate'), time: $('chartDayMoment'), status: $('chartDayStatus'), resetButton: $('chartDayReset'),
  onRender: () => { updateChartCaption(); graph.render(); },
});
transit = createLiveTransit({
  document, button: $('nowButton'), toast, isFormOpen: () => birthForm.opened,
  onRender: graph.render, onStateChange: state => transitControls?.update(state),
  onMoment: updateChartCaption,
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

function updateChartCaption() {
  const chart = currentChart();
  $('chartTitle').textContent = chartTitle(chart);
  $('chartSubtitle').textContent = chartSubtitle(chart);
  headingLayout.refresh();
}

function updatePage() {
  chartDay?.select(store.current);
  updateChartCaption();
  library.render();
  graph.render();
}

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
layoutObserver.observe($('bodygraph'));
if (!store.storageAvailable) toast('Хранилище браузера недоступно. Изменения не будут сохранены.');
transit.start();
