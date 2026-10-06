import { ACTIVATION_COLUMN_REVEAL_DISTANCE } from '../geometry/activation-layout.js';

// The viewport survives SVG redraws. Keep one reveal progress there so the ring
// and activation columns continue together even when render() replaces them.
export function createMandalaMotion({
  viewport, distance = ACTIVATION_COLUMN_REVEAL_DISTANCE, durationMs = 200,
  now = () => globalThis.performance?.now() ?? Date.now(),
  requestFrame = globalThis.requestAnimationFrame?.bind(globalThis),
  cancelFrame = globalThis.cancelAnimationFrame?.bind(globalThis),
  reducedMotion = () => globalThis.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches ?? false,
  onUpdate = () => {}, onFinish = () => {},
}) {
  const revealProperty = '--mandala-reveal', offsetProperty = '--activation-column-offset';
  let progress = 0, target = 0, motion = null, frame = null, generation = 0, disposed = false;
  viewport.style.setProperty(revealProperty, '0');
  viewport.style.setProperty(offsetProperty, '0px');

  function paint(value) {
    if (value === progress) return;
    progress = value;
    viewport.style.setProperty(revealProperty, String(value));
    viewport.style.setProperty(offsetProperty, `${distance * value}px`);
    onUpdate();
  }

  function sample(time) {
    if (!motion) return progress;
    const fraction = Math.min(1, Math.max(0, (time - motion.start) / motion.duration));
    if (fraction === 1) return target;
    const eased = fraction * fraction * (3 - 2 * fraction);
    return motion.from + (target - motion.from) * eased;
  }

  function cancel() {
    generation++;
    if (frame !== null) cancelFrame?.(frame);
    frame = null;
  }

  function schedule() {
    const current = generation;
    frame = requestFrame(() => {
      if (disposed || current !== generation) return;
      frame = null;
      paint(reducedMotion() ? target : sample(now()));
      if (disposed || current !== generation) return;
      if (progress === target) finish();
      else schedule();
    });
  }

  function finish() {
    const current = generation, enabled = target === 1;
    motion = null;
    paint(target);
    if (!disposed && current === generation) onFinish(enabled);
  }

  function setExpanded(expanded, { animate = true } = {}) {
    if (disposed) return;
    const next = expanded ? 1 : 0;
    if (next === target) {
      if (motion && (!animate || reducedMotion())) {
        cancel(); finish();
      }
      return;
    }

    const time = now(), from = sample(time);
    cancel();
    motion = null;
    target = next;
    const current = generation;
    paint(from);
    if (disposed || current !== generation) return;
    if (!animate || !requestFrame || reducedMotion() || durationMs <= 0 || from === target) {
      finish();
      return;
    }

    // Reversing midway travels only the remaining distance, without a new jump
    // to either endpoint or a full-duration animation for a tiny movement.
    motion = { from, start: time, duration: durationMs * Math.abs(target - from) };
    schedule();
  }

  return {
    setExpanded,
    get active() { return motion !== null; },
    get expanded() { return target === 1; },
    dispose() {
      if (disposed) return;
      disposed = true;
      cancel(); motion = null;
      viewport.style.removeProperty(revealProperty);
      viewport.style.removeProperty(offsetProperty);
    },
  };
}
