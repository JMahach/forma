import test from 'node:test';
import assert from 'node:assert/strict';
import { createFrameMonitor } from '../src/diagnostics/frame-monitor.js';

function harness(options = {}) {
  let time = 0, nextHandle = 0;
  const scheduled = new Map(), callbacks = new Map(), updates = [];
  const monitor = createFrameMonitor({
    ...options,
    now: () => time,
    requestFrame(callback) {
      const handle = nextHandle++;
      scheduled.set(handle, callback);
      callbacks.set(handle, callback);
      return handle;
    },
    cancelFrame: handle => scheduled.delete(handle),
    onUpdate: snapshot => updates.push({ time, snapshot }),
  });
  return {
    monitor, scheduled, updates,
    activity(at = time) { time = at; monitor.activity(); },
    frame(at) {
      time = at;
      const current = [...scheduled];
      for (const [handle, callback] of current) {
        scheduled.delete(handle);
        callback(time);
      }
    },
    invoke(handle, at) { time = at; callbacks.get(handle)?.(time); },
  };
}

function close(actual, expected, message) {
  assert.ok(Math.abs(actual - expected) < 1e-7, `${message}: ${actual} vs ${expected}`);
}

for (const hz of [60, 120]) {
  test(`estimates ${hz} Hz using complete intervals, excluding the first partial frame`, () => {
    const h = harness();
    const step = 1000 / hz;
    h.activity(step - 0.1);
    h.frame(step);
    assert.equal(h.monitor.getSnapshot().fps, null);
    for (let index = 2; index <= hz + 1; index += 1) {
      h.activity(index * step - 0.1);
      h.frame(index * step);
    }
    const value = h.monitor.getSnapshot();
    assert.equal(value.sampleCount, hz);
    close(value.fps, hz, 'estimated rate');
    close(value.recentFps, hz, 'recent estimated rate');
    close(value.meanIntervalMs, step, 'mean');
    close(value.p95IntervalMs, step, 'p95');
    close(value.maxIntervalMs, step, 'maximum');
    close(value.durationMs, 1000, 'measured duration');
    assert.equal(value.longGapCount, 0);
    assert.equal(h.scheduled.size, 1);
    h.monitor.stop();
  });
}

test('records a stalled final callback even after the idle deadline, then goes fully idle', () => {
  const h = harness();
  h.activity(0);
  h.frame(16);
  h.frame(32);
  h.frame(300);
  const value = h.monitor.getSnapshot();
  assert.equal(value.active, false);
  assert.equal(value.sampleCount, 2);
  assert.equal(value.durationMs, 284);
  assert.equal(value.maxIntervalMs, 268);
  assert.equal(value.p95IntervalMs, 268);
  assert.equal(value.longGapCount, 1);
  close(value.fps, 2000 / 284, 'rate includes the stall');
  assert.equal(h.scheduled.size, 0);
  assert.deepEqual(h.updates.at(-1).snapshot, value);
  const before = h.updates.length;
  h.frame(30_000);
  assert.equal(h.updates.length, before);
  assert.equal(h.monitor.getSnapshot(), value);
});

test('separate activity bursts preserve statistics without measuring the pause between them', () => {
  const h = harness({ idleMs: 20 });
  h.activity(0);
  h.frame(10);
  h.frame(20);
  h.activity(10_000);
  h.frame(10_010);
  h.frame(10_020);
  const value = h.monitor.getSnapshot();
  assert.equal(value.sampleCount, 2);
  assert.equal(value.durationMs, 20);
  assert.equal(value.maxIntervalMs, 10);
  assert.equal(value.longGapCount, 0);
  assert.equal(value.fps, 100);
});

test('new movement extends the activity window without hiding a queued heavy interval', () => {
  const h = harness();
  h.activity(0);
  h.frame(16);
  h.activity(300);
  h.frame(320);
  const value = h.monitor.getSnapshot();
  assert.equal(value.active, true);
  assert.equal(value.sampleCount, 1);
  assert.equal(value.maxIntervalMs, 304);
  assert.equal(value.longGapCount, 1);
  assert.equal(h.scheduled.size, 1);
  h.monitor.stop();
});

