import type { CameraPosition } from '../scene/camera.ts';
import type { Gestures } from '../scene/gestures.ts';
import {createResourceScope} from '../runtime/resource-scope.ts';
interface CameraChangeOptions {
  heading: HTMLElement | null; fitButton: HTMLButtonElement | null;
  getHoverPreview?: () => { refreshCenter: () => void } | null;
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
    getHoverPreview()?.refreshCenter();
    activationPopover.reposition();
    getSummary()?.layout();
  };
}

export function attachCameraControls({ fitButton }: { fitButton: HTMLButtonElement }, gestures: Gestures) {
  const scope=createResourceScope();
  fitButton.addEventListener('click', () => gestures.reset(), {signal:scope.signal});
  return {dispose:scope.stop};
}
