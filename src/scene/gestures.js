import { createCamera } from './camera.js';

const clamp = (value, low, high) => Math.max(low, Math.min(high, value));

export function attachGestures(svg, { cameraView, onSelect, onChange, onBackgroundTap = () => {}, getFrame = () => null, getHomeFrame = null, fitInsets = null, resolveSelection = () => null,
  resolvePointerTarget = event => event.target.closest('[data-type]'),
  requestPaint = globalThis.requestAnimationFrame?.bind(globalThis),
  cancelPaint = globalThis.cancelAnimationFrame?.bind(globalThis),
}) {
  const pointers = new Map();
  let moved = false, pinched = false, initialTarget = null, initialSelection = null, initialClient = null, initialPoint = null, initialAdditive = false;
  let tapTolerance = 6;
  const selectionFor = (target, event) => {
    const value = resolveSelection(target, event) || { type: target.dataset.type, id: target.dataset.id,
      ...(target.dataset.activation ? { activation: target.dataset.activation } : {}) };
    // Pointer context belongs to this press, not to the target or viewport.
    // Keyboard activation has no pointer context, so its focus stays visible.
    return event?.type === 'pointerdown' && event.pointerType ? { ...value, pointerType: event.pointerType } : value;
  };
  const selectTarget = (target, additive = false, event) => onSelect({ ...selectionFor(target, event), ...(additive ? { additive: true } : {}) });
  const surface = cameraView.surface;
  const point = event => ({ ...cameraView.point(event), clientX: event.clientX, clientY: event.clientY });
  let camera;
  let gestureUpdate = false, pendingPaint = null, paintFrame = null;
  let wasPannable, wasDragging;
  function paint({ view, fitted, metadata }) {
    updateCursor(view, metadata.minScale);
    cameraView.paint(view);
    onChange(view, fitted, metadata);
  }
  function flushPaint() {
    if (paintFrame !== null) cancelPaint?.(paintFrame.handle);
    paintFrame = null;
    const pending = pendingPaint;
    pendingPaint = null;
    if (pending) paint(pending);
  }
  // Apply every input to the camera immediately. Only the DOM transform and
  // dependent UI wait for the next frame, avoiding write/read layout cycles
  // between multiple pointer events. Day timeline rendering is independent.
  function publish(view, fitted, metadata) {
    pendingPaint = { view, fitted, metadata };
    if (!gestureUpdate || !requestPaint) { flushPaint(); return; }
    if (paintFrame === null) {
      const frame = { handle: null };
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
  function updateGesture(callback) {
    gestureUpdate = true;
    try { callback(); } finally { gestureUpdate = false; }
  }
  function updateCursor(view = camera.getView(), minScale = camera.minimumScale()) {
    const pannable = view.k > minScale * (1 + 1e-9);
    const dragging = pannable && pointers.size > 0;
    if (pannable !== wasPannable) { svg.classList.toggle('is-pannable', pannable); wasPannable = pannable; }
    if (dragging !== wasDragging) { svg.classList.toggle('is-dragging', dragging); wasDragging = dragging; }
  }
  camera = createCamera({ getFrame, getHomeFrame,
    measureFit: frame => cameraView.measureFit(frame, fitInsets),
    onChange: publish,
  });
  const center = pair => ({ x: (pair[0].x + pair[1].x) / 2, y: (pair[0].y + pair[1].y) / 2 });
  const distance = pair => Math.hypot(pair[0].x - pair[1].x, pair[0].y - pair[1].y);
  surface.addEventListener('pointerdown', event => {
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
      // The fixed field is not focusable. Suppress its default mouse focus so
      // it cannot undo the SVG focus after a press on uncovered background.
      event.preventDefault();
      svg.focus?.({ preventScroll: true });
    }
    pointers.set(event.pointerId, current);
    if (pointers.size > 1) pinched = true;
    surface.setPointerCapture(event.pointerId);
    updateCursor();
  });
  function movePointer(event) {
    if (!pointers.has(event.pointerId)) return;
    const old = pointers.get(event.pointerId);
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
    if (Math.hypot(event.clientX - initialClient.x, event.clientY - initialClient.y) > tapTolerance) moved = true;
    if (pointers.size === 1) {
      if (moved || pinched) updateGesture(() => camera.pan(current.x - panOrigin.x, current.y - panOrigin.y));
    } else if (pointers.size === 2) {
      const after = [...pointers.values()];
      const oldCenter = center(before), nextCenter = center(after);
      updateGesture(() => camera.zoomAt(oldCenter, distance(after) / Math.max(distance(before), 1),
        nextCenter.x - oldCenter.x, nextCenter.y - oldCenter.y));
    }
  }
  surface.addEventListener('pointermove', movePointer);
  function release(event) {
    if (!pointers.has(event.pointerId)) return;
    if (event.type === 'pointerup') movePointer(event);
    flushPaint();
    const tap = event.type === 'pointerup' && pointers.size === 1 && !moved && !pinched
      && Math.hypot(event.clientX - initialClient.x, event.clientY - initialClient.y) <= tapTolerance;
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
  surface.addEventListener('lostpointercapture', event => { flushPaint(); pointers.delete(event.pointerId); updateCursor(); });
  surface.addEventListener('wheel', event => {
    event.preventDefault();
    const anchor = point(event);
    updateGesture(() => camera.zoomAt(anchor, Math.exp(-clamp(event.deltaY, -200, 200) * 0.003)));
  }, { passive: false });
  svg.addEventListener('keydown', event => {
    const target = event.target.closest('[data-type]');
    if (target && ['Enter', ' '].includes(event.key)) { event.preventDefault(); selectTarget(target, Boolean(event.shiftKey), event); }
    if (event.target === svg && ['+', '-', '0'].includes(event.key)) {
      event.preventDefault();
      if (event.key === '0') camera.reset();
      else camera.zoom(event.key === '+' ? 1.25 : 0.8);
    }
  });
  return camera;
}
