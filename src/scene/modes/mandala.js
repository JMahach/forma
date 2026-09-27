import { CHART_FRAME, MANDALA_FRAME } from '../geometry/frames.js';

// Presentation state only: toggling never modifies a chart or its selection.
export function attachMandalaMode({ button, canvas, gestures, render, motion = null, layout = null, beforeChange = () => {} }) {
  let enabled = false, visible = false;
  function setEnabled(value) {
    if (enabled === value) return;
    beforeChange();
    enabled = value;
    // The outgoing ring is decorative immediately, and removed after its fade.
    visible = enabled || Boolean(motion);
    button.setAttribute('aria-checked', String(enabled));
    canvas.classList.toggle('has-mandala', enabled);
    render();
    // Reframe Home/navigation limits without moving the actual camera.
    gestures.refreshFrame();
    motion?.setExpanded(enabled);
  }
  button.addEventListener('click', () => setEnabled(!enabled));
  return {
    get enabled() { return enabled; }, get visible() { return visible; },
    get homeFrame() { return layout?.frame(enabled) || CHART_FRAME; },
    get frame() { return layout ? MANDALA_FRAME : (enabled ? MANDALA_FRAME : CHART_FRAME); },
    finishTransition(value) {
      if (value !== enabled || enabled || !visible) return;
      visible = false;
      render();
    },
  };
}
