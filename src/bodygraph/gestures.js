const clamp = (value, low, high) => Math.max(low, Math.min(high, value));

// One camera frame for every chart, independent of activations, labels or selection.
export const DRAWING_BOUNDS = Object.freeze({ x: -52, y: 28, width: 744, height: 740 });

export function zoomAt(view, point, factor, { min = 0.65, max = 4.5 } = {}) {
  const k = clamp(view.k * factor, min, max);
  const ratio = k / view.k;
  return { x: point.x - (point.x - view.x) * ratio, y: point.y - (point.y - view.y) * ratio, k };
}

export function validView(value) {
  return value && ['x', 'y', 'k'].every(key => Number.isFinite(value[key])) && value.k >= 0.65 && value.k <= 4.5 && Math.abs(value.x) <= 5000 && Math.abs(value.y) <= 6000;
}

export function fitView(bounds, area) {
  const k = clamp(Math.min(area.width / bounds.width, area.height / bounds.height), 0.65, 4.5);
  return { k, x: area.x + area.width / 2 - (bounds.x + bounds.width / 2) * k, y: area.y + area.height / 2 - (bounds.y + bounds.height / 2) * k };
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

export function attachGestures(svg, viewport, { onSelect, onChange, onBackgroundTap = () => {} }) {
  let view = { x: 0, y: 0, k: 1 };
  let fittedView = { ...view };
  const pointers = new Map();
  let moved = false, pinched = false, initialTarget = null, initialClient = null, initialAdditive = false;
  const selectTarget = (target, additive = false) => onSelect({ type: target.dataset.type, id: target.dataset.id,
    ...(target.dataset.activation ? { activation: target.dataset.activation } : {}),
    ...(additive ? { additive: true } : {}) });
  const point = (event) => {
    const p = new DOMPoint(event.clientX, event.clientY).matrixTransform(svg.getScreenCTM().inverse());
    return { x: p.x, y: p.y };
  };
  function updateCursor() {
    const pannable = view.k > fittedView.k * (1 + 1e-9);
    svg.classList.toggle('is-pannable', pannable);
    svg.classList.toggle('is-dragging', pannable && pointers.size > 0);
  }
  const zoom = (anchor, factor) => zoomAt(view, anchor, factor, { min: fittedView.k, max: 4.5 });
  function apply() {
    view = constrainView(view, fittedView);
    updateCursor();
    viewport.setAttribute('transform', `translate(${view.x} ${view.y}) scale(${view.k})`);
    onChange({ ...view }, { ...fittedView });
  }
  function defaultView() {
    const rect = svg.getBoundingClientRect(), matrix = svg.getScreenCTM().inverse();
    const side = rect.width < 700 ? 22 : 64;
    const top = new DOMPoint(rect.left + side, rect.top + (rect.width < 700 ? 128 : 86)).matrixTransform(matrix);
    const bottom = new DOMPoint(rect.right - side, rect.bottom - 72).matrixTransform(matrix);
    return fitView(DRAWING_BOUNDS, { x: top.x, y: top.y, width: Math.max(100, bottom.x - top.x), height: Math.max(100, bottom.y - top.y) });
  }
  function fit() {
    fittedView = defaultView();
    view = { ...fittedView };
    apply();
  }
  const center = pair => ({ x: (pair[0].x + pair[1].x) / 2, y: (pair[0].y + pair[1].y) / 2 });
  const distance = pair => Math.hypot(pair[0].x - pair[1].x, pair[0].y - pair[1].y);
  svg.addEventListener('pointerdown', event => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    if (!pointers.size) {
      moved = false; pinched = false; initialTarget = event.target.closest('[data-type]'); initialClient = { x: event.clientX, y: event.clientY };
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
      if (moved && !pinched) { view.x += current.x - old.x; view.y += current.y - old.y; apply(); }
      else if (pinched) { view.x += current.x - old.x; view.y += current.y - old.y; apply(); }
    } else if (pointers.size === 2) {
      const after = [...pointers.values()];
      const oldCenter = center(before), nextCenter = center(after);
      view = zoom(oldCenter, distance(after) / Math.max(distance(before), 1));
      view.x += nextCenter.x - oldCenter.x;
      view.y += nextCenter.y - oldCenter.y;
      apply();
    }
  });
  function release(event) {
    if (!pointers.has(event.pointerId)) return;
    const tap = event.type === 'pointerup' && pointers.size === 1 && !moved && !pinched
      && Math.hypot(event.clientX - initialClient.x, event.clientY - initialClient.y) <= 6;
    pointers.delete(event.pointerId);
    if (svg.hasPointerCapture(event.pointerId)) svg.releasePointerCapture(event.pointerId);
    updateCursor();
    if (tap) {
      if (initialTarget) selectTarget(initialTarget, initialAdditive);
      else onBackgroundTap();
    }
  }
  svg.addEventListener('pointerup', release);
  svg.addEventListener('pointercancel', release);
  svg.addEventListener('lostpointercapture', event => { pointers.delete(event.pointerId); updateCursor(); });
  svg.addEventListener('wheel', event => {
    event.preventDefault();
    view = zoom(point(event), Math.exp(-clamp(event.deltaY, -200, 200) * 0.003));
    apply();
  }, { passive: false });
  svg.addEventListener('keydown', event => {
    const target = event.target.closest('[data-type]');
    if (target && ['Enter', ' '].includes(event.key)) { event.preventDefault(); selectTarget(target, Boolean(event.shiftKey)); }
    if (event.target === svg && ['+', '-', '0'].includes(event.key)) { event.preventDefault(); controls.zoom(event.key === '+' ? 1.25 : event.key === '-' ? 0.8 : 1); if (event.key === '0') controls.reset(); }
  });
  const controls = {
    zoom(factor) { view = zoom({ x: 320, y: 410 }, factor); apply(); },
    reset() { fit(); },
    resize() {
      const next = defaultView(), ratio = next.k / fittedView.k;
      view = { x: next.x + (view.x - fittedView.x) * ratio, y: next.y + (view.y - fittedView.y) * ratio, k: view.k * ratio };
      fittedView = next;
      apply();
    },
    getView() { return { ...view }; },
    setView(value) { if (validView(value)) { view = { ...value }; apply(); } else fit(); }
  };
  apply();
  return controls;
}
