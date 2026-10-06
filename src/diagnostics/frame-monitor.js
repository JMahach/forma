const SAMPLE_LIMIT = 600;
const LONG_GAP_MS = 50;
const RECENT_WINDOW_MS = 1000;

// Measures rAF callback cadence during interaction, not frames displayed by the GPU.
// Recent FPS uses about one second of movement; other metrics use at most 600 intervals.
// Time between interactions is excluded from both windows.
export function createFrameMonitor({
  requestFrame = callback => globalThis.requestAnimationFrame(callback),
  cancelFrame = handle => globalThis.cancelAnimationFrame(handle),
  now = () => performance.now(),
  onUpdate = () => {},
  publishIntervalMs = 250,
  idleMs = 200,
} = {}) {
  const intervals = new Float64Array(SAMPLE_LIMIT);
  let cursor = 0, sampleCount = 0, longGapCount = 0;
  let active = false, destroyed = false, pending = null;
  let lastFrameAt = null, activeUntil = 0, lastPublishedAt = -Infinity;
  let snapshot = null;

  function getSnapshot() {
    if (snapshot) return snapshot;
    let recentSampleCount = 0, recentDurationMs = 0, maxIntervalMs = null;
    for (let offset = 0; offset < sampleCount; offset += 1) {
      const interval = intervals[(cursor - 1 - offset + SAMPLE_LIMIT) % SAMPLE_LIMIT];
      maxIntervalMs = maxIntervalMs === null ? interval : Math.max(maxIntervalMs, interval);
      if (recentDurationMs < RECENT_WINDOW_MS) {
        // Keep the whole boundary interval so a long stall cannot be shortened away.
        recentDurationMs += interval;
        recentSampleCount += 1;
      }
    }
    snapshot = Object.freeze({
      recentFps: recentSampleCount ? 1000 * recentSampleCount / recentDurationMs : null,
      recentSampleCount,
      maxIntervalMs,
      longGapCount,
      sampleCount,
    });
    return snapshot;
  }

  function publish(time, final = false) {
    if (destroyed || (!final && time - lastPublishedAt < publishIntervalMs)) return;
    lastPublishedAt = time;
    onUpdate(getSnapshot());
  }

  function record(interval) {
    if (sampleCount === SAMPLE_LIMIT) {
      if (intervals[cursor] > LONG_GAP_MS) longGapCount -= 1;
    } else sampleCount += 1;
    intervals[cursor] = interval;
    cursor = (cursor + 1) % SAMPLE_LIMIT;
    if (interval > LONG_GAP_MS) longGapCount += 1;
    snapshot = null;
  }

  function schedule() {
    if (pending || !active || destroyed) return;
    const token = { handle: null };
    pending = token;
    token.handle = requestFrame(() => {
      if (pending !== token || destroyed || !active) return;
      pending = null;
      const time = now();
      // The first callback establishes a baseline: event-to-rAF is a partial frame.
      if (lastFrameAt !== null && time > lastFrameAt) record(time - lastFrameAt);
      lastFrameAt = time;
      if (time >= activeUntil) {
        // Keep a delayed final callback in the statistics before stopping.
        active = false;
        lastFrameAt = null;
        publish(time, true);
      } else publish(time);
      schedule();
    });
  }

  function cancel() {
    const token = pending;
    pending = null;
    if (token) cancelFrame(token.handle);
    active = false;
    lastFrameAt = null;
  }

  return {
    activity() {
      if (destroyed) return;
      const time = now();
      activeUntil = time + idleMs;
      if (!active) {
        active = true;
        lastFrameAt = null;
      }
      schedule();
      publish(time);
    },
    stop() {
      if (destroyed || !active) return;
      cancel();
      publish(now(), true);
    },
    reset() {
      if (destroyed) return;
      cancel();
      cursor = 0;
      sampleCount = 0;
      snapshot = null;
      longGapCount = 0;
      publish(now(), true);
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      cancel();
    },
    getSnapshot,
  };
}
