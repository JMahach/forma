import { attachGestures as attach } from '../../src/scene/gestures.js';
import { computeCameraFit } from '../../src/scene/layout.js';

// Unit tests exercise gesture/camera rules through a fake screen port. The SVG
// attribute here records logical poses; real CSS projection has separate tests.
export function attachGestures(svg, viewport, options) {
  return attach(svg, { ...options, cameraView: {
    surface: svg,
    point(event) { return new DOMPoint(event.clientX, event.clientY).matrixTransform(svg.getScreenCTM().inverse()); },
    measureFit(frame, fitInsets) {
      const rect = svg.getBoundingClientRect(), matrix = svg.getScreenCTM().inverse();
      const insets = typeof fitInsets === 'function' ? fitInsets() : fitInsets;
      return computeCameraFit(frame, rect, insets, (x, y) => new DOMPoint(x, y).matrixTransform(matrix));
    },
    paint(view) { viewport.setAttribute('transform', `translate(${view.x} ${view.y}) scale(${view.k})`); },
  } });
}