test('stop cancels pending work, and stale callbacks cannot consume a newer measurement', () => {
  const h = harness();
  assert.equal(h.scheduled.size, 0, 'construction does not start a background loop');
  h.activity(0);
  h.activity(1);
  assert.deepEqual([...h.scheduled.keys()], [0], 'handle zero still represents pending work');
  h.frame(16);
  h.frame(32);
  const stale = [...h.scheduled.keys()][0];
  h.monitor.stop();
  assert.equal(h.scheduled.size, 0);
  const stopped = h.monitor.getSnapshot();
  const publications = h.updates.length;
  h.monitor.stop();
  h.invoke(stale, 1000);
  assert.equal(h.updates.length, publications, 'stopped/stale notifications are silent');
  assert.equal(h.monitor.getSnapshot(), stopped);
  h.activity(2000);
  const current = [...h.scheduled.keys()][0];
  h.invoke(stale, 2010);
  assert.deepEqual([...h.scheduled.keys()], [current]);
  h.frame(2016);
  h.frame(2032);
  assert.equal(h.monitor.getSnapshot().sampleCount, 2);
  assert.equal(h.monitor.getSnapshot().durationMs, 32);
  h.monitor.stop();
});

test('reset clears the result and stops sampling until another activity', () => {
  const h = harness();
  h.activity(0);
  h.frame(16);
  h.frame(100);
  const stale = [...h.scheduled.keys()][0];
  h.monitor.reset();
  const empty = h.monitor.getSnapshot();
  assert.deepEqual(empty, {
    active: false, fps: null, recentFps: null, recentDurationMs: 0, recentSampleCount: 0,
    meanIntervalMs: null, p95IntervalMs: null,
    maxIntervalMs: null, longGapCount: 0, sampleCount: 0, durationMs: 0,
    sampleLimit: 600, longGapThresholdMs: 50,
  });
  assert.equal(h.scheduled.size, 0);
  h.invoke(stale, 1000);
  assert.equal(h.monitor.getSnapshot(), empty);
  h.activity(2000);
  h.frame(2010);
  h.frame(2020);
  assert.equal(h.monitor.getSnapshot().sampleCount, 1);
  assert.equal(h.monitor.getSnapshot().fps, 100);
  h.monitor.stop();
});

test('all metrics evict old samples together and storage stays bounded during a long interaction', () => {
  const h = harness();
  let time = 0;
  h.activity(time);
  h.frame(time);
  h.activity(time += 100);
  h.frame(time);
  for (let index = 0; index < 599; index += 1) {
    h.activity(time += 10);
    h.frame(time);
  }
  let value = h.monitor.getSnapshot();
  assert.equal(value.sampleCount, 600);
  assert.equal(value.durationMs, 6090);
  assert.equal(value.maxIntervalMs, 100);
  assert.equal(value.longGapCount, 1);
  for (let index = 0; index < 1201; index += 1) {
    h.activity(time += 10);
    h.frame(time);
  }
  value = h.monitor.getSnapshot();
  assert.equal(value.sampleCount, 600);
  assert.equal(value.durationMs, 6000);
  assert.equal(value.fps, 100);
  assert.equal(value.recentFps, 100);
  assert.equal(value.recentDurationMs, 1000);
  assert.equal(value.recentSampleCount, 100);
  assert.equal(value.meanIntervalMs, 10);
  assert.equal(value.p95IntervalMs, 10);
  assert.equal(value.maxIntervalMs, 10);
  assert.equal(value.longGapCount, 0);
  h.monitor.stop();
});

test('computes nearest-rank p95 and counts only intervals strictly longer than 50 ms', () => {
  const h = harness();
  let time = 0;
  h.activity(time);
  h.frame(time);
  const intervals = [...Array(18).fill(10), 50, 51];
  for (const interval of intervals) {
    h.activity(time += interval);
    h.frame(time);
  }
  const value = h.monitor.getSnapshot();
  assert.equal(value.sampleCount, 20);
  assert.equal(value.p95IntervalMs, 50);
  assert.equal(value.maxIntervalMs, 51);
  assert.equal(value.longGapThresholdMs, 50);
  assert.equal(value.longGapCount, 1);
  assert.equal(value.durationMs, 281);
  h.monitor.stop();
});

