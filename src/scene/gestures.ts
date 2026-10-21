import type { Camera, CameraPosition, Point } from './camera.ts';
import type { CameraFrame } from './geometry/frames.ts';
import type { createCameraView } from './camera-view.ts';
import type { FitInsets } from './camera-fit.ts';
import type { SelectionAction, SelectionType } from '../selection/selection-targets.ts';
type GestureSelection = SelectionAction | { type: 'planet-filter'; id: string; additive?: boolean; pointerType?: string };
type PointerCoordinates = Pick<MouseEvent, 'clientX' | 'clientY'>;
interface SafariGestureEvent extends MouseEvent { scale: number }
interface CameraPaint { view: CameraPosition; fitted: CameraPosition; metadata: { minScale: number } }
export interface GestureOptions {
  camera?: Camera | null;
  cameraView: ReturnType<typeof createCameraView>;
  onSelect?: (selection: GestureSelection) => void;
  onChange?: (view: CameraPosition, fitted: CameraPosition, metadata: { minScale: number }) => void;
  onBackgroundTap?: () => void;
  getFrame?: () => CameraFrame | null;
  getHomeFrame?: (() => CameraFrame | null) | null;
  fitInsets?: FitInsets | (() => FitInsets) | null;
  resolveSelection?: (target: HTMLElement | SVGElement, event: PointerEvent | KeyboardEvent) => SelectionAction | null;
  resolvePointerTarget?: (event: PointerEvent) => HTMLElement | SVGElement | null;
  requestPaint?: ((callback: FrameRequestCallback) => number) | null;
  cancelPaint?: ((handle: number) => void) | null;
}
export type Gestures = ReturnType<typeof attachGestures>;

import { createCamera } from './camera.ts';

const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));

