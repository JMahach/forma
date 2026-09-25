import { renderBodygraph } from './bodygraph.js';
import { alignPersonalityHeading } from '../activations/activations.js';
import { createMandalaSelectionState } from '../selection/mandala-selection-state.js';
import { createMandalaPreviewPainter } from './mandala-preview-painter.js';

// Selection and redraw orchestration. Camera, persistence, dialogs and navigation
// stay with their adapters and connect through explicit callbacks.
export function createGraphController({
  selectionState = createMandalaSelectionState(), getChart, hasChart = () => true,
  viewport, getActiveElement = () => null, activationPopover,
  getHoverPreview = () => null, getSummary = () => null, getMandala = () => null,
  renderChart = renderBodygraph, alignHeading = alignPersonalityHeading,
  onChartChange = () => {},
}) {
  const previewPainter = createMandalaPreviewPainter(viewport);
  let rendered = null;

  function render() {
    rendered = null;
    previewPainter.clear();
    const chart = getChart();
    selectionState.refresh?.(chart);
    const activationFilter = selectionState.activationFilter || null;
    getSummary()?.update(chart, { items: selectionState.items, filter: activationFilter });
    if (!hasChart()) { viewport.innerHTML = ''; activationPopover.close(); return; }
    const focused = getActiveElement()?.closest?.('#viewport [data-type]');
    const focusTarget = focused ? { type: focused.dataset.type, id: focused.dataset.id, activation: focused.dataset.activation, mandala: focused.classList.contains('mandala-gate') } : null;
    viewport.innerHTML = renderChart(chart, selectionState.primary, {
      showActivations: true, showBackdrop: true, showMandala: getMandala()?.enabled,
      pinnedCrosses: selectionState.crosses, selections: selectionState.items,
      previewSelection: getHoverPreview()?.currentSelection, activationFilter,
    });
    alignHeading(viewport);
    getSummary()?.layout();
    if (focusTarget) viewport.querySelector(focusTarget.activation ? `[data-activation="${focusTarget.activation}"]` : `${focusTarget.mandala ? '.mandala-gate' : '.bodygraph-drawing .bg-interactive'}[data-type="${focusTarget.type}"][data-id="${focusTarget.id}"]`)?.focus({ preventScroll: true });
    activationPopover.refresh(chart);
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
