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

export function createCameraChangeHandler({ heading, fitButton, zoomValue, zoomOut, getHoverPreview = () => null, activationPopover, getSummary = () => null }) {
  return (view, fitted) => {
    const home = view.k <= fitted.k * (1 + 1e-9);
    if (heading) heading.hidden = !home;
    if (fitButton) fitButton.hidden = home;
    if (zoomValue) zoomValue.textContent = `${home ? 100 : Math.max(101, Math.round(view.k / fitted.k * 100))}%`;
    if (zoomOut) zoomOut.disabled = home;
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
