import { createSelectionModel } from '../selection/selection-model.js';
import { createSceneRenderer } from './renderer.js';
import { createMandalaPreviewPainter } from './mandala-preview-painter.js';

// Selection and redraw orchestration. Camera, persistence, dialogs and navigation
// stay with their adapters and connect through explicit callbacks.
export function createGraphController({
  selectionState = createSelectionModel(), getChart, hasChart = () => true,
  viewport, getActiveElement = () => null, activationPopover,
  getShowActivations = () => true,
  getHoverPreview = () => null, getSummary = () => null, getMandala = () => null,
  scene = createSceneRenderer(viewport),
  onChartChange = () => {},
}) {
  let popoverChart = null;
  const previewPainter = createMandalaPreviewPainter(viewport);
  let rendered = null;

  function render() {
    rendered = null;
    previewPainter.clear();
    const chart = getChart();
    selectionState.refresh?.(chart);
    const activationFilter = selectionState.activationFilter || null;
    getSummary()?.update(chart, { items: selectionState.items, filter: activationFilter });
    if (!hasChart()) { scene.clear(); activationPopover.close(); return; }
    const focused = getActiveElement()?.closest?.('#viewport [data-type]');
    const focusTarget = focused ? { type: focused.dataset.type, id: focused.dataset.id, activation: focused.dataset.activation, mandala: focused.classList.contains('mandala-gate') } : null;
    const renderOptions = {
      profile: 'studio',
      showActivations: getShowActivations(), showBackdrop: true, showMandala: getMandala()?.enabled,
      showMandalaLayer: getMandala()?.visible,
      pinnedCrosses: selectionState.crosses, selections: selectionState.items,
      previewSelection: getHoverPreview()?.currentSelection, activationFilter,
    };
    scene.update(chart, selectionState.primary, renderOptions);
    if (focusTarget && getActiveElement() !== focused) viewport.querySelector(focusTarget.activation ? `[data-activation="${focusTarget.activation}"]` : `${focusTarget.mandala ? '.mandala-gate' : '.bodygraph-drawing .bg-interactive'}[data-type="${focusTarget.type}"][data-id="${focusTarget.id}"]`)?.focus({ preventScroll: true });
    if (chart !== popoverChart) { activationPopover.refresh(chart); popoverChart = chart; }
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
    const numeric = value.type === 'gate' && value.activation && !value.additive;
    const selected = selectionState.items;
    const sameNumeric = numeric && selected.length === 1 && selected[0].type === 'gate'
      && Number(selected[0].id) === Number(value.id) && selected[0].activation === value.activation;
    const showDetails = sameNumeric && activationPopover.currentId !== value.activation;
    getHoverPreview()?.clear({ notify: false });
    activationPopover.close();
    // Every input selects the row first, inspects it second and clears it third.
    if (showDetails) {
      render();
      activationPopover.show(getChart(), value.activation);
      return;
    }
    selectionState.choose(value);
    if (value.pointerType && !selectionState.items.length) {
      const focused = getActiveElement()?.closest?.('#viewport [data-type]');
      const sameTarget = focused && (value.activation ? focused.dataset.activation === value.activation
        : focused.dataset.type === value.type && focused.dataset.id === String(value.id));
      // Release native pointer focus before rendering can restore it. Keyboard
      // focus remains on the control for the next Enter/Space activation.
      if (sameTarget) focused.blur?.();
    }
    render();
  }

  function chooseSummary(gates, filter, options = {}) {
    activationPopover.close();
    getHoverPreview()?.clear({ notify: false });
    selectionState.chooseSummary(gates, filter, options);
    render();
  }

  function reset() {
    rendered = null;
    popoverChart = null;
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
