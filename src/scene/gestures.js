import { createCamera } from './camera.js';
import { measureCameraFit } from './studio-controller.js';

const clamp = (value, low, high) => Math.max(low, Math.min(high, value));

export function attachGestures(svg, viewport, { onSelect, onChange, onBackgroundTap = () => {}, getFrame = () => null, getHomeFrame = null, fitInsets = null, resolveSelection = () => null, cameraMotion = {},
  requestPaint = globalThis.requestAnimationFrame?.bind(globalThis),
  cancelPaint = globalThis.cancelAnimationFrame?.bind(globalThis),
}) {
  const pointers = new Map();
  let moved = false, pinched = false, initialTarget = null, initialSelection = null, initialClient = null, initialAdditive = false;
  const selectionFor = (target, event) => resolveSelection(target, event) || ({ type: target.dataset.type, id: target.dataset.id,
    ...(target.dataset.activation ? { activation: target.dataset.activation } : {}) });
  const selectTarget = (target, additive = false, event) => onSelect({ ...selectionFor(target, event), ...(additive ? { additive: true } : {}) });
  const point = (event) => {
    const p = new DOMPoint(event.clientX, event.clientY).matrixTransform(svg.getScreenCTM().inverse());
    return { x: p.x, y: p.y };
  };
  let camera;
  let gestureUpdate = false, pendingPaint = null, paintFrame = null;
  function paint({ view, fitted, metadata }) {
    updateCursor(view, metadata.minScale);
    viewport.setAttribute('transform', `translate(${view.x} ${view.y}) scale(${view.k})`);
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
    svg.classList.toggle('is-pannable', pannable);
    svg.classList.toggle('is-dragging', pannable && pointers.size > 0);
  }
  camera = createCamera({ getFrame, getHomeFrame,
    measureFit: frame => measureCameraFit(svg, frame, fitInsets),
    cameraMotion: { reducedMotion: () => globalThis.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches ?? false, ...cameraMotion },
    onChange: publish,
  });
  const center = pair => ({ x: (pair[0].x + pair[1].x) / 2, y: (pair[0].y + pair[1].y) / 2 });
  const distance = pair => Math.hypot(pair[0].x - pair[1].x, pair[0].y - pair[1].y);
  svg.addEventListener('pointerdown', event => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    if (!pointers.size) {
      moved = false; pinched = false; initialTarget = event.target.closest('[data-type]'); initialClient = { x: event.clientX, y: event.clientY };
      // Resolve while the pressed SVG target still exists. Hover redraws may
      // replace it before pointerup; a tap must keep its original exact angle.
      initialSelection = initialTarget ? selectionFor(initialTarget, event) : null;
      // The first press owns both the target and modifier for this gesture.
      initialAdditive = Boolean(event.shiftKey);
    }
    pointers.set(event.pointerId, point(event));
    if (pointers.size > 1) pinched = true;
    svg.setPointerCapture(event.pointerId);
    updateCursor();
  });
  svg.addEventListener('pointermove', event => {
    if (!pointers.has(event.pointerId)) return;
    const before = [...pointers.values()];
    const old = pointers.get(event.pointerId);
    const current = point(event);
    pointers.set(event.pointerId, current);
    if (Math.hypot(event.clientX - initialClient.x, event.clientY - initialClient.y) > 6) moved = true;
    if (pointers.size === 1) {
      if (moved || pinched) updateGesture(() => camera.pan(current.x - old.x, current.y - old.y));
    } else if (pointers.size === 2) {
      const after = [...pointers.values()];
      const oldCenter = center(before), nextCenter = center(after);
      updateGesture(() => camera.zoomAt(oldCenter, distance(after) / Math.max(distance(before), 1),
        nextCenter.x - oldCenter.x, nextCenter.y - oldCenter.y));
    }
  });
  function release(event) {
    if (!pointers.has(event.pointerId)) return;
    flushPaint();
    const tap = event.type === 'pointerup' && pointers.size === 1 && !moved && !pinched
      && Math.hypot(event.clientX - initialClient.x, event.clientY - initialClient.y) <= 6;
    pointers.delete(event.pointerId);
    if (svg.hasPointerCapture(event.pointerId)) svg.releasePointerCapture(event.pointerId);
    updateCursor();
    if (tap) {
      if (initialSelection) onSelect({ ...initialSelection, ...(initialAdditive ? { additive: true } : {}) });
      else onBackgroundTap();
    }
  }
  svg.addEventListener('pointerup', release);
  svg.addEventListener('pointercancel', release);
  svg.addEventListener('lostpointercapture', event => { flushPaint(); pointers.delete(event.pointerId); updateCursor(); });
  svg.addEventListener('wheel', event => {
    event.preventDefault();
    const anchor = point(event);
    updateGesture(() => camera.zoomAt(anchor, Math.exp(-clamp(event.deltaY, -200, 200) * 0.003)));
  }, { passive: false });
  svg.addEventListener('keydown', event => {
    const target = event.target.closest('[data-type]');
    if (target && ['Enter', ' '].includes(event.key)) { event.preventDefault(); selectTarget(target, Boolean(event.shiftKey), event); }
    if (event.target === svg && ['+', '-', '0'].includes(event.key)) { event.preventDefault(); camera.zoom(event.key === '+' ? 1.25 : event.key === '-' ? 0.8 : 1); if (event.key === '0') camera.reset(); }
  });
  return camera;
}
