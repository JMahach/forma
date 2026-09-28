import { renderBodygraphState } from './bodygraph-svg.js';
import { createRenderState } from './render-state.js';
import { createBodygraphPainter } from './bodygraph-painter.js';
import { createMandalaPainter } from './mandala-painter.js';
import { createActivationPainter } from './activation-painter.js';
import { renderMandala } from './mandala.js';
import { renderVariableArrows } from './variable-arrows.js';
import { renderChartBackdrop } from './backdrop.js';
import { MANDALA_SCENE_SCALE } from './geometry/mandala-geometry.js';
import { setAttribute, svgNodes } from './svg-patches.js';

const svgElement = (root, name) => root.ownerDocument.createElementNS('http://www.w3.org/2000/svg', name);
const mandalaOptions = (state, options) => ({ interactive: state.interactive && Boolean(options.showMandala),
  selectedGates: state.committedGates, relatedGates: state.relatedGates, pinnedCrosses: options.pinnedCrosses,
  previewCross: options.previewSelection?.type === 'mandala-cross' ? options.previewSelection.cross : null });
const backdropSignature = (state, options) => JSON.stringify([Boolean(options.showMandala), Boolean(options.showBackdrop), Boolean(options.showLotus), state.prefix]);
const variableArrows = (chart, options) => options.showActivations && !options.showMandala ? renderVariableArrows(chart) : '';

// One SVG skeleton per view. Switching decorative modes moves existing body
// layers; changing the minute only paints their current values.
export function createSceneRenderer(root) {
  let body = null, wheel = null, columns = null, drawing = null;
  let structure = null, backdropKey, variableMarkup;
  function mount(chart, state, options) {
    variableMarkup = variableArrows(chart, options);
    root.innerHTML = renderBodygraphState(chart, state, options, variableMarkup);
    drawing = root.querySelector('.bodygraph-drawing');
    body = createBodygraphPainter(root, state, options);
    wheel = createMandalaPainter(root);
    columns = createActivationPainter(root);
    backdropKey = backdropSignature(state, options);
  }
  function decorations(chart, state, options) {
    let core = drawing.querySelector('.mandala-core');
    const layers = ['.bodygraph-channels', '.bodygraph-centers', '.bodygraph-gates'].map(selector => drawing.querySelector(selector)).filter(Boolean);
    if (options.showMandala && !core) {
      core = svgElement(root, 'g'); core.setAttribute('class', 'mandala-core');
      drawing.insertBefore(core, layers[0]);
      for (const layer of layers) core.append(layer);
    } else if (!options.showMandala && core) {
      for (const layer of layers) drawing.insertBefore(layer, core);
      core.remove(); core = null;
    }
    setAttribute(drawing, 'class', `bodygraph-drawing${options.showMandala ? ' mandala-drawing' : ''}`);
    const nextBackdrop = backdropSignature(state, options);
    if (backdropKey !== nextBackdrop) {
      drawing.querySelector('.chart-backdrop')?.remove();
      drawing.querySelector('.mandala-underlay')?.remove();
      if (options.showMandala || options.showBackdrop) {
        const parent = core || drawing;
        for (const node of svgNodes(parent, renderChartBackdrop(state.prefix, { mandala: options.showMandala, lotus: options.showLotus }))) parent.insertBefore(node, layers[0]);
      }
      backdropKey = nextBackdrop;
    }
    const variables = variableArrows(chart, options);
    if (variables !== variableMarkup) {
      drawing.querySelector('.bodygraph-variables')?.remove();
      for (const node of svgNodes(drawing, variables)) drawing.insertBefore(node, core || drawing.querySelector('.chart-backdrop') || layers[0]);
      variableMarkup = variables;
    }
    let ring = root.querySelector('.mandala-scene');
    if (options.showMandala || options.showMandalaLayer) {
      if (!ring) {
        ring = svgElement(root, 'g');
        ring.setAttribute('class', 'mandala-scene');
        ring.setAttribute('transform', `translate(320 398) scale(${MANDALA_SCENE_SCALE}) translate(-320 -398)`);
        ring.innerHTML = renderMandala(chart, mandalaOptions(state, options));
        root.insertBefore(ring, drawing);
      }
      wheel.update(chart, mandalaOptions(state, options));
    } else if (ring) { ring.remove(); wheel.reset(); }
  }
  return {
    update(chart, selection, options = {}) {
      const nextStructure = JSON.stringify([options.interactive !== false, options.idPrefix,
        options.showLabels === true]);
      const state = createRenderState(chart, selection, options);
      if (!body || structure !== nextStructure) {
        mount(chart, state, options); structure = nextStructure;
      } else {
        decorations(chart, state, options);
        body.update(state, options);
      }
      // Columns still perform the one real DOM measurement needed to align
      // their heading; the freshly mounted body, backdrop and wheel are ready.
      columns.update(chart, state, options);
      return state;
    },
    clear() { root.replaceChildren(); body = wheel = columns = drawing = null; structure = null; },
  };
}
