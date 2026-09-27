const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

// The native range owns ordinary dragging and keyboard input. Only a gesture
// beginning near the reference needs arbitration: tap on release, or scrub.
// CSS must use a 44px native thumb and a reference rail inset by 22px. The
// reference button is keyboard-accessible but pointer-transparent, so it never
// covers the thumb with another hit target.
export function attachDayRange({ range, marker = null, onScrub, onReference,
  thumbSize = 44, movementThreshold = 8, tapDuration = 500,
  now = () => globalThis.performance?.now() ?? Date.now(),
}) {
  let reference = null, available = false, gesture = null, suppressClickUntil = -Infinity;
  const bounds = () => {
    const min = Number(range.min || 0), max = Number(range.max || 100);
    return { min, max, step: Number(range.step) > 0 ? Number(range.step) : 1 };
  };
  const canReturn = () => marker && available && !range.disabled && !marker.disabled;
  function geometry() {
    const rect = range.getBoundingClientRect();
    const inset = Math.min(thumbSize / 2, rect.width / 2);
    return { ...bounds(), left: rect.left + inset, width: Math.max(1, rect.width - inset * 2) };
  }
  const position = (value, metrics) => metrics.left + (metrics.max === metrics.min ? 0
    : (value - metrics.min) / (metrics.max - metrics.min)) * metrics.width;
  function clearGesture() {
    const previous = gesture;
    gesture = null;
    if (previous && range.hasPointerCapture?.(previous.pointerId)) range.releasePointerCapture(previous.pointerId);
    return previous;
  }
  function move(event) {
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    event.preventDefault();
    if (!canReturn()) { clearGesture(); return; }
    const dx = event.clientX - gesture.startX, dy = event.clientY - gesture.startY;
    if (!gesture.dragging && Math.hypot(dx, dy) <= movementThreshold) return;
    gesture.dragging = true;
    const { min, max, step, left, width } = gesture.metrics;
    // Starting on the thumb preserves the finger's grip offset, including when
    // the thumb and reference overlap. Else drag from the chosen track point.
    const raw = gesture.relative ? gesture.initialValue + dx / width * (max - min)
      : min + (event.clientX - left) / width * (max - min);
    const value = clamp(min + Math.round((raw - min) / step) * step, min, max);
    if (value === gesture.lastValue) return;
    gesture.lastValue = value;
    range.value = String(value);
    onScrub(value);
  }
  range.addEventListener('pointerdown', event => {
    if (gesture) {
      // A second pointer cancels a possible return; it cannot turn a pinch into
      // a click on the original moment.
      if (gesture.pointerId !== event.pointerId) { event.preventDefault(); clearGesture(); }
      return;
    }
    if (!canReturn() || event.isPrimary === false || event.button !== 0) return;
    const metrics = geometry();
    if (Math.abs(event.clientX - position(reference, metrics)) > thumbSize / 2) return;
    event.preventDefault();
    const initialValue = Number(range.value);
    gesture = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY,
      startedAt: now(), metrics, initialValue, lastValue: initialValue, dragging: false,
      relative: Math.abs(event.clientX - position(initialValue, metrics)) <= thumbSize / 2 };
    range.focus?.({ preventScroll: true });
    range.setPointerCapture?.(event.pointerId);
  });
  range.addEventListener('pointermove', move);
  range.addEventListener('pointerup', event => {
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    move(event);
    const completed = clearGesture();
    suppressClickUntil = now() + 500;
    if (completed && !completed.dragging && now() - completed.startedAt <= tapDuration && canReturn()) onReference();
  });
  range.addEventListener('pointercancel', event => {
    if (gesture?.pointerId === event.pointerId) { suppressClickUntil = now() + 500; clearGesture(); }
  });
  range.addEventListener('lostpointercapture', event => {
    if (gesture?.pointerId === event.pointerId) gesture = null;
  });
  range.addEventListener('click', event => {
    if (event.detail > 0 && now() <= suppressClickUntil) event.preventDefault();
  });
  range.addEventListener('keydown', () => clearGesture());
  range.addEventListener('input', () => {
    if (gesture) { range.value = String(gesture.lastValue); return; }
    if (!range.disabled) onScrub(Number(range.value));
  });
  marker?.addEventListener('click', event => {
    // Keyboard and assistive technology activate the semantic button. Pointer
    // clicks have already been resolved on the range, never on an overlay.
    if ((!event || !event.detail) && canReturn()) onReference();
  });

  return {
    updateReference({ value, visible, label, active = false }) {
      const { min, max } = bounds();
      available = Boolean(visible && Number.isFinite(value));
      reference = available ? clamp(value, min, max) : null;
      if (marker) {
        marker.hidden = !available;
        marker.disabled = !available || range.disabled;
        marker.style.left = available ? `${(reference - min) / Math.max(1, max - min) * 100}%` : '';
        marker.title = label;
        marker.setAttribute('aria-label', label);
        marker.setAttribute('aria-pressed', String(active));
      }
      if (!canReturn()) clearGesture();
    },
  };
}
