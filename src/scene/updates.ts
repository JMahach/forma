import type { ChartView } from '../domain/chart-composition.ts';
import type { SelectionModel } from '../selection/selection-model.ts';
import type { attachHoverPreview } from '../selection/hover-preview.ts';
import type { SceneRenderer } from './renderer.ts';
import type { RenderOptions } from './render-state.ts';
interface GraphControllerOptions {
  selectionState?: SelectionModel;
  getChart: () => ChartView;
  hasChart?: () => boolean;
  viewport: Element;
  getActiveElement?: () => Element | null;
  activationPopover: { close: () => void; refresh: (chart: ChartView) => void; show: (chart: ChartView, id: string) => void; currentId: string | null };
  getShowActivations?: () => boolean;
  getHighlightStyle?: () => RenderOptions['highlightStyle'];
  getHoverPreview?: () => Pick<ReturnType<typeof attachHoverPreview>, 'clear' | 'currentSelection'> | null;
  getMandala?: () => { readonly enabled: boolean; readonly visible: boolean } | null;
  scene?: { update: (...args: Parameters<SceneRenderer['update']>) => void; clear: () => void };
  onChartChange?: (id: string) => void;
}
export type GraphController = ReturnType<typeof createGraphController>;

import { createSelectionModel } from '../selection/selection-model.ts';
import { createSceneRenderer } from './renderer.ts';
import { createMandalaPreviewPainter } from './mandala-preview-painter.ts';

// Selection and redraw orchestration. Camera, persistence, dialogs and navigation
// stay with their adapters and connect through explicit callbacks.
export function createGraphController({
  selectionState = createSelectionModel(), getChart, hasChart = () => true,
  viewport, getActiveElement = () => null, activationPopover,
  getShowActivations = () => true, getHighlightStyle = () => 'outline',
  getHoverPreview = () => null, getMandala = () => null,
  scene = createSceneRenderer(viewport),
  onChartChange = () => {},
}: GraphControllerOptions) {
  let popoverChart: ChartView | null = null;
  const previewPainter = createMandalaPreviewPainter(viewport);
  let rendered: { chart: ChartView; items: SelectionModel['items']; primary: SelectionModel['primary']; crosses: SelectionModel['crosses']; mandala: boolean } | null = null;

  function render() {
    rendered = null;
    previewPainter.clear();
    const chart = getChart();
    if (!hasChart()) { scene.clear(); activationPopover.close(); return; }
    const focused = getActiveElement()?.closest?.<HTMLElement | SVGElement>('#viewport [data-type]');
    const focusTarget = focused ? { type: focused.dataset.type, id: focused.dataset.id, activation: focused.dataset.activation, mandala: focused.classList.contains('mandala-gate') } : null;
    const renderOptions: RenderOptions = {
      profile: 'studio', highlightStyle: getHighlightStyle(),
      showActivations: getShowActivations(), showBackdrop: true, showMandala: getMandala()?.enabled,
      showMandalaLayer: getMandala()?.visible,
      pinnedCrosses: selectionState.crosses, selections: selectionState.items,
      previewSelection: getHoverPreview()?.currentSelection,
    };
    scene.update(chart, selectionState.primary, renderOptions);
    if (focusTarget && getActiveElement() !== focused) viewport.querySelector<HTMLElement | SVGElement>(focusTarget.activation ? `[data-activation="${focusTarget.activation}"]` : `${focusTarget.mandala ? '.mandala-gate' : '.bodygraph-drawing .bg-interactive'}[data-type="${focusTarget.type}"][data-id="${focusTarget.id}"]`)?.focus({ preventScroll: true });
    if (chart !== popoverChart) { activationPopover.refresh(chart); popoverChart = chart; }
    rendered = {
      chart, items: selectionState.items, primary: selectionState.primary,
      crosses: selectionState.crosses,
      mandala: Boolean(getMandala()?.enabled),
    };
    if (rendered.mandala) previewPainter.capture(getHoverPreview()?.currentSelection?.cross, selectionState.crosses);
  }

  // Hover within the same quartet does not change the chart, committed
  // selection or activation popover. Only its exact-angle marks move.
  function preview() {
    const current = getHoverPreview()?.currentSelection;
    if (rendered?.mandala && getMandala()?.enabled && hasChart()
      && rendered.chart === getChart() && rendered.items === selectionState.items
      && rendered.primary === selectionState.primary
      && rendered.crosses === selectionState.crosses && current?.type === 'mandala-cross'
      && previewPainter.update(current.cross, selectionState.crosses)) {
      return;
    }
    render();
  }

  function choose(value: Parameters<SelectionModel['choose']>[0]) {
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
      activationPopover.show(getChart(), value.activation!);
      return;
    }
    selectionState.choose(value);
    if (value.pointerType && !selectionState.items.length) {
      const focused = getActiveElement()?.closest?.<HTMLElement | SVGElement>('#viewport [data-type]');
      const sameTarget = focused && (value.activation ? focused.dataset.activation === value.activation
        : focused.dataset.type === value.type && focused.dataset.id === String(value.id));
      // Release native pointer focus before rendering can restore it. Keyboard
      // focus remains on the control for the next Enter/Space activation.
      if (sameTarget) focused.blur?.();
    }
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
    selectionState, render, preview, choose, reset,
    clear() { reset(); render(); },
    dispose() { reset(); scene.clear(); },
    changeChart(id: string) { reset(); onChartChange(id); },
  };
}
