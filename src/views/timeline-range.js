// Compare the displayed chart with the reference, never a pending slider target.
export function isReferenceMoment(displayedUtc, referenceUtc) {
  const utc = value => typeof value === 'string' ? Date.parse(value) : value;
  const displayed = utc(displayedUtc), reference = utc(referenceUtc);
  return Number.isFinite(displayed) && Number.isFinite(reference) && displayed === reference;
}

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

// Mouse and keyboard retain the native range. Touch/pen use its entire transparent
// input rectangle, including the larger coarse-pointer hit area, so grabbing the
// small visible dot does not depend on browser-specific native thumb hit testing.
// A reference tap still waits for release; dragging always scrubs. The 44px thumb
// width and 22px rail inset keep the visible endpoints and value mapping stable.
export function attachTimelineRange({ range, marker = null, onScrub, onReference, onStep = null,
  thumbSize = 44, movementThreshold = 8, tapDuration = 500,
  now = () => globalThis.performance?.now() ?? Date.now(), resolveTap = () => null, resolveEdge = () => null,
}) {
  let reference = null, available = false, gesture = null, suppressClickUntil = -Infinity, suppressedInputValue = null;
  const bounds = () => {
    const min = Number(range.min || 0), max = Number(range.max || 100);
    return { min, max, step: range.step === 'any' ? null : Number(range.step) > 0 ? Number(range.step) : 1 };
  };
  const canScrub = () => !range.disabled && !range.hidden && !range.closest?.('[hidden]');
  const canReturn = () => marker && available && canScrub() && !marker.disabled;
  function updateThumbEdge() {
    const { min, max } = bounds(), value = Number(range.value);
    const edge = max <= min ? 'none' : value === min ? 'start' : value === max ? 'end'
      : resolveEdge({ min, max, value }) || 'none';
    if (range.getAttribute('data-edge') !== edge) range.setAttribute('data-edge', edge);
  }
  function geometry() {
    const rect = range.getBoundingClientRect();
    const inset = Math.min(thumbSize / 2, rect.width / 2);
    return { ...bounds(), left: rect.left + inset, width: Math.max(1, rect.width - inset * 2), height: rect.height, centerY: rect.top + rect.height / 2, rect };
  }
  const position = (value, metrics) => metrics.left + (metrics.max === metrics.min ? 0
    : (value - metrics.min) / (metrics.max - metrics.min)) * metrics.width;
  // Hover and press share the same event priority and hit areas on every scale.
  function targetAt(event, metrics) {
    let tapTarget = resolveTap(event, metrics);
    const referenceDistance = canReturn() ? Math.hypot(event.clientX - position(reference, metrics), event.clientY - metrics.centerY) : Infinity;
    const referenceTap = canReturn() && Math.abs(event.clientX - position(reference, metrics)) <= thumbSize / 2 && (!tapTarget || !tapTarget.direct && referenceDistance < tapTarget.distance);
    if (referenceTap) tapTarget = null;
    // The visible droplet owns its selected moment. Only a directly pointed
    // event label/dot may beat it, never a neighboring expanded hit rectangle.
    const onThumb = range.getAttribute('data-cursor-visible') !== 'false' && tapTarget && !tapTarget.direct && Math.abs(event.clientX - position(Number(range.value), metrics)) <= thumbSize / 4
      && Math.abs(event.clientY - metrics.centerY) <= thumbSize / 8;
    if (onThumb) tapTarget = null;
    return { tapTarget, referenceTap };
  }
  const rangeTitle = range.title || '';
  let eventHovered = false, eventPressed = false, hoverPointer = null, hoveredTarget = null, referenceHovered = false, pressedTarget = null;
  function setEventHover(value, target = null, referenceTap = false) {
    if (hoveredTarget?.hover !== target?.hover) {
      hoveredTarget?.hover?.(false); hoveredTarget = target; target?.hover?.(true);
    }
    if (referenceHovered !== referenceTap) {
      referenceHovered = referenceTap; marker?.setAttribute('data-hovered', String(referenceTap));
    }
    const title = referenceTap ? marker?.title || rangeTitle : target?.title || rangeTitle;
    if (range.title !== title) range.title = title;
    if (eventHovered === value) return;
    eventHovered = value;
    range.setAttribute('data-event-hovered', String(value));
  }
  function setEventPress(value) {
    if (eventPressed === value) return;
    eventPressed = value;
    range.setAttribute('data-event-pressed', String(value));
  }
  function rememberPointer(event) {
    hoverPointer = event?.pointerType === 'mouse'
      ? { pointerType: 'mouse', clientX: event.clientX, clientY: event.clientY, buttons: event.buttons } : null;
  }
  function updateHover(event = hoverPointer) {
    rememberPointer(event);
    if (!event || event.pointerType !== 'mouse' || event.buttons || gesture || !canScrub() || range.matches?.(':hover') === false) { setEventHover(false); return; }
    const metrics = geometry(), { rect } = metrics;
    if (event.clientX < rect.left || event.clientX > rect.left + rect.width
        || event.clientY < rect.top || event.clientY > rect.top + rect.height) { setEventHover(false); return; }
    const { tapTarget, referenceTap } = targetAt(event, metrics);
    const target = tapTarget && tapTarget.valid?.() !== false ? tapTarget : null;
    setEventHover(Boolean(referenceTap || target), target, referenceTap);
  }
  function updateContact() {
    const pointer = gesture?.pointer;
    const metrics = gesture?.metrics;
    const inside = pointer && pointer.clientX >= metrics.rect.left && pointer.clientX <= metrics.rect.left + metrics.rect.width
      && pointer.clientY >= metrics.rect.top && pointer.clientY <= metrics.rect.top + metrics.rect.height;
    const hit = inside && canScrub() ? targetAt(pointer, metrics) : null;
    const pressed = Boolean(hit?.referenceTap);
    if (marker && marker.getAttribute('data-pressed') !== String(pressed)) marker.setAttribute('data-pressed', String(pressed));
    const target = hit?.tapTarget?.valid?.() !== false ? hit?.tapTarget : null;
    if (pressedTarget?.press !== target?.press) {
      pressedTarget?.press?.(false); pressedTarget = target; target?.press?.(true);
    }
  }
  function clearGesture() {
    const previous = gesture;
    gesture = null;
    updateContact();
    setEventPress(false);
    if (previous && range.hasPointerCapture?.(previous.pointerId)) range.releasePointerCapture(previous.pointerId);
    return previous;
  }
  function move(event) {
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    event.preventDefault();
    if (!canScrub() || gesture.referenceTap && !canReturn()
        || !gesture.dragging && gesture.tapTarget?.valid?.() === false) { clearGesture(); return; }
    gesture.pointer = { clientX: event.clientX, clientY: event.clientY, pointerType: event.pointerType };
    updateContact();
    const dx = event.clientX - gesture.startX, dy = event.clientY - gesture.startY;
    if (!gesture.dragging && Math.hypot(dx, dy) <= (gesture.referenceTap || gesture.tapTarget ? movementThreshold : 0)) return;
    gesture.dragging = true;
    setEventPress(false);
    const { min, max, step, left, width } = gesture.metrics;
    // Starting on the thumb preserves the finger's grip offset, including when
    // the thumb and reference overlap. Else drag from the chosen track point.
    const raw = gesture.relative ? gesture.initialValue + dx / width * (max - min)
      : min + (event.clientX - left) / width * (max - min);
    const value = clamp(step === null ? raw : min + Math.round((raw - min) / step) * step, min, max);
    if (value === gesture.lastInput) return;
    gesture.lastInput = value;
    range.value = String(value);
    onScrub(value);
    updateThumbEdge();
    // Keep the accepted position when the owner resolves a continuous UTC
    // target to a cached minute or lifetime sample.
    if (gesture) gesture.lastValue = Number(range.value);
  }
  range.addEventListener('pointerdown', event => {
    suppressedInputValue = null;
    rememberPointer(event);
    setEventHover(false);
    if (gesture) {
      // A second pointer cancels a possible return; it cannot turn a pinch into
      // a click on the original moment.
      if (gesture.pointerId !== event.pointerId) { event.preventDefault(); clearGesture(); }
      return;
    }
    if (!canScrub() || event.isPrimary === false || event.button !== 0) return;
    const metrics = geometry();
    const touch = event.pointerType === 'touch' || event.pointerType === 'pen';
    const { tapTarget, referenceTap } = targetAt(event, metrics);
    if (!touch && !referenceTap && !tapTarget) return;
    event.preventDefault();
    const initialValue = Number(range.value);
    const gripRadius = touch ? Math.max(thumbSize / 2, metrics.height / 2) : thumbSize / 2;
    gesture = { pointerId: event.pointerId, pointer: { clientX: event.clientX, clientY: event.clientY, pointerType: event.pointerType }, startX: event.clientX, startY: event.clientY,
      startedAt: now(), metrics, initialValue, lastInput: initialValue, lastValue: initialValue, dragging: false, referenceTap, tapTarget,
      relative: range.getAttribute('data-cursor-visible') !== 'false' && Math.abs(event.clientX - position(initialValue, metrics)) <= gripRadius };
    setEventPress(Boolean(referenceTap || tapTarget));
    updateContact();
    range.focus?.({ preventScroll: true });
    range.setPointerCapture?.(event.pointerId);
    // A track tap away from both controls responds immediately. A loose grip on
    // the thumb starts from its current value instead of jumping under a finger.
    if (!referenceTap && !tapTarget && !gesture.relative) {
      gesture.dragging = true;
      move(event);
    }
  });
  range.addEventListener('pointermove', event => { updateHover(event); move(event); });
  range.addEventListener('pointerleave', () => { hoverPointer = null; setEventHover(false); });
  range.addEventListener('blur', () => { clearGesture(); hoverPointer = null; setEventHover(false); });
  range.addEventListener('pointerup', event => {
    rememberPointer(event);
    if (!gesture) { updateHover(event); return; }
    if (gesture.pointerId !== event.pointerId) return;
    move(event);
    const completed = clearGesture();
    suppressClickUntil = now() + 500;
    if (completed && !completed.dragging && now() - completed.startedAt <= tapDuration) {
      if (completed.tapTarget && completed.tapTarget.valid?.() !== false) completed.tapTarget.select();
      else if (completed.referenceTap && canReturn()) onReference();
    }
    suppressedInputValue = Number(range.value);
    updateHover(event);
  });
  range.addEventListener('pointercancel', event => {
    if (gesture?.pointerId === event.pointerId) { suppressClickUntil = now() + 500; clearGesture(); }
    hoverPointer = null; setEventHover(false);
  });
  range.addEventListener('lostpointercapture', event => {
    if (gesture?.pointerId === event.pointerId) { clearGesture(); hoverPointer = null; setEventHover(false); }
  });
  range.addEventListener('click', event => {
    if (event.detail > 0 && now() <= suppressClickUntil) event.preventDefault();
  });
  range.addEventListener('keydown', event => {
    suppressedInputValue = null;
    hoverPointer = null; setEventHover(false); clearGesture();
    if (!onStep || !canScrub() || event.altKey || event.ctrlKey || event.metaKey) return;
    const direction = ['ArrowRight', 'ArrowUp'].includes(event.key) ? 1
      : ['ArrowLeft', 'ArrowDown'].includes(event.key) ? -1 : 0;
    const edge = event.key === 'Home' || event.key === 'End';
    if (!direction && !edge) return;
    event.preventDefault();
    const value = direction ? onStep(direction) : event.key === 'Home' ? bounds().min : bounds().max;
    if (Number.isFinite(value)) onScrub(value);
    updateThumbEdge();
  });
  range.addEventListener('input', () => {
    if (gesture) { range.value = String(gesture.lastValue); return; }
    // Prevent a queued compatibility event after a captured release from
    // publishing the pointer target again. A new gesture/key clears this.
    if (suppressedInputValue !== null && now() <= suppressClickUntil) { range.value = String(suppressedInputValue); return; }
    if (canScrub()) onScrub(Number(range.value));
    updateThumbEdge();
  });
  marker?.addEventListener('click', event => {
    // Keyboard and assistive technology activate the semantic button. Pointer
    // clicks have already been resolved on the range, never on an overlay.
    if ((!event || !event.detail) && canReturn()) onReference();
  });

  function refreshTargets() {
    updateThumbEdge();
    if (!canScrub() || gesture?.referenceTap && !canReturn()
        || !gesture?.dragging && gesture?.tapTarget?.valid?.() === false) clearGesture();
    updateContact();
    updateHover();
  }
  return {
    refreshTargets,
    updateReference({ value, visible, label, title = label, active = false }) {
      const currentBounds = bounds();
      if (gesture && (gesture.metrics.min !== currentBounds.min || gesture.metrics.max !== currentBounds.max)) {
        clearGesture(); hoverPointer = null; setEventHover(false); suppressedInputValue = null;
      }
      if (gesture) gesture.lastValue = Number(range.value);
      if (suppressedInputValue !== null) suppressedInputValue = Number(range.value);
      const { min, max } = bounds();
      available = Boolean(visible && Number.isFinite(value));
      reference = available ? clamp(value, min, max) : null;
      if (marker) {
        marker.hidden = !available;
        marker.disabled = !available || range.disabled;
        marker.style.left = available ? `${(reference - min) / Math.max(1, max - min) * 100}%` : '';
        marker.title = title;
        marker.setAttribute('aria-label', label);
        marker.setAttribute('aria-pressed', String(available && active));
      }
      refreshTargets();
    },
  };
}
