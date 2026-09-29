import { isHomeView } from '../scene/camera.js';

export function createCameraChangeHandler({ heading, fitButton, getHoverPreview = () => null, activationPopover, getSummary = () => null }) {
  return (view, fitted) => {
    const home = isHomeView(view, fitted);
    // Caption overlap belongs to chart-heading-layout; the camera only hides
    // it while the drawing is away from Home.
    if (heading && heading.hidden !== !home) heading.hidden = !home;
    if (fitButton && fitButton.hidden !== home) fitButton.hidden = home;
    getHoverPreview()?.clear();
    activationPopover.reposition();
    getSummary()?.layout();
  };
}

export function attachCameraControls({ fitButton }, gestures) {
  fitButton.addEventListener('click', () => gestures.reset());
}
