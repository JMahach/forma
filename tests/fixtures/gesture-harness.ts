import type { TestStub } from '../helpers/test-stub.ts';
import type { GestureOptions } from '../../src/scene/gestures.ts';
import { attachGestures as attach } from '../../src/scene/gestures.ts';
import { computeCameraFit } from '../../src/scene/camera-fit.ts';

// Unit tests exercise gesture/camera rules through a fake screen port. The SVG
// attribute here records logical poses; real CSS projection has separate tests.
export function attachGestures(surface: TestStub<SVGSVGElement>, drawing: TestStub<Element>, options: Omit<GestureOptions, 'cameraView'>) {
  const svg = surface as SVGSVGElement, viewport = drawing as Element;
  return attach(svg, { ...options, cameraView: {
    surface: svg,
    point(event) { return new DOMPoint(event.clientX, event.clientY).matrixTransform(svg.getScreenCTM()!.inverse()); },
    measureFit(frame, fitInsets) {
      const rect = svg.getBoundingClientRect(), matrix = svg.getScreenCTM()!.inverse();
      const insets = typeof fitInsets === 'function' ? fitInsets() : fitInsets;
      return computeCameraFit(frame, rect, insets, (x, y) => new DOMPoint(x, y).matrixTransform(matrix));
    },
    paint(view) { viewport.setAttribute('transform', `translate(${view.x} ${view.y}) scale(${view.k})`); },
  } });
}

import { attachMandalaMode as attachMode } from '../../src/scene/modes/mandala.ts';
import { createCameraChangeHandler as cameraChange } from '../../src/views/camera-controls.ts';
import type { Camera } from '../../src/scene/camera.ts';
type ModeOptions = Parameters<typeof attachMode>[0];
type TestModeOptions = Omit<ModeOptions, 'button' | 'canvas' | 'gestures' | 'motion'> & {
  button: { setAttribute?(name: string, value: string): void; addEventListener?(name: string, handler: () => void): void };
  canvas: { classList: { toggle(token?: string, force?: boolean): unknown; add?(): void; remove?(): void }; style?: unknown };
  gestures: Partial<Camera> & { transitionHome?: () => void };
  motion?: Partial<NonNullable<ModeOptions['motion']>>;
};
type CameraChangeOptions = Parameters<typeof cameraChange>[0];
export const attachMandalaMode = attachMode as (options: TestModeOptions) => ReturnType<typeof attachMode>;
export const createCameraChangeHandler = cameraChange as (options: Omit<CameraChangeOptions, 'heading' | 'fitButton'> & {
  heading: { hidden?: boolean } | null; fitButton: { hidden?: boolean } | null;
}) => ReturnType<typeof cameraChange>;