export function attachGestures(svg: SVGSVGElement & { inert?: boolean }, { camera: existingCamera = null, cameraView, onSelect = () => {}, onChange = () => {}, onBackgroundTap = () => {}, getFrame = () => null, getHomeFrame = null, fitInsets = null, resolveSelection = () => null,
  resolvePointerTarget = event => (event.target as Element).closest?.<HTMLElement | SVGElement>('[data-type]') || null,
  requestPaint = globalThis.requestAnimationFrame?.bind(globalThis),
  cancelPaint = globalThis.cancelAnimationFrame?.bind(globalThis),
}: GestureOptions) {
  const pointers = new Map<number, Point & PointerCoordinates>();
  let safariGesture: { scale: number; pointerOwned: boolean } | null = null;
  let moved = false, pinched = false, initialAdditive = false;
  let initialTarget: HTMLElement | SVGElement | null = null, initialSelection: GestureSelection | null = null;
  let initialClient: Point | null = null, initialPoint: Point | null = null;
  let tapTolerance = 6;
  const selectionFor = (target: HTMLElement | SVGElement, event: PointerEvent | KeyboardEvent): GestureSelection => {
    const value: GestureSelection = resolveSelection(target, event) || { type: target.dataset.type as SelectionType, id: target.dataset.id!,
      ...(target.dataset.activation ? { activation: target.dataset.activation } : {}) } as GestureSelection;
    // Pointer context belongs to this press, not to the target or viewport.
    // Keyboard activation has no pointer context, so its focus stays visible.
    return event?.type === 'pointerdown' && (event as PointerEvent).pointerType ? { ...value, pointerType: (event as PointerEvent).pointerType } : value;
  };
  const selectTarget = (target: HTMLElement | SVGElement, additive = false, event: PointerEvent | KeyboardEvent) => onSelect({ ...selectionFor(target, event), ...(additive ? { additive: true } : {}) });
  const surface = cameraView.surface;
  const point = (event: PointerCoordinates) => ({ ...cameraView.point(event), clientX: event.clientX, clientY: event.clientY });
  let camera: Camera;
  let gestureUpdate = false;
  let pendingPaint: CameraPaint | null = null, paintFrame: { handle: number | null } | null = null;
  let wasPannable: boolean | undefined, wasDragging: boolean | undefined;
  function paint({ view, fitted, metadata }: CameraPaint) {
    updateCursor(view, metadata.minScale);
    cameraView.paint(view);
    onChange(view, fitted, metadata);
  }
  function flushPaint() {
    if (paintFrame !== null) cancelPaint?.(paintFrame.handle!);
    paintFrame = null;
    const pending = pendingPaint;
    pendingPaint = null;
    if (pending) paint(pending);
  }
  // Apply every input to the camera immediately. Only the DOM transform and
  // dependent UI wait for the next frame, avoiding write/read layout cycles
  // between multiple pointer events. Day timeline rendering is independent.
  function publish(view: CameraPosition, fitted: CameraPosition, metadata: { minScale: number }) {
    pendingPaint = { view, fitted, metadata };
    if (!gestureUpdate || !requestPaint) { flushPaint(); return; }
    if (paintFrame === null) {
      const frame: { handle: number | null } = { handle: null };
      paintFrame = frame;
      frame.handle = requestPaint(() => {
        if (paintFrame !== frame) return;
        paintFrame = null;
        const pending = pendingPaint;
        pendingPaint = null;
        if (pending) paint(pending);
      });
    }
  }
  function updateGesture(callback: () => void) {
    gestureUpdate = true;
    try { callback(); } finally { gestureUpdate = false; }
  }
  function updateCursor(view = camera.getView(), minScale = camera.minimumScale()) {
    const pannable = view.k > minScale * (1 + 1e-9);
    const dragging = pannable && pointers.size > 0;
    if (pannable !== wasPannable) { svg.classList.toggle('is-pannable', pannable); wasPannable = pannable; }
    if (dragging !== wasDragging) { svg.classList.toggle('is-dragging', dragging); wasDragging = dragging; }
  }
  camera = existingCamera || createCamera({ getFrame, getHomeFrame,
    measureFit: frame => cameraView.measureFit(frame, fitInsets),
    onChange: publish,
  });
  if (existingCamera) camera.setOnChange(publish);
  const center = (pair: Point[]) => ({ x: (pair[0].x + pair[1].x) / 2, y: (pair[0].y + pair[1].y) / 2 });
  const distance = (pair: Point[]) => Math.hypot(pair[0].x - pair[1].x, pair[0].y - pair[1].y);
  surface.addEventListener('pointerdown', raw => {
    const event = raw as PointerEvent;
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    const current = point(event);
    if (!pointers.size) {
      moved = false; pinched = false; initialTarget = resolvePointerTarget(event); initialClient = { x: event.clientX, y: event.clientY };
      // A finger can roll slightly while pressing a control. Keep that a tap;
      // panning from empty space retains its existing, smaller start distance.
      tapTolerance = initialTarget && event.pointerType === 'touch' ? 10 : 6;
      initialPoint = current;
      // Resolve while the pressed SVG target still exists. Hover redraws may
      // replace it before pointerup; a tap must keep its original exact angle.
      initialSelection = initialTarget ? selectionFor(initialTarget, event) : null;
      // The first press owns both the target and modifier for this gesture.
      initialAdditive = Boolean(event.shiftKey);
    }
    // Touch synthesizes mouse focus after pointerup, which could refocus an
    // activation that this tap just deselected. Keyboard focus stays native.
    if (initialTarget?.dataset.activation) {
      event.preventDefault();
      if (!pointers.size) initialTarget.focus?.({ preventScroll: true });
    }
    if (event.target === surface) {
      // The loading surface owns keyboard zoom until the real SVG becomes
      // interactive. Ready charts retain their existing selection focus.
      event.preventDefault();
      (svg.inert ? surface : svg).focus?.({ preventScroll: true });
    }
    pointers.set(event.pointerId, current);
    if (pointers.size > 1) {
      pinched = true;
      if (safariGesture) safariGesture.pointerOwned = true;
    }
    surface.setPointerCapture(event.pointerId);
    updateCursor();
  });
  function movePointer(raw: Event) {
    const event = raw as PointerEvent;
    if (!pointers.has(event.pointerId)) return;
    const old = pointers.get(event.pointerId)!;
    // A release may contain the last movement without a preceding move event.
    // Compare screen coordinates first: resizing under a still finger is not
    // new travel, and a hidden surface may no longer have a valid projection.
    if (event.type === 'pointerup' && event.clientX === old.clientX && event.clientY === old.clientY) return;
    const current = point(event);
    if (event.type === 'pointerup' && (!Number.isFinite(current.x) || !Number.isFinite(current.y))) return;
    const before = [...pointers.values()];
    pointers.set(event.pointerId, current);
    // The first drag includes travel inside the tap tolerance. Keep the pointer
    // map current for pinch, which must never replay that one-finger travel.
    const panOrigin = moved || pinched ? old : initialPoint;
    if (Math.hypot(event.clientX - initialClient!.x, event.clientY - initialClient!.y) > tapTolerance) moved = true;
    if (pointers.size === 1) {
      if (moved || pinched) updateGesture(() => camera.pan(current.x - panOrigin!.x, current.y - panOrigin!.y));
    } else if (pointers.size === 2) {
      const after = [...pointers.values()];
      const oldCenter = center(before), nextCenter = center(after);
      updateGesture(() => camera.zoomAt(oldCenter, distance(after) / Math.max(distance(before), 1),
        nextCenter.x - oldCenter.x, nextCenter.y - oldCenter.y));
    }
  }
  surface.addEventListener('pointermove', movePointer);
  function release(raw: Event) {
    const event = raw as PointerEvent;
    if (!pointers.has(event.pointerId)) return;
    if (event.type === 'pointerup') movePointer(event);
    flushPaint();
    const tap = event.type === 'pointerup' && pointers.size === 1 && !moved && !pinched
      && Math.hypot(event.clientX - initialClient!.x, event.clientY - initialClient!.y) <= tapTolerance;
    pointers.delete(event.pointerId);
    if (surface.hasPointerCapture(event.pointerId)) surface.releasePointerCapture(event.pointerId);
    updateCursor();
    if (tap) {
      if (initialSelection) onSelect({ ...initialSelection, ...(initialAdditive ? { additive: true } : {}) });
      else onBackgroundTap();
    }
  }
  surface.addEventListener('pointerup', release);
  surface.addEventListener('pointercancel', release);
  surface.addEventListener('lostpointercapture', event => { flushPaint(); pointers.delete((event as PointerEvent).pointerId); updateCursor(); });
  // Safari trackpad pinch uses cumulative GestureEvent scales. Touch pinch
  // stays with PointerEvents, and Ctrl-wheel emitted in the same lifecycle
  // must not apply the trackpad's zoom a second time.
  surface.addEventListener('gesturestart', raw => {
    const event = raw as SafariGestureEvent;
    if (event.cancelable) event.preventDefault();
    safariGesture = { scale: Number.isFinite(event.scale) && event.scale > 0 ? event.scale : 1,
      pointerOwned: pointers.size > 1 };
  }, { passive: false });
  surface.addEventListener('gesturechange', raw => {
    const event = raw as SafariGestureEvent;
    if (event.cancelable) event.preventDefault();
    if (!safariGesture || !Number.isFinite(event.scale) || event.scale <= 0) return;
    const factor = event.scale / safariGesture.scale;
    safariGesture.scale = event.scale;
    if (safariGesture.pointerOwned || !Number.isFinite(factor) || factor <= 0) return;
    let position: PointerCoordinates = event;
    if (!Number.isFinite(event.clientX) || !Number.isFinite(event.clientY)) {
      const rect = surface.getBoundingClientRect();
      position = { clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 };
    }
    const anchor = point(position);
    if (!Number.isFinite(anchor.x) || !Number.isFinite(anchor.y)) return;
    updateGesture(() => camera.zoomAt(anchor, factor));
  }, { passive: false });
  surface.addEventListener('gestureend', event => {
    if (event.cancelable) event.preventDefault();
    safariGesture = null;
    flushPaint();
  }, { passive: false });
  surface.addEventListener('wheel', raw => {
    const event = raw as WheelEvent;
    event.preventDefault();
    if (event.ctrlKey && safariGesture) return;
    const anchor = point(event);
    updateGesture(() => camera.zoomAt(anchor, Math.exp(-clamp(event.deltaY, -200, 200) * 0.003)));
  }, { passive: false });
  function keydown(raw: Event) {
    const event = raw as KeyboardEvent;
    const target = (event.target as Element).closest<HTMLElement | SVGElement>('[data-type]');
    if (target && ['Enter', ' '].includes(event.key)) { event.preventDefault(); selectTarget(target, Boolean(event.shiftKey), event); }
    if ((event.target === svg || event.target === surface) && ['+', '-', '0'].includes(event.key)) {
      event.preventDefault();
      if (event.key === '0') camera.reset();
      else camera.zoom(event.key === '+' ? 1.25 : 0.8);
    }
  }
  svg.addEventListener('keydown', keydown);
  if (surface !== svg) surface.addEventListener('keydown', event => {
    if (event.target === surface) keydown(event);
  });
  // Startup and the ready chart share one input attachment. A new screen
  // adopts the live pose, but never the tap or Safari gesture that began on
  // the previous screen. Flush its last paint before replacing its callbacks.
  function setHandlers({ onSelect: nextSelect = onSelect, onChange: nextChange = onChange,
    onBackgroundTap: nextBackground = onBackgroundTap, resolvePointerTarget: nextTarget = resolvePointerTarget,
    resolveSelection: nextSelection = resolveSelection }: Partial<Pick<GestureOptions, 'onSelect' | 'onChange' | 'onBackgroundTap' | 'resolvePointerTarget' | 'resolveSelection'>> = {}) {
    flushPaint();
    const captured = [...pointers.keys()];
    pointers.clear(); safariGesture = null;
    initialTarget = initialSelection = initialClient = initialPoint = null;
    moved = pinched = initialAdditive = false;
    for (const id of captured) if (surface.hasPointerCapture(id)) surface.releasePointerCapture(id);
    onSelect = nextSelect; onChange = nextChange; onBackgroundTap = nextBackground;
    resolvePointerTarget = nextTarget; resolveSelection = nextSelection;
    updateCursor();
    onChange(camera.getView(), camera.getFittedView(), { minScale: camera.minimumScale() });
  }
  return { ...camera, setHandlers };
}
