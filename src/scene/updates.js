import { alignPersonalityHeading } from './activation-columns.js';
import { createSelectionModel } from '../selection/selection-model.js';
import { createSceneRenderer } from './renderer.js';
import { createMandalaPreviewPainter } from './mandala-preview-painter.js';

// Selection and redraw orchestration. Camera, persistence, dialogs and navigation
// stay with their adapters and connect through explicit callbacks.
export function createGraphController({
  selectionState = createSelectionModel(), getChart, hasChart = () => true,
  viewport, getActiveElement = () => null, activationPopover,
  getShowActivations = () => true,
  getHoverPreview = () => null, getSummary = () => null, getMandala = () => null, getLotus = () => null,
  renderChart = null, alignHeading = alignPersonalityHeading,
  onChartChange = () => {},
}) {
  // A renderer can be supplied by export/preview harnesses. The interactive
  // application always owns a persistent scene.
  const scene = renderChart ? { update(chart, selection, options) { viewport.innerHTML = renderChart(chart, selection, options); }, clear() { viewport.innerHTML = ''; } } : createSceneRenderer(viewport);
  let summaryInput = null, popoverChart = null;
  const previewPainter = createMandalaPreviewPainter(viewport);
  let rendered = null;

  function render() {
    rendered = null;
    previewPainter.clear();
    const chart = getChart();
    selectionState.refresh?.(chart);
    const activationFilter = selectionState.activationFilter || null;
    const summaryKey = JSON.stringify([chart.id, chart.source, chart.personality, chart.design,
      ['design', 'personality'].map(source => chart.activations?.[source]?.map(a => [a.planet, a.gate, a.line])),
      selectionState.items, activationFilter]);
    if (summaryKey !== summaryInput) {
      getSummary()?.update(chart, { items: selectionState.items, filter: activationFilter });
      summaryInput = summaryKey;
      getSummary()?.layout();
    }
    if (!hasChart()) { scene.clear(); activationPopover.close(); return; }
    const focused = getActiveElement()?.closest?.('#viewport [data-type]');
    const focusTarget = focused ? { type: focused.dataset.type, id: focused.dataset.id, activation: focused.dataset.activation, mandala: focused.classList.contains('mandala-gate') } : null;
    const renderOptions = {
      showActivations: getShowActivations(), showBackdrop: true, showMandala: getMandala()?.enabled,
      showMandalaLayer: getMandala()?.visible,
      pinnedCrosses: selectionState.crosses, selections: selectionState.items,
      previewSelection: getHoverPreview()?.currentSelection, activationFilter,
    };
    if (getLotus()?.enabled) renderOptions.showLotus = true;
    scene.update(chart, selectionState.primary, renderOptions);
    if (renderChart) alignHeading(viewport);
    if (focusTarget && getActiveElement() !== focused) viewport.querySelector(focusTarget.activation ? `[data-activation="${focusTarget.activation}"]` : `${focusTarget.mandala ? '.mandala-gate' : '.bodygraph-drawing .bg-interactive'}[data-type="${focusTarget.type}"][data-id="${focusTarget.id}"]`)?.focus({ preventScroll: true });
    if (chart !== popoverChart || renderChart) { activationPopover.refresh(chart); popoverChart = chart; }
    rendered = {
      chart, items: selectionState.items, primary: selectionState.primary,
      filter: selectionState.activationFilter, crosses: selectionState.crosses,
      mandala: Boolean(getMandala()?.enabled),
    };
    if (rendered.mandala) previewPainter.capture(getHoverPreview()?.currentSelection?.cross, selectionState.crosses);
  }

  // Hover within the same quartet does not change the chart, committed
  // selection, summary or activation popover. Only its exact-angle marks move.
  function preview() {
    const current = getHoverPreview()?.currentSelection;
    if (rendered?.mandala && getMandala()?.enabled && hasChart()
      && rendered.chart === getChart() && rendered.items === selectionState.items
      && rendered.primary === selectionState.primary && rendered.filter === selectionState.activationFilter
      && rendered.crosses === selectionState.crosses && current?.type === 'mandala-cross'
      && previewPainter.update(current.cross, selectionState.crosses)) {
      return;
    }
    render();
  }

  function choose(value) {
    activationPopover.close();
    const { popoverActivation } = selectionState.choose(value);
    render();
    if (popoverActivation) activationPopover.show(getChart(), popoverActivation);
  }

  function chooseSummary(gates, filter, options = {}) {
    activationPopover.close();
    getHoverPreview()?.clear({ notify: false });
    selectionState.chooseSummary(gates, filter, options);
    render();
  }

  function reset() {
    rendered = null;
    summaryInput = null; popoverChart = null;
    previewPainter.clear();
    activationPopover.close();
    getHoverPreview()?.clear({ notify: false });
    selectionState.clear();
  }

  return {
    selectionState, render, preview, choose, chooseSummary, reset,
    clear() { reset(); render(); },
    changeChart(id) { reset(); onChartChange(id); },
  };
}
