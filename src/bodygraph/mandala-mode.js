import { DRAWING_BOUNDS } from './gestures.js';

export const MANDALA_FRAME = Object.freeze({
  bounds: Object.freeze({ x: -192, y: 10.2, width: 1024, height: 775.6 }), minScale: 0.1,
});
const CHART_FRAME = Object.freeze({ bounds: DRAWING_BOUNDS, minScale: 0.65 });

// Presentation state only: toggling never modifies a chart or its selection.
export function attachMandalaMode({ button, canvas, gestures, render, beforeChange = () => {} }) {
  let enabled = false, previousCamera = null, transitionTimer;
  function setEnabled(value) {
    if (enabled === value) return;
    beforeChange();
    if (value) previousCamera = { view: gestures.getView(), fitted: gestures.getFittedView() };
    enabled = value;
    button.setAttribute('aria-checked', String(enabled));
    canvas.classList.toggle('has-mandala', enabled);
    canvas.classList.add('mandala-transition');
    clearTimeout(transitionTimer);
    render();
    gestures.reset();
    if (!enabled && previousCamera) {
      const fitted = gestures.getFittedView(), ratio = fitted.k / previousCamera.fitted.k;
      gestures.setView({
        x: fitted.x + (previousCamera.view.x - previousCamera.fitted.x) * ratio,
        y: fitted.y + (previousCamera.view.y - previousCamera.fitted.y) * ratio,
        k: previousCamera.view.k * ratio,
      });
    }
    transitionTimer = setTimeout(() => canvas.classList.remove('mandala-transition'), 280);
  }
  button.addEventListener('click', () => setEnabled(!enabled));
  return { get enabled() { return enabled; }, get frame() { return enabled ? MANDALA_FRAME : CHART_FRAME; } };
}
