import type { ChartView } from '../domain/chart-composition.ts';
import type { SelectionTarget } from '../selection/selection-targets.ts';
import type { RenderState, RenderOptions } from './render-state.ts';
export type SceneRenderer = ReturnType<typeof createSceneRenderer>;

import { renderBodygraphState } from './bodygraph-svg.ts';
import { createRenderState } from './render-state.ts';
import { createBodygraphPainter } from './bodygraph-painter.ts';
import { createMandalaPainter } from './mandala-painter.ts';
import { createActivationPainter } from './activation-painter.ts';
import { renderMandala } from './mandala.ts';
import { renderVariableArrows, visibleVariables } from './variable-arrows.ts';
import { renderChartBackdrop } from './backdrop.ts';
import { MANDALA_SCENE_TRANSFORM } from './geometry/mandala-geometry.ts';
import { setAttribute, svgNodes } from './svg-patches.ts';

const svgElement = (root: Element, name: string) => root.ownerDocument.createElementNS('http://www.w3.org/2000/svg', name);
const mandalaOptions = (state: RenderState, options: RenderOptions) => ({ interactive: state.interactive && Boolean(options.showMandala),
  selectedGates: state.committedGates, relatedGates: state.relatedGates, pinnedCrosses: options.pinnedCrosses,
  previewCross: options.previewSelection?.type === 'mandala-cross' ? options.previewSelection.cross : null });
const backdropSignature = (state: RenderState, options: RenderOptions) => JSON.stringify([Boolean(options.showMandala), Boolean(options.showBackdrop), state.prefix]);

// One SVG skeleton per view. Decorative modes leave all body layers in place;
// changing the minute only paints their current values.
export function createSceneRenderer(root: Element) {
  let body: ReturnType<typeof createBodygraphPainter> | null = null;
  let wheel: ReturnType<typeof createMandalaPainter> | null = null;
  let columns: ReturnType<typeof createActivationPainter> | null = null;
  let drawing: Element | null = null;
  let structure: string | null = null, backdropKey: string | undefined, variableKey: string | undefined;
  function mount(chart: ChartView, state: RenderState, options: RenderOptions) {
    body?.dispose();
    const variables = visibleVariables(chart, options);
    variableKey = JSON.stringify(variables);
    root.innerHTML = renderBodygraphState(chart, state, options, renderVariableArrows(chart, variables));
    drawing = root.querySelector('.bodygraph-drawing');
    body = createBodygraphPainter(root, state, options);
    wheel = createMandalaPainter(root);
    columns = createActivationPainter(root, { chart, state, options });
    backdropKey = backdropSignature(state, options);
  }
  function decorations(chart: ChartView, state: RenderState, options: RenderOptions) {
    const firstBodyLayer = drawing!.querySelector('.bodygraph-channels');
    setAttribute(drawing!, 'class', `bodygraph-drawing${options.showMandala ? ' mandala-drawing' : ''}`);
    const nextBackdrop = backdropSignature(state, options);
    if (backdropKey !== nextBackdrop) {
      drawing!.querySelector('.chart-backdrop')?.remove();
      drawing!.querySelector('.mandala-underlay')?.remove();
      if (options.showMandala || options.showBackdrop) {
        for (const node of svgNodes(drawing!, renderChartBackdrop(state.prefix, { mandala: options.showMandala }))) drawing!.insertBefore(node, firstBodyLayer);
      }
      backdropKey = nextBackdrop;
    }
    // Compare the domain result before formatting SVG; inputs may mutate in place.
    const variables = visibleVariables(chart, options), nextVariables = JSON.stringify(variables);
    if (nextVariables !== variableKey) {
      drawing!.querySelector('.bodygraph-variables')?.remove();
      for (const node of svgNodes(drawing!, renderVariableArrows(chart, variables))) drawing!.insertBefore(node, drawing!.querySelector('.chart-backdrop') || firstBodyLayer);
      variableKey = nextVariables;
    }
    let ring = root.querySelector('.mandala-scene');
    if (options.showMandala || options.showMandalaLayer) {
      if (!ring) {
        ring = svgElement(root, 'g');
        ring.setAttribute('class', 'mandala-scene');
        ring.setAttribute('transform', MANDALA_SCENE_TRANSFORM);
        ring.innerHTML = renderMandala(chart, mandalaOptions(state, options));
        root.insertBefore(ring, drawing);
      } else {
        // The new scaffold already contains this exact snapshot. The painter
        // adopts it on the next real update instead of preparing it twice.
        wheel!.update(chart, mandalaOptions(state, options));
      }
    } else if (ring) { ring.remove(); wheel!.reset(); }
  }
  return {
    update(chart: ChartView, selection?: SelectionTarget | null, options: RenderOptions = {}) {
      const nextStructure = JSON.stringify([options.profile, options.interactive !== false, options.idPrefix,
        options.showLabels === true, options.highlightStyle ?? 'outline']);
      const state = createRenderState(chart, selection, options);
      if (!body || structure !== nextStructure) {
        mount(chart, state, options); structure = nextStructure;
      } else {
        decorations(chart, state, options);
        body.update(state, options);
      }
      // Columns still perform the one real DOM measurement needed to align
      // their heading; the freshly mounted body, backdrop and wheel are ready.
      columns!.update(chart, state, options);
      return state;
    },
    clear() { body?.dispose(); root.replaceChildren(); body = wheel = columns = drawing = null; structure = null; backdropKey = variableKey = undefined; },
  };
}
