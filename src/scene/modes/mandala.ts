import type { CameraFrame } from '../geometry/frames.ts';
import type { Camera } from '../camera.ts';
import type { createMandalaMotion } from './mandala-motion.ts';
import {createResourceScope} from '../../runtime/resource-scope.ts';
interface MandalaModeOptions {
  button: HTMLElement;
  canvas: Element;
  gestures: Pick<Camera, 'refreshFrame'>;
  render: () => void;
  motion?: ReturnType<typeof createMandalaMotion> | null;
  layout?: { frame: () => CameraFrame } | null;
  beforeChange?: () => void;
  onStateChange?: (enabled: boolean) => void;
}
export type MandalaMode = ReturnType<typeof attachMandalaMode>;

import { CHART_FRAME, MANDALA_FRAME } from '../geometry/frames.ts';

// Presentation state only: toggling never modifies a chart or its selection.
export function attachMandalaMode({ button, canvas, gestures, render, motion = null, layout = null, beforeChange = () => {}, onStateChange = () => {} }: MandalaModeOptions) {
  const scope=createResourceScope();
  let enabled = false, visible = false;
  function setEnabled(value: boolean, { animate = true } = {}) {
    if(scope.stopped)return;
    if (typeof value !== 'boolean') return;
    if (enabled === value) return;
    beforeChange();
    enabled = value;
    // The outgoing ring is decorative immediately, and removed after its fade.
    visible = enabled || Boolean(motion);
    button.setAttribute('aria-checked', String(enabled));
    canvas.classList.toggle('has-mandala', enabled);
    render();
    // Studio keeps one frame; resize refreshes it separately.
    if (!layout) gestures.refreshFrame();
    motion?.setExpanded(enabled, { animate });
    onStateChange(enabled);
  }
  button.addEventListener('click', () => setEnabled(!enabled), {signal:scope.signal});
  return {
    dispose:scope.stop, setEnabled,
    get enabled() { return enabled; }, get visible() { return visible; },
    get homeFrame() { return layout?.frame() || CHART_FRAME; },
    get frame() { return layout ? MANDALA_FRAME : (enabled ? MANDALA_FRAME : CHART_FRAME); },
    finishTransition(value: boolean) {
      if (scope.stopped || value !== enabled || enabled || !visible) return;
      visible = false;
      render();
    },
  };
}
