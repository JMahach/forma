import { DRAWING_BOUNDS, CHART_FRAME } from './geometry/frames.js';

const clamp = (value, low, high) => Math.max(low, Math.min(high, value));

export function zoomAt(view, point, factor, { min = 0.65, max = 4.5 } = {}) {
  const k = clamp(view.k * factor, min, max);
  if (k === view.k) return { ...view };
  const ratio = k / view.k;
  return { x: point.x - (point.x - view.x) * ratio, y: point.y - (point.y - view.y) * ratio, k };
}

export function validView(value, { min = 0.65, max = 4.5 } = {}) {
  return value && ['x', 'y', 'k'].every(key => Number.isFinite(value[key])) && value.k >= min && value.k <= max && Math.abs(value.x) <= 5000 && Math.abs(value.y) <= 6000;
}

export function fitView(bounds, area, { min = 0.65, max = 4.5 } = {}) {
  const k = clamp(Math.min(area.width / bounds.width, area.height / bounds.height), min, max);
  return { k, x: area.x + area.width / 2 - (bounds.x + bounds.width / 2) * k, y: area.y + area.height / 2 - (bounds.y + bounds.height / 2) * k };
}

export function isHomeView(view, fitted) {
  return Math.abs(view.k - fitted.k) <= fitted.k * 1e-9
    && Math.abs(view.x - fitted.x) <= 1e-7 && Math.abs(view.y - fitted.y) <= 1e-7;
}

// The home drawing frame stays covered by the zoomed drawing: at 100% each
// interval collapses to its home coordinate, so the camera cannot drift.
export function constrainView(view, fitted, bounds = DRAWING_BOUNDS) {
  const k = clamp(view.k, fitted.k, 4.5);
  if (k <= fitted.k * (1 + 1e-9)) return { ...fitted };
  const left = fitted.x + bounds.x * fitted.k;
  const top = fitted.y + bounds.y * fitted.k;
  const right = left + bounds.width * fitted.k;
  const bottom = top + bounds.height * fitted.k;
  return {
    x: clamp(view.x, right - (bounds.x + bounds.width) * k, left - bounds.x * k),
    y: clamp(view.y, bottom - (bounds.y + bounds.height) * k, top - bounds.y * k),
    k,
  };
}

// The camera owns only transforms, navigation bounds and the Home baseline.
// Screen measurement and painting arrive through explicit callbacks.
export function createCamera({ getFrame = () => null, getHomeFrame = null, measureFit, onChange }) {
  let view = { x: 0, y: 0, k: 1 };
  let fittedView = { ...view };
  const activeFrame = () => getFrame() ?? CHART_FRAME;
  const homeFrame = () => getHomeFrame?.() ?? activeFrame();
  const studioHome = typeof getHomeFrame === 'function';
  // One live camera. The studio can share a Home baseline across modes while
  // navigation admits the larger visible drawing without moving that camera.
  let navigationFrame = activeFrame(), navigationFit = { ...view };
  const sameView = (a, b) => a.x === b.x && a.y === b.y && a.k === b.k;
  const rebase = (value, from, to) => {
    if (sameView(from, to)) return { ...value };
    if (isHomeView(value, from)) return { ...to };
    const ratio = to.k / from.k;
    return { x: to.x + (value.x - from.x) * ratio, y: to.y + (value.y - from.y) * ratio, k: value.k * ratio };
  };
  // Studio Home is the zoom floor even when wider navigation bounds permit
  // panning around a ring. Standalone diagrams keep their existing frame floor.
  const minimumScale = () => studioHome ? fittedView.k : navigationFit.k;
  const zoom = (anchor, factor) => zoomAt(view, anchor, factor, { min: minimumScale(), max: 4.5 });
  function publish() {
    onChange({ ...view }, { ...fittedView }, { minScale: minimumScale() });
  }
  // Expanded bounds allow panning, but their limits must converge at the true
  // Home scale. A smaller navigation fit leaves an offset until the last step.
  const constrain = candidate => constrainView(candidate, studioHome ? fittedView : navigationFit, navigationFrame.bounds);
  function apply() {
    view = constrain(view);
    publish();
  }
  function defaultView(frame = activeFrame()) {
    const { area, min } = measureFit(frame);
    return fitView(frame.bounds, area, { min });
  }
  function fit() {
    navigationFrame = homeFrame();
    fittedView = defaultView(navigationFrame);
    navigationFit = { ...fittedView };
    view = { ...fittedView };
    expandNavigation();
    apply();
  }
  function expandNavigation() {
    const nextFrame = activeFrame(), previous = navigationFrame.bounds, next = nextFrame.bounds;
    const nextFit = defaultView(nextFrame);
    // Showing a larger drawing may extend navigation immediately. Hiding it
    // never narrows the existing limits and cannot cause a later gesture snap.
    const contains = next.x <= previous.x && next.y <= previous.y
      && next.x + next.width >= previous.x + previous.width
      && next.y + next.height >= previous.y + previous.height;
    if (contains && nextFit.k <= navigationFit.k
      && sameView(constrainView(view, nextFit, next), view)) {
      navigationFrame = nextFrame;
      navigationFit = nextFit;
    }
  }
  function rebaseHome() {
    const previous = fittedView, next = defaultView(homeFrame());
    view = rebase(view, previous, next);
    navigationFit = rebase(navigationFit, previous, next);
    fittedView = next;
    expandNavigation();
    apply();
  }
  const controls = {
    minimumScale,
    pan(dx, dy) { view.x += dx; view.y += dy; apply(); },
    zoomAt(anchor, factor, dx = 0, dy = 0) { view = zoom(anchor, factor); view.x += dx; view.y += dy; apply(); },
    zoom(factor) { view = zoom({ x: 320, y: 410 }, factor); apply(); },
    reset() { fit(); },
    refreshFrame() {
      fittedView = defaultView(homeFrame());
      expandNavigation();
      publish();
    },
    resize() {
      if (studioHome) { rebaseHome(); return; }
      // Responsive presentation can replace Home with a larger or smaller
      // frame. Adopt it before constraining an unchanged Home camera.
      if (isHomeView(view, fittedView)) { fit(); return; }
      const next = defaultView(navigationFrame), ratio = next.k / navigationFit.k;
      if (!sameView(next, navigationFit)) {
        view = { x: next.x + (view.x - navigationFit.x) * ratio, y: next.y + (view.y - navigationFit.y) * ratio, k: view.k * ratio };
      }
      navigationFit = next;
      fittedView = defaultView(homeFrame());
      expandNavigation();
      apply();
    },
    getView() { return { ...view }; },
    getFittedView() { return { ...fittedView }; },
    setView(value) { if (validView(value, { min: Math.min(navigationFrame.minScale, navigationFit.k) })) { view = { ...value }; apply(); } else fit(); }
  };
  apply();
  return controls;
}
