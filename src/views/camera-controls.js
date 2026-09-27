import { isHomeView } from '../scene/camera.js';

// CSS owns responsive chrome spacing. Home reads its resolved safe area rather
// than cutting the interactive canvas into a smaller rectangle.
export function createCanvasInsetsReader(canvas, readStyle = element => getComputedStyle(element)) {
  return () => {
    const style = readStyle(canvas);
    return { side: parseFloat(style.scrollPaddingLeft) || 20,
      top: parseFloat(style.scrollPaddingTop) || 12,
      bottom: parseFloat(style.scrollPaddingBottom) || 12 };
  };
}

export function createCameraChangeHandler({ heading, fitButton, zoomValue, zoomOut, getHoverPreview = () => null, activationPopover, getSummary = () => null, getMandala = () => null, showMandalaHeading = () => false }) {
  return (view, fitted, { minScale = fitted.k } = {}) => {
    // A mode can retain a camera below or away from its new Home target.
    // Home availability follows that target; zoom-out follows navigation limits.
    const sameScale = Math.abs(view.k - fitted.k) <= fitted.k * 1e-9;
    const home = isHomeView(view, fitted);
    if (heading) heading.hidden = !home || Boolean(getMandala()?.enabled && !showMandalaHeading());
    if (fitButton) fitButton.hidden = home;
    if (zoomValue) zoomValue.textContent = `${sameScale ? 100 : view.k > fitted.k ? Math.max(101, Math.round(view.k / fitted.k * 100)) : Math.min(99, Math.round(view.k / fitted.k * 100))}%`;
    if (zoomOut) zoomOut.disabled = view.k <= minScale * (1 + 1e-9);
    getHoverPreview()?.clear();
    activationPopover.reposition();
    getSummary()?.layout();
  };
}

export function attachCameraControls({ zoomIn, zoomOut, fitButton }, gestures) {
  zoomIn?.addEventListener('click', () => gestures.zoom(1.25));
  zoomOut?.addEventListener('click', () => gestures.zoom(0.8));
  fitButton.addEventListener('click', () => gestures.reset());
}
