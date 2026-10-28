import type { Bounds, CameraFrame } from './geometry/frames.ts';
export interface Point { x: number; y: number }
export interface CameraPosition extends Point { k: number }
export interface SavedCameraPosition extends CameraPosition { maxK?: number; zoomLimit?: number }
export interface FitMeasurement { area: Bounds; min: number; viewport?: Bounds; screenScale?: number }
interface CameraOptions {
  getFrame?: () => CameraFrame | null;
  getHomeFrame?: (() => CameraFrame | null) | null;
  measureFit: (frame: CameraFrame) => FitMeasurement;
  onChange: (view: CameraPosition, fitted: CameraPosition, limits: { minScale: number }) => void;
}
export type Camera = ReturnType<typeof createCamera>;

import { DRAWING_BOUNDS, CHART_FRAME } from './geometry/frames.ts';

// One authored ceiling; panel resizing only converts it between projections.
export const MAX_ZOOM = 3.6;

const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));

export function zoomAt(view: CameraPosition, point: Point, factor: number, { min = 0.65, max = MAX_ZOOM } = {}) {
  const k = clamp(view.k * factor, min, max);
  if (k === view.k) return { ...view };
  const ratio = k / view.k;
  return { x: point.x - (point.x - view.x) * ratio, y: point.y - (point.y - view.y) * ratio, k };
}

export function validView(input: unknown, { min = 0.65, max = MAX_ZOOM } = {}): input is CameraPosition {
  const value = input as CameraPosition | null | undefined;
  const coordinateLimit = Math.max(1, max / MAX_ZOOM);
  return !!value && (['x', 'y', 'k'] as const).every(key => Number.isFinite(value[key])) && value.k >= min && value.k <= max
    && Math.abs(value.x) <= 5000 * coordinateLimit && Math.abs(value.y) <= 6000 * coordinateLimit;
}

export function fitView(bounds: Bounds, area: Bounds, { min = 0.65, max = MAX_ZOOM } = {}) {
  const k = clamp(Math.min(area.width / bounds.width, area.height / bounds.height), min, max);
  return { k, x: area.x + area.width / 2 - (bounds.x + bounds.width / 2) * k, y: area.y + area.height / 2 - (bounds.y + bounds.height / 2) * k };
}

export function isHomeView(view: CameraPosition, fitted: CameraPosition) {
  return Math.abs(view.k - fitted.k) <= fitted.k * 1e-9
    && Math.abs(view.x - fitted.x) <= 1e-7 && Math.abs(view.y - fitted.y) <= 1e-7;
}

