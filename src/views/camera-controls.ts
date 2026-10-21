import type { CameraPosition } from '../scene/camera.ts';
import type { Gestures } from '../scene/gestures.ts';
interface CameraChangeOptions {
  heading: HTMLElement | null; fitButton: HTMLButtonElement | null;
  getHoverPreview?: () => { clear: () => void } | null;
  activationPopover: { reposition: () => void };
  getSummary?: () => { layout: () => void } | null;
}

import { isHomeView } from '../scene/camera.ts';

export function createCameraChangeHandler({ heading, fitButton, getHoverPreview = () => null, activationPopover, getSummary = () => null }: CameraChangeOptions) {
  return (view: CameraPosition, fitted: CameraPosition) => {
    const home = isHomeView(view, fitted);
    // Caption overlap belongs to ui/layout/chart-heading; the camera only hides
    // it while the drawing is away from Home.
    if (heading && heading.hidden !== !home) heading.hidden = !home;
    if (fitButton && fitButton.hidden !== home) fitButton.hidden = home;
    getHoverPreview()?.clear();
    activationPopover.reposition();
    getSummary()?.layout();
  };
}

export function attachCameraControls({ fitButton }: { fitButton: HTMLButtonElement }, gestures: Gestures) {
  fitButton.addEventListener('click', () => gestures.reset());
}
