// Compare the displayed chart with the reference, never a pending slider target.
export function isReferenceMoment(displayedUtc, referenceUtc) {
  const utc = value => typeof value === 'string' ? Date.parse(value) : value;
  const displayed = utc(displayedUtc), reference = utc(referenceUtc);
  return Number.isFinite(displayed) && Number.isFinite(reference) && displayed === reference;
}

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

// The visible 22 × 8.5px lens shrinks into a centered 8.5px circle over its
// final 11px of travel. All timelines share at most 65 small SVG images.
const THUMB_TIP_REACH = 11, THUMB_ROUNDING_STEPS = 64;
const thumbImages = [];
function thumbImage(frame) {
  if (thumbImages[frame]) return thumbImages[frame];
  const progress = frame / THUMB_ROUNDING_STEPS;
  const between = (lens, circle) => Number((lens + (circle - lens) * progress).toFixed(3));
  const radius = 4.25, arc = radius * 4 * (Math.SQRT2 - 1) / 3;
  const left = 22 - radius, right = 22 + radius, upper = 22 - arc, lower = 22 + arc;
  const path = `M${between(11, left)} 22
    C${between(16, left)} ${between(22, upper)} ${between(16.5, upper)} 17.75 ${between(22.5, 22)} 17.75
    C${between(28, lower)} 17.75 ${between(27.5, right)} ${between(22, upper)} ${between(33, right)} 22
    C${between(28, right)} ${between(22, lower)} ${between(27, lower)} 26.25 ${between(21.5, 22)} 26.25
    C${between(16, upper)} 26.25 ${between(16, left)} ${between(22, lower)} ${between(11, left)} 22Z`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="44" height="44" viewBox="0 0 44 44">
    <defs><linearGradient id="a" x1="0" y1="0" x2="0" y2="1"><stop stop-color="#aaaaaa"/><stop offset="1" stop-color="#777777"/></linearGradient></defs>
    <path d="${path}" fill="url(#a)"/>
    <path d="M19.5 20.5Q22 19.5 24 20.5" stroke="#ffffff" stroke-opacity=".32" stroke-width=".8" stroke-linecap="round" fill="none"/>
  </svg>`;
  return thumbImages[frame] = `url("data:image/svg+xml,${encodeURIComponent(svg.replace(/\s+/g, ' '))}")`;
}

// Mouse and keyboard retain the native range. Touch/pen use its entire transparent
// input rectangle, including the larger coarse-pointer hit area, so grabbing the
// small visible dot does not depend on browser-specific native thumb hit testing.
// A reference tap still waits for release; dragging always scrubs. The 44px thumb
// width and 22px rail inset keep the visible endpoints and value mapping stable.
export function attachTimelineRange({ range, marker = null, onScrub, onReference, onStep = null,
  onInteractionChange = () => {}, thumbSize = 44, movementThreshold = 8, tapDuration = 500,
  now = () => globalThis.performance?.now() ?? Date.now(), resolveTap = () => null, resolveEdge = () => null,
}) {
  let interacting = false;
  const interaction = value => { if (value !== interacting) { interacting = value; onInteractionChange(value); } };
  let reference = null, available = false, gesture = null, suppressClickUntil = -Infinity, suppressedInputValue = null;
  const bounds = () => {
    const min = Number(range.min || 0), max = Number(range.max || 100);
    return { min, max, step: range.step === 'any' ? null : Number(range.step) > 0 ? Number(range.step) : 1 };
  };
  const canScrub = () => !range.disabled && !range.hidden && !range.closest?.('[hidden]');
  const canReturn = () => marker && available && canScrub() && !marker.disabled;
  let railWidth = Math.max(0, range.getBoundingClientRect().width - thumbSize), thumbFrame = null;
  function updateThumbEdge() {
    const { min, max } = bounds(), value = Number(range.value);
    const edge = max <= min ? 'none' : value === min ? 'start' : value === max ? 'end'
      : resolveEdge({ min, max, value }) || 'none';
    if (range.getAttribute('data-edge') !== edge) range.setAttribute('data-edge', edge);
    const distance = max > min && railWidth > 0
      ? Math.min(value - min, max - value) / (max - min) * railWidth : Infinity;
    const progress = edge === 'start' || edge === 'end' ? 1 : clamp(1 - distance / THUMB_TIP_REACH, 0, 1);
    const frame = Math.round(progress * THUMB_ROUNDING_STEPS);
    if (frame === thumbFrame) return;
    thumbFrame = frame;
    range.style.setProperty('--timeline-thumb', thumbImage(frame));
    range.style.setProperty('--timeline-thumb-rounding', String(frame / THUMB_ROUNDING_STEPS));
  }
  // Width belongs to layout, not the selected minute. Observe it once instead
  // of forcing a fresh layout on each scrub, clock tick or chart response.
  const ResizeObserver = range.ownerDocument?.defaultView?.ResizeObserver ?? globalThis.ResizeObserver;
  if (ResizeObserver) {
    new ResizeObserver(([entry]) => {
      railWidth = Math.max(0, entry.contentRect.width - thumbSize);
      updateThumbEdge();
    }).observe(range);
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
    interaction(false);
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
    interaction(true);
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
    if (!gesture) { interaction(false); updateHover(event); return; }
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
    interaction(false);
    if (gesture?.pointerId === event.pointerId) { suppressClickUntil = now() + 500; clearGesture(); }
    hoverPointer = null; setEventHover(false);
  });
  range.addEventListener('lostpointercapture', event => {
    interaction(false);
    if (gesture?.pointerId === event.pointerId) { clearGesture(); hoverPointer = null; setEventHover(false); }
  });
  range.ownerDocument?.addEventListener?.('pointerup', () => interaction(false));
  range.addEventListener('change', () => interaction(false));
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
