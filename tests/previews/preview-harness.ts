import { createGraphController } from '../../src/scene/updates.ts';
import { createSelectionState } from '../../src/selection/selection-state.ts';
import { attachActivationPopover } from '../../src/views/activation-popover.ts';
import { attachHoverPreview } from '../../src/selection/hover-preview.ts';
import { attachGestures } from '../../src/scene/gestures.ts';
import { createCameraView } from '../../src/scene/camera-view.ts';
import { createViewport } from '../../src/ui/layout/viewport.ts';

// A synthetic chart and its own controllers; no application globals, storage,
// calculation requests, or function extraction from app.ts.
export function mountPreview({ chart, controls }, { scene } = {}) {
  const element = (id: string) => document.getElementById(id);
  const svg = element('preview'), viewport = element('viewport');
  const viewportSubscribers = new Set();
  const environment = createViewport({ surface: element('previewSurface'), onChange: () => {
    for (const notify of [...viewportSubscribers] as const) notify();
  } });
  const viewportLayout = { readViewport: environment.read,
    subscribeViewport(callback: unknown) { viewportSubscribers.add(callback); return () => viewportSubscribers.delete(callback); },
  };
  const selectionState = createSelectionState();
  const activationPopover = attachActivationPopover(element('activationPopover'), svg, { viewportLayout });
  let hoverPreview = null;
  const graph = createGraphController({
    scene, selectionState, getChart: () => chart, viewport, activationPopover,
    getActiveElement: () => document.activeElement, getHoverPreview: () => hoverPreview,
  });
  const gestures = attachGestures(svg, {
    cameraView: createCameraView({ svg, surface: element('previewSurface') }),
    onSelect: graph.choose, onBackgroundTap: graph.clear,
    onChange: () => { hoverPreview?.clear(); activationPopover.reposition(); },
  });
  hoverPreview = attachHoverPreview(svg, { onPreview: graph.render });
  for (const control of controls) {
    element(control.id)!.addEventListener('click', () => {
      if (control.action === 'hover') {
        const target = svg!.querySelector(control.selector);
        if (!target) throw new Error(`Missing preview target: ${control.selector}`);
        target.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerType: 'mouse', buttons: 0 }));
      } else if (control.action === 'select') graph.choose(control.selection);
      else if (control.action === 'home') gestures.reset();
      else if (control.action === 'leave') hoverPreview.clear();
    });
  }
  window.addEventListener('resize', () => gestures.resize());
  graph.render();
  return { choose: graph.choose, clearSelection: graph.clear, selectionState, activationPopover, hoverPreview, gestures };
}