test('recent FPS follows a new 30 Hz section within about one second instead of averaging old 60 Hz frames', () => {
  const h = harness();
  let time = 0;
  h.activity(time);
  h.frame(time);
  for (const [count, hz] of [[480, 60], [35, 30]]) {
    for (let index = 0; index < count; index += 1) {
      h.activity(time += 1000 / hz);
      h.frame(time);
    }
  }
  const value = h.monitor.getSnapshot();
  assert.equal(value.sampleCount, 515);
  assert.ok(value.fps > 50, 'the full window still includes the earlier smooth section');
  close(value.recentFps, 30, 'recent estimate responds to the current section');
  assert.ok(value.recentDurationMs >= 1000);
  assert.ok(value.recentDurationMs < 1034);
  assert.ok(value.recentSampleCount >= 30 && value.recentSampleCount <= 31);
  h.monitor.stop();
});

test('recent FPS includes an entire heavy interval crossing the one-second boundary', () => {
  const h = harness();
  let time = 0;
  h.activity(time);
  h.frame(time);
  for (const interval of [10, 500, ...Array(9).fill(60)]) {
    h.activity(time += interval);
    h.frame(time);
  }
  const value = h.monitor.getSnapshot();
  assert.equal(value.sampleCount, 11);
  assert.equal(value.durationMs, 1050);
  assert.equal(value.recentSampleCount, 10);
  assert.equal(value.recentDurationMs, 1040, 'all 500 ms are retained, including the boundary overlap');
  close(value.recentFps, 10_000 / 1040, 'untrimmed recent estimate');
  h.activity(time += 1500);
  h.frame(time);
  const stalled = h.monitor.getSnapshot();
  assert.equal(stalled.recentSampleCount, 1);
  assert.equal(stalled.recentDurationMs, 1500);
  close(stalled.recentFps, 1000 / 1500, 'a single long stall retains its real duration');
  h.monitor.stop();
});

test('publishes at most every 250 ms during continuous movement, plus the final result', () => {
  const h = harness();
  h.activity(0);
  h.frame(0);
  for (let time = 10; time <= 1000; time += 10) {
    h.activity(time);
    h.frame(time);
  }
  assert.deepEqual(h.updates.map(update => update.time), [0, 250, 500, 750, 1000]);
  h.monitor.stop();
  assert.deepEqual(h.updates.map(update => update.time), [0, 250, 500, 750, 1000, 1000]);
  assert.equal(h.updates.at(-1).snapshot.active, false);
  assert.equal(h.updates.at(-1).snapshot.sampleCount, 100);
});

test('destroy permanently stops work and callbacks without discarding the last result', () => {
  const h = harness();
  h.activity(0);
  h.frame(16);
  h.frame(32);
  const stale = [...h.scheduled.keys()][0];
  h.monitor.destroy();
  const value = h.monitor.getSnapshot(), publications = h.updates.length;
  assert.equal(value.active, false);
  assert.equal(value.sampleCount, 1);
  assert.equal(h.scheduled.size, 0);
  h.invoke(stale, 1000);
  h.activity(2000);
  h.monitor.reset();
  h.monitor.stop();
  h.monitor.destroy();
  assert.equal(h.scheduled.size, 0);
  assert.equal(h.updates.length, publications);
  assert.equal(h.monitor.getSnapshot(), value);
});

test('returned snapshots cannot corrupt future statistics', () => {
  const h = harness();
  h.activity(0);
  h.frame(16);
  h.frame(32);
  const value = h.monitor.getSnapshot();
  assert.throws(() => { value.sampleCount = 999; }, TypeError);
  h.frame(48);
  assert.equal(value.sampleCount, 1);
  assert.equal(h.monitor.getSnapshot().sampleCount, 2);
  h.monitor.stop();
});
