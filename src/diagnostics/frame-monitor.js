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
  let cursor = 0, sampleCount = 0, durationMs = 0, longGapCount = 0;
  let active = false, destroyed = false, pending = null;
  let lastFrameAt = null, activeUntil = 0, lastPublishedAt = -Infinity;
  let snapshot = null;

  function getSnapshot() {
    if (snapshot) return snapshot;
    // Sorting happens only for a published/requested snapshot, never on each frame.
    const ordered = Array.from(intervals.subarray(0, sampleCount)).sort((a, b) => a - b);
    let recentSampleCount = 0, recentDurationMs = 0;
    while (recentSampleCount < sampleCount && recentDurationMs < RECENT_WINDOW_MS) {
      const index = (cursor - 1 - recentSampleCount + SAMPLE_LIMIT) % SAMPLE_LIMIT;
      // Keep the whole boundary interval so a long stall cannot be shortened away.
      recentDurationMs += intervals[index];
      recentSampleCount += 1;
    }
    snapshot = Object.freeze({
      active,
      fps: sampleCount ? 1000 * sampleCount / durationMs : null,
      recentFps: recentSampleCount ? 1000 * recentSampleCount / recentDurationMs : null,
      recentDurationMs,
      recentSampleCount,
      meanIntervalMs: sampleCount ? durationMs / sampleCount : null,
      p95IntervalMs: sampleCount ? ordered[Math.ceil(sampleCount * 0.95) - 1] : null,
      maxIntervalMs: sampleCount ? ordered[sampleCount - 1] : null,
      longGapCount,
      sampleCount,
      durationMs,
      sampleLimit: SAMPLE_LIMIT,
      longGapThresholdMs: LONG_GAP_MS,
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
      durationMs -= intervals[cursor];
      if (intervals[cursor] > LONG_GAP_MS) longGapCount -= 1;
    } else sampleCount += 1;
    intervals[cursor] = interval;
    cursor = (cursor + 1) % SAMPLE_LIMIT;
    durationMs += interval;
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
        snapshot = null;
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
    snapshot = null;
  }

  return {
    activity() {
      if (destroyed) return;
      const time = now();
      activeUntil = time + idleMs;
      if (!active) {
        active = true;
        lastFrameAt = null;
        snapshot = null;
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
      durationMs = 0;
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
