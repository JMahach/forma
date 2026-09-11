const clamp = (value, low, high) => Math.max(low, Math.min(high, value));

export function zoomAt(view, point, factor) {
  const k = clamp(view.k * factor, 0.65, 4.5);
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

export function attachGestures(svg, viewport, { onSelect, onChange }) {
  let view = { x: 0, y: 0, k: 1 };
  const pointers = new Map();
  let moved = false, pinched = false, initialTarget = null, initialClient = null;
  const point = (event) => {
    const p = new DOMPoint(event.clientX, event.clientY).matrixTransform(svg.getScreenCTM().inverse());
    return { x: p.x, y: p.y };
  };
  function apply() {
    // A free canvas: the fit control brings the drawing back when it is offscreen.
    view.x = clamp(view.x, -5000, 5000);
    view.y = clamp(view.y, -6000, 6000);
    viewport.setAttribute('transform', `translate(${view.x} ${view.y}) scale(${view.k})`);
    onChange({ ...view });
  }
  function fit() {
    const box = viewport.getBBox();
    if (!box.width || !box.height) { view = { x: 0, y: 0, k: 1 }; apply(); return; }
    const rect = svg.getBoundingClientRect(), matrix = svg.getScreenCTM().inverse();
    const side = rect.width < 700 ? 22 : 64;
    const top = new DOMPoint(rect.left + side, rect.top + 86).matrixTransform(matrix);
    const bottom = new DOMPoint(rect.right - side, rect.bottom - 72).matrixTransform(matrix);
    view = fitView(box, { x: top.x, y: top.y, width: Math.max(100, bottom.x - top.x), height: Math.max(100, bottom.y - top.y) });
    apply();
  }
  const center = pair => ({ x: (pair[0].x + pair[1].x) / 2, y: (pair[0].y + pair[1].y) / 2 });
  const distance = pair => Math.hypot(pair[0].x - pair[1].x, pair[0].y - pair[1].y);
  svg.addEventListener('pointerdown', event => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    if (!pointers.size) { moved = false; pinched = false; initialTarget = event.target.closest('[data-type]'); initialClient = { x: event.clientX, y: event.clientY }; }
    pointers.set(event.pointerId, point(event));
    if (pointers.size > 1) pinched = true;
    svg.setPointerCapture(event.pointerId);
    svg.classList.add('is-dragging');
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
      view = zoomAt(view, oldCenter, distance(after) / Math.max(distance(before), 1));
      view.x += nextCenter.x - oldCenter.x;
      view.y += nextCenter.y - oldCenter.y;
      apply();
    }
  });
  function release(event) {
    if (!pointers.has(event.pointerId)) return;
    const select = event.type === 'pointerup' && pointers.size === 1 && !moved && !pinched && initialTarget;
    pointers.delete(event.pointerId);
    if (svg.hasPointerCapture(event.pointerId)) svg.releasePointerCapture(event.pointerId);
    if (!pointers.size) svg.classList.remove('is-dragging');
    if (select) onSelect({ type: initialTarget.dataset.type, id: initialTarget.dataset.id });
  }
  svg.addEventListener('pointerup', release);
  svg.addEventListener('pointercancel', release);
  svg.addEventListener('lostpointercapture', event => { pointers.delete(event.pointerId); if (!pointers.size) svg.classList.remove('is-dragging'); });
  svg.addEventListener('wheel', event => {
    event.preventDefault();
    view = zoomAt(view, point(event), Math.exp(-clamp(event.deltaY, -200, 200) * 0.003));
    apply();
  }, { passive: false });
  svg.addEventListener('keydown', event => {
    const target = event.target.closest('[data-type]');
    if (target && ['Enter', ' '].includes(event.key)) { event.preventDefault(); onSelect({ type: target.dataset.type, id: target.dataset.id }); }
    if (event.target === svg && ['+', '-', '0'].includes(event.key)) { event.preventDefault(); controls.zoom(event.key === '+' ? 1.25 : event.key === '-' ? 0.8 : 1); if (event.key === '0') controls.reset(); }
  });
  const controls = {
    zoom(factor) { view = zoomAt(view, { x: 320, y: 410 }, factor); apply(); },
    reset() { fit(); },
    getView() { return { ...view }; },
    setView(value) { if (validView(value)) { view = { ...value }; apply(); } else fit(); }
  };
  apply();
  return controls;
}
