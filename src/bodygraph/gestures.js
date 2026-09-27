const clamp = (value, low, high) => Math.max(low, Math.min(high, value));

// One camera frame for every chart, independent of activations, labels or selection.
export const DRAWING_BOUNDS = Object.freeze({ x: -52, y: 28, width: 744, height: 740 });

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

export function attachGestures(svg, viewport, { onSelect, onChange, onBackgroundTap = () => {}, getFrame = () => null, getHomeFrame = null, fitInsets = null, resolveSelection = () => null, cameraMotion = {} }) {
  let view = { x: 0, y: 0, k: 1 };
  let fittedView = { ...view };
  const activeFrame = () => getFrame() ?? { bounds: DRAWING_BOUNDS, minScale: 0.65 };
  const homeFrame = () => getHomeFrame?.() ?? activeFrame();
  const studioHome = typeof getHomeFrame === 'function';
  // One live camera. The studio can share a Home baseline across modes while
  // navigation admits the larger visible drawing without moving that camera.
  let navigationFrame = activeFrame(), navigationFit = { ...view };
  const sameView = (a, b) => a.x === b.x && a.y === b.y && a.k === b.k;
  const {
    durationMs = 200, now = () => globalThis.performance?.now() ?? Date.now(),
    requestFrame = globalThis.requestAnimationFrame?.bind(globalThis),
    cancelFrame = globalThis.cancelAnimationFrame?.bind(globalThis),
    reducedMotion = () => globalThis.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches ?? false,
  } = cameraMotion;
  let motion = null, animationFrame = null, generation = 0;
  const rebase = (value, from, to) => {
    if (sameView(from, to)) return { ...value };
    if (isHomeView(value, from)) return { ...to };
    const ratio = to.k / from.k;
    return { x: to.x + (value.x - from.x) * ratio, y: to.y + (value.y - from.y) * ratio, k: value.k * ratio };
  };
  const interpolate = (from, to, progress) => progress === 1 ? { ...to } : {
    x: from.x + (to.x - from.x) * progress,
    y: from.y + (to.y - from.y) * progress,
    k: from.k + (to.k - from.k) * progress,
  };
  const pointers = new Map();
  let moved = false, pinched = false, initialTarget = null, initialSelection = null, initialClient = null, initialAdditive = false;
  const selectionFor = (target, event) => resolveSelection(target, event) || ({ type: target.dataset.type, id: target.dataset.id,
    ...(target.dataset.activation ? { activation: target.dataset.activation } : {}) });
  const selectTarget = (target, additive = false, event) => onSelect({ ...selectionFor(target, event), ...(additive ? { additive: true } : {}) });
  const point = (event) => {
    const p = new DOMPoint(event.clientX, event.clientY).matrixTransform(svg.getScreenCTM().inverse());
    return { x: p.x, y: p.y };
  };
  // Studio Home is the zoom floor even when wider navigation bounds permit
  // panning around a ring. Standalone diagrams keep their existing frame floor.
  const minimumScale = () => studioHome ? fittedView.k : navigationFit.k;
  function updateCursor() {
    const pannable = view.k > minimumScale() * (1 + 1e-9);
    svg.classList.toggle('is-pannable', pannable);
    svg.classList.toggle('is-dragging', pannable && pointers.size > 0);
  }
  const zoom = (anchor, factor) => zoomAt(view, anchor, factor, { min: minimumScale(), max: 4.5 });
  function publish() {
    updateCursor();
    viewport.setAttribute('transform', `translate(${view.x} ${view.y}) scale(${view.k})`);
    onChange({ ...view }, { ...fittedView }, { minScale: minimumScale() });
  }
  const constrain = candidate => studioHome && candidate.k <= fittedView.k * (1 + 1e-9)
    ? { ...fittedView } : constrainView(candidate, navigationFit, navigationFrame.bounds);
  function apply() {
    view = constrain(view);
    publish();
  }
  function defaultView(frame = activeFrame()) {
    const rect = svg.getBoundingClientRect(), matrix = svg.getScreenCTM().inverse();
    const insets = typeof fitInsets === 'function' ? fitInsets() : fitInsets;
    const { bounds, minScale } = frame, flexible = Boolean(insets) || minScale < 0.65;
    // The normal chart retains its established frame. Wider optional frames can
    // shrink further, including on short landscape screens, without page scroll.
    // The studio supplies responsive safe areas without clipping the canvas.
    // Keep historical defaults for standalone diagrams and preview harnesses.
    const side = Math.min(insets?.side ?? (rect.width < 700 ? 22 : 64), flexible ? rect.width / 4 : Infinity);
    const topInset = Math.min(insets?.top ?? (rect.width < 700 ? 128 : 86), flexible ? rect.height * (insets ? 0.49 : 0.3) : Infinity);
    const bottomInset = Math.min(insets?.bottom ?? 72, flexible ? rect.height * (insets ? 0.49 : 0.2) : Infinity);
    // Translate both fitted edges by the same CSS-pixel offset; never turn the
    // visual gap adjustment into a smaller fitting area or negative safe inset.
    const offsetY = insets?.offsetY ?? 0;
    const top = new DOMPoint(rect.left + side, rect.top + topInset + offsetY).matrixTransform(matrix);
    const bottom = new DOMPoint(rect.right - side, rect.bottom - bottomInset + offsetY).matrixTransform(matrix);
    const area = { x: top.x, y: top.y, width: Math.max(flexible ? 1 : 100, bottom.x - top.x), height: Math.max(flexible ? 1 : 100, bottom.y - top.y) };
    const min = flexible ? Math.min(minScale, area.width / bounds.width, area.height / bounds.height) : minScale;
    return fitView(bounds, area, { min });
  }
  function fit() {
    cancelAnimation();
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
  function cancelAnimation() {
    generation++;
    if (animationFrame !== null) cancelFrame?.(animationFrame);
    animationFrame = null; motion = null;
  }
  function paintMotion(progress) {
    const nextHome = interpolate(motion.fromHome, motion.toHome, progress);
    // Rebase the *live* camera, not a captured starting view: wheel/pinch/pan
    // remain usable during the transition and keep their relative zoom/pan.
    view = rebase(view, fittedView, nextHome);
    fittedView = nextHome;
    navigationFit = interpolate(motion.fromNavigation, motion.toNavigation, progress);
    apply();
  }
  function finishAnimation() {
    if (motion) paintMotion(1);
    cancelAnimation();
  }
  function scheduleAnimation() {
    const current = generation;
    animationFrame = requestFrame(() => {
      if (current !== generation || !motion) return;
      animationFrame = null;
      const fraction = reducedMotion() ? 1 : clamp((now() - motion.start) / durationMs, 0, 1);
      paintMotion(fraction * fraction * (3 - 2 * fraction));
      if (current !== generation) return;
      if (fraction === 1) motion = null;
      else scheduleAnimation();
    });
  }
  function transitionHome(animate) {
    // A reversal starts from the last painted camera/Home, including any user
    // input since that frame. No intermediate baseline survives completion.
    cancelAnimation();
    const fromHome = { ...fittedView }, fromNavigation = { ...navigationFit }, fromView = { ...view };
    const toHome = defaultView(homeFrame());
    view = rebase(view, fromHome, toHome);
    navigationFit = rebase(navigationFit, fromHome, toHome);
    fittedView = toHome;
    expandNavigation();
    const toNavigation = { ...navigationFit };
    if (!animate || !requestFrame || reducedMotion() || durationMs <= 0 || sameView(fromHome, toHome)) {
      apply(); return;
    }
    view = fromView; fittedView = fromHome; navigationFit = fromNavigation;
    motion = { fromHome, toHome, fromNavigation, toNavigation, start: now() };
    // Home and the live view travel together, so a 100% mode change does not
    // briefly expose Home or a false zoom percentage while it is animating.
    publish();
    scheduleAnimation();
  }
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
      if (initialSelection) onSelect({ ...initialSelection, ...(initialAdditive ? { additive: true } : {}) });
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
    if (target && ['Enter', ' '].includes(event.key)) { event.preventDefault(); selectTarget(target, Boolean(event.shiftKey), event); }
    if (event.target === svg && ['+', '-', '0'].includes(event.key)) { event.preventDefault(); controls.zoom(event.key === '+' ? 1.25 : event.key === '-' ? 0.8 : 1); if (event.key === '0') controls.reset(); }
  });
  const controls = {
    zoom(factor) { view = zoom({ x: 320, y: 410 }, factor); apply(); },
    reset() { fit(); },
    refreshFrame() {
      finishAnimation();
      fittedView = defaultView(homeFrame());
      expandNavigation();
      publish();
    },
    transitionHome() { transitionHome(true); },
    resize() {
      if (studioHome) {
        // A delayed observer notification with unchanged geometry must not
        // cut short an in-flight mode transition or jump to its endpoint.
        if (motion && sameView(defaultView(homeFrame()), motion.toHome)) return;
        transitionHome(false); return;
      }
      finishAnimation();
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
    setView(value) { finishAnimation(); if (validView(value, { min: Math.min(navigationFrame.minScale, navigationFit.k) })) { view = { ...value }; apply(); } else fit(); }
  };
  apply();
  return controls;
}