// The chosen Home field stays covered by its zoomed projection: at 100% each
// interval collapses to its home coordinate, so the camera cannot drift.
export function constrainView(view: CameraPosition, fitted: CameraPosition, bounds: Bounds = DRAWING_BOUNDS, { max = MAX_ZOOM } = {}) {
  const k = clamp(view.k, fitted.k, max);
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
export function createCamera({ getFrame = () => null, getHomeFrame = null, measureFit, onChange }: CameraOptions) {
  let view = { x: 0, y: 0, k: 1 };
  let fittedView = { ...view }, maximumScale = MAX_ZOOM;
  const activeFrame = () => getFrame() ?? CHART_FRAME;
  const homeFrame = () => getHomeFrame?.() ?? activeFrame();
  const studioHome = typeof getHomeFrame === 'function';
  // Studio navigation belongs to the fixed surface, not to mode-specific art.
  // Standalone diagrams retain their expandable drawing frame.
  let navigationFrame = activeFrame(), navigationFit = { ...view };
  let homeField = navigationFrame.bounds;
  let homeMeasurement: FitMeasurement | null = null;
  const sameView = (a: CameraPosition, b: CameraPosition) => a.x === b.x && a.y === b.y && a.k === b.k;
  const rebase = (value: CameraPosition, from: CameraPosition, to: CameraPosition) => {
    if (sameView(from, to)) return { ...value };
    if (isHomeView(value, from)) return { ...to };
    const ratio = to.k / from.k;
    return { x: to.x + (value.x - from.x) * ratio, y: to.y + (value.y - from.y) * ratio, k: value.k * ratio };
  };
  // Studio modes share the same Home floor. Standalone diagrams keep their
  // existing drawing-frame floor.
  const minimumScale = () => studioHome ? fittedView.k : navigationFit.k;
  const zoom = (anchor: Point, factor: number) => zoomAt(view, anchor, factor, { min: minimumScale(), max: maximumScale });
  function publish() {
    onChange({ ...view }, { ...fittedView }, { minScale: minimumScale() });
  }
  // Studio pan limits converge at Home; standalone limits follow their frame.
  const constrain = (candidate: CameraPosition) => constrainView(candidate, studioHome ? fittedView : navigationFit, studioHome ? homeField : navigationFrame.bounds, { max: maximumScale });
  function apply() {
    view = constrain(view);
    publish();
  }
  function defaultView(frame = activeFrame(), { area, min } = measureFit(frame)) {
    return fitView(frame.bounds, area, { min });
  }
  function measureHome() {
    const frame = homeFrame(), measured = measureFit(frame), next = defaultView(frame, measured);
    homeMeasurement = measured;
    if (studioHome) {
      const viewport = measured.viewport!;
      homeField = { x: (viewport.x - next.x) / next.k, y: (viewport.y - next.y) / next.k,
        width: viewport.width / next.k, height: viewport.height / next.k };
    }
    return next;
  }
  function fit() {
    navigationFrame = homeFrame();
    fittedView = measureHome();
    navigationFit = { ...fittedView };
    view = { ...fittedView };
    expandNavigation();
    apply();
  }
  function expandNavigation() {
    if (studioHome) return;
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
  function rebaseHome({ preserveScale = false } = {}) {
    const previous = fittedView, previousMeasurement = homeMeasurement, next = measureHome();
    const ratio = (previousMeasurement?.screenScale ?? 1) / (homeMeasurement!.screenScale ?? 1);
    // The zoom ceiling describes the same physical detail size across panels.
    // Keeping the old SVG-unit ceiling would shrink a maximally zoomed chart.
    if (preserveScale && previousMeasurement) maximumScale = Math.max(next.k, maximumScale * ratio);
    if (preserveScale && previousMeasurement && !isHomeView(view, previous)) {
      // A panel changes available space, not the detail size being inspected.
      // Keep the map point under the old free-area center at the new center.
      const from = previousMeasurement.area, to = homeMeasurement!.area;
      const point = { x: (from.x + from.width / 2 - view.x) / view.k,
        y: (from.y + from.height / 2 - view.y) / view.k };
      const k = clamp(view.k * ratio, next.k, maximumScale);
      view = { x: to.x + to.width / 2 - point.x * k, y: to.y + to.height / 2 - point.y * k, k };
    } else view = rebase(view, previous, next);
    navigationFit = rebase(navigationFit, previous, next);
    fittedView = next;
    expandNavigation();
    apply();
  }
  const controls = {
    // Startup hands its existing camera to gestures; no reset or second state.
    setOnChange(listener: CameraOptions['onChange']) { onChange = listener; publish(); },
    // Early loading and the ready app save the same Home-relative position.
    // Storage timing and lifetime stay with the caller.
    getSavedView(): SavedCameraPosition {
      return { x: (view.x - fittedView.x) / fittedView.k, y: (view.y - fittedView.y) / fittedView.k,
        k: view.k / fittedView.k, maxK: maximumScale / fittedView.k, zoomLimit: MAX_ZOOM };
    },
    // One saved-view recipe serves early startup and full view restoration.
    restoreView(position: SavedCameraPosition | null | undefined) {
      fit();
      if (!position) return;
      // Older snapshots were written with a 4.5 ceiling. Record the authored
      // limit so a later reduction is applied once, including panel-sized views.
      const savedLimit = Number.isFinite(position.zoomLimit) && position.zoomLimit! > 0 ? position.zoomLimit! : 4.5;
      const restoredLimit = position.maxK ? position.maxK * fittedView.k * MAX_ZOOM / savedLimit : maximumScale;
      const restored = { x: fittedView.x + position.x * fittedView.k, y: fittedView.y + position.y * fittedView.k,
        k: position.k * fittedView.k };
      const area = homeMeasurement!.area;
      const anchor = { x: area.x + area.width / 2, y: area.y + area.height / 2 };
      const limited = restored.k > restoredLimit
        ? zoomAt(restored, anchor, restoredLimit / restored.k, { min: minimumScale(), max: restoredLimit }) : restored;
      controls.setView(limited, { maxScale: restoredLimit });
    },
    minimumScale, maximumScale: () => maximumScale,
    pan(dx: number, dy: number) { view.x += dx; view.y += dy; apply(); },
    zoomAt(anchor: Point, factor: number, dx = 0, dy = 0) { view = zoom(anchor, factor); view.x += dx; view.y += dy; apply(); },
    zoom(factor: number) { view = zoom({ x: 320, y: 410 }, factor); apply(); },
    reset() { fit(); },
    refreshFrame() {
      fittedView = measureHome();
      expandNavigation();
      publish();
    },
    resize(options?: { preserveScale?: boolean }) {
      if (studioHome) { rebaseHome(options); return; }
      // Responsive presentation can replace Home with a larger or smaller
      // frame. Adopt it before constraining an unchanged Home camera.
      if (isHomeView(view, fittedView)) { fit(); return; }
      const next = defaultView(navigationFrame), ratio = next.k / navigationFit.k;
      if (!sameView(next, navigationFit)) {
        view = { x: next.x + (view.x - navigationFit.x) * ratio, y: next.y + (view.y - navigationFit.y) * ratio, k: view.k * ratio };
      }
      navigationFit = next;
      fittedView = measureHome();
      expandNavigation();
      apply();
    },
    getView() { return { ...view }; },
    getFittedView() { return { ...fittedView }; },
    setView(value: unknown, { maxScale = maximumScale } = {}) {
      const validLimit = Number.isFinite(maxScale) && maxScale >= minimumScale() && maxScale <= 100;
      if (validLimit && validView(value, { min: Math.min(navigationFrame.minScale, navigationFit.k), max: maxScale })) {
        maximumScale = maxScale; view = { ...value }; apply();
      } else fit();
    }
  };
  apply();
  return controls;
}
