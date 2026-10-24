import test from 'node:test';
import assert from 'node:assert/strict';
import { attachMandalaMode } from '../src/scene/modes/mandala.ts';
import { MANDALA_FRAME, STUDIO_FRAME } from '../src/scene/geometry/frames.ts';
import { ACTIVATION_BLOCK_BOUNDS, ACTIVATION_COLUMN_REVEAL_DISTANCE, MANDALA_COLUMN_SPAN } from '../src/scene/geometry/activation-layout.ts';
import { DRAWING_BOUNDS } from '../src/scene/geometry/frames.ts';
import { renderActivationColumns } from '../src/scene/activation-columns.ts';
import { overlayFixture } from './helpers/chart-composition.ts';
import { SVG_NS, svgDocument } from './helpers/svg-dom.ts';

test('navigation includes enlarged columns and the complete outer planet envelope', () => {
  const { bounds } = MANDALA_FRAME;
  // Painted source envelopes after the 1.09 scale and existing mandala journeys.
  assert.ok(bounds.x <= -62.68 - ACTIVATION_COLUMN_REVEAL_DISTANCE);
  assert.ok(bounds.x + bounds.width >= 715.324 + ACTIVATION_COLUMN_REVEAL_DISTANCE);
  assert.equal(bounds.x, MANDALA_COLUMN_SPAN.left, 'navigation and capacity share the complete column footprint');
  assert.equal(bounds.width, MANDALA_COLUMN_SPAN.right - MANDALA_COLUMN_SPAN.left);
  assert.ok(bounds.x <= ACTIVATION_BLOCK_BOUNDS.x - ACTIVATION_COLUMN_REVEAL_DISTANCE);
  assert.ok(bounds.x + bounds.width >= ACTIVATION_BLOCK_BOUNDS.x + ACTIVATION_BLOCK_BOUNDS.width + ACTIVATION_COLUMN_REVEAL_DISTANCE);
  assert.ok(Math.abs(bounds.x - -388.99479166666674) < 1e-9, 'the enlarged left checkbox target fits navigation');
  assert.ok(Math.abs(bounds.x + bounds.width - 1048.8645833333335) < 1e-9, 'the widest number targets and complete surrounding frame stroke fit the right navigation edge');
  assert.equal(STUDIO_FRAME.bounds.x + STUDIO_FRAME.bounds.width / 2, 320, 'navigation bounds never move the shared Home center');
  assert.equal(bounds.y, STUDIO_FRAME.bounds.y);
  assert.equal(bounds.height, STUDIO_FRAME.bounds.height);
  assert.equal(MANDALA_FRAME.minScale, .1);
  assert.ok(Object.isFrozen(MANDALA_FRAME) && Object.isFrozen(bounds));
});

test('the shared activation envelope contains complete painted frames in every column layout', () => {
  const chart = { personality: [41], design: [19], activations: {
    personality: [{ planet: 'sun', gate: 41, line: 1, longitude: 302.1 }],
    design: [{ planet: 'sun', gate: 19, line: 2, longitude: 307.8 }],
  } };
  const transit = { ...chart, design: [], activations: { design: [], personality: chart.activations.personality } };
  const charts = [chart,
    overlayFixture(chart, transit, { kind: 'transit' }),
    overlayFixture(chart, chart, { kind: 'return', event: { id: 'frame-coverage', body: 'saturn', cycle: 1 } }),
  ];
  const layouts = new Set<string>();
  for (const current of charts) for (const showMandala of [false, true]) {
    const root = svgDocument().createElementNS(SVG_NS, 'svg');
    root.innerHTML = renderActivationColumns(current, new Set(), null, { showMandala });
    const columns = root.querySelectorAll('.activation-column');
    assert.equal(columns.length, 2);
    for (const column of columns) {
      const layout = column.getAttribute('data-cycle-layout') ?? 'ordinary';
      layouts.add(layout);
      const content = column.querySelector('.activation-block-content')!;
      const frame = content.querySelector('.activation-panel')!;
      const transform = /^translate\(([-\d.]+) ([-\d.]+)\) scale\(([-\d.]+)\) translate\(([-\d.]+) ([-\d.]+)\)$/.exec(content.getAttribute('transform')!);
      assert.ok(transform, 'read the actual block transform from the rendered SVG');
      const [tx, ty, scale, lx, ly] = transform.slice(1).map(Number);
      const halfStroke = Number(frame.getAttribute('stroke-width')) / 2;
      const x = Number(frame.getAttribute('x')), y = Number(frame.getAttribute('y'));
      const right = x + Number(frame.getAttribute('width')), bottom = y + Number(frame.getAttribute('height'));
      const painted = { left: tx + scale * (x + lx - halfStroke),
        right: tx + scale * (right + lx + halfStroke),
        top: ty + scale * (y + ly - halfStroke),
        bottom: ty + scale * (bottom + ly + halfStroke) };
      const label = `${layout} ${column.getAttribute('data-column-side')}`;
      assert.ok(painted.left >= ACTIVATION_BLOCK_BOUNDS.x, `${label}: left frame stroke fits`);
      assert.ok(painted.right <= ACTIVATION_BLOCK_BOUNDS.x + ACTIVATION_BLOCK_BOUNDS.width, `${label}: right frame stroke fits`);
      assert.ok(painted.top >= ACTIVATION_BLOCK_BOUNDS.y, `${label}: top frame stroke fits`);
      assert.ok(painted.bottom <= ACTIVATION_BLOCK_BOUNDS.y + ACTIVATION_BLOCK_BOUNDS.height, `${label}: bottom frame stroke fits`);
    }
  }
  assert.deepEqual(layouts, new Set(['ordinary', 'single', 'dual', 'dual-wide']));
});

function harness({ animate = false, immediate = false, layout = null } = {}) {
  const callbacks = {}, attributes = {}, classes = new Set(), calls: string[] = [];
  let view = { x: -150, y: -100, k: 2 }, mode;
  mode = attachMandalaMode({
    button: { setAttribute: (key, value) => { attributes[key] = value; }, addEventListener: (event, fn) => { callbacks[event] = fn; } },
    canvas: { classList: {
      toggle(name, enabled) { if (enabled) classes.add(name); else classes.delete(name); },
    } },
    gestures: {
      refreshFrame() { calls.push('refresh frame'); },
      reset() { assert.fail('a toggle must never fit the camera'); },
      setView() { assert.fail('a toggle must never restore another camera'); },
    },
    motion: animate ? { setExpanded(value) { calls.push(`motion ${value}`); if (immediate) mode.finishTransition(value); } } : null,
    layout, beforeChange: () => calls.push('close preview'), render: () => calls.push('render'),
  });
  return { mode, callbacks, attributes, classes, calls, getView: () => view, move: (next: { x: number; y: number; k: number; }) => { view = next; } };
}

test('both toggle directions preserve the current camera and update mode immediately', () => {
  const h = harness(), original = { ...h.getView() };
  assert.equal(h.mode.enabled, false);
  assert.equal(h.mode.visible, false);
  assert.equal(h.mode.frame.bounds, DRAWING_BOUNDS);
  assert.deepEqual(h.calls, []);
  h.callbacks.click();
  assert.equal(h.mode.enabled, true);
  assert.equal(h.mode.visible, true);
  assert.equal(h.mode.frame, MANDALA_FRAME);
  assert.equal(h.attributes['aria-checked'], 'true');
  assert.ok(h.classes.has('has-mandala'));
  assert.deepEqual(h.calls, ['close preview', 'render', 'refresh frame']);
  assert.deepEqual(h.getView(), original);
  const latest = { x: -50, y: 70, k: .4 };
  h.move(latest);
  h.callbacks.click();
  assert.equal(h.mode.enabled, false);
  assert.equal(h.mode.visible, false);
  assert.equal(h.attributes['aria-checked'], 'false');
  assert.ok(!h.classes.has('has-mandala'));
  assert.deepEqual(h.getView(), latest, 'keeps movement made in mandala, not the old chart view');
});

test('outgoing layer is decorative immediately, removed only once on the current endpoint', () => {
  const h = harness({ animate: true });
  h.callbacks.click(); h.callbacks.click();
  assert.equal(h.mode.enabled, false, 'interaction mode does not wait for motion');
  assert.equal(h.mode.visible, true);
  assert.deepEqual(h.calls.slice(-4), ['close preview', 'render', 'refresh frame', 'motion false']);
  h.mode.finishTransition(true);
  assert.equal(h.mode.visible, true, 'stale completion does nothing');
  h.mode.finishTransition(false);
  assert.equal(h.mode.visible, false);
  const count = h.calls.length;
  h.mode.finishTransition(false);
  assert.equal(h.calls.length, count, 'no redundant render');
});

test('rapid reversal never removes an enabled ring and reduced motion completes synchronously', () => {
  const h = harness({ animate: true });
  h.callbacks.click(); h.callbacks.click(); h.callbacks.click();
  h.mode.finishTransition(false);
  assert.equal(h.mode.enabled, true);
  assert.equal(h.mode.visible, true);
  const reduced = harness({ animate: true, immediate: true });
  reduced.callbacks.click(); reduced.callbacks.click();
  assert.equal(reduced.mode.visible, false);
  assert.deepEqual(reduced.calls.slice(-5), ['close preview', 'render', 'refresh frame', 'motion false', 'render']);
});

test('fixed Studio layout keeps its Home frame without measuring camera bounds on toggles', () => {
  const h = harness({ animate: true, layout: { frame: () => STUDIO_FRAME } }), original = { ...h.getView() };
  assert.equal(h.mode.homeFrame, STUDIO_FRAME);
  assert.equal(h.mode.frame, MANDALA_FRAME);
  h.callbacks.click(); h.callbacks.click(); h.callbacks.click();
  h.mode.finishTransition(false);
  assert.equal(h.mode.enabled, true);
  assert.equal(h.mode.visible, true);
  assert.equal(h.attributes['aria-checked'], 'true');
  assert.equal(h.mode.homeFrame, STUDIO_FRAME);
  assert.equal(h.mode.frame, MANDALA_FRAME);
  assert.deepEqual(h.getView(), original);
  assert.deepEqual(h.calls, [
    'close preview', 'render', 'motion true',
    'close preview', 'render', 'motion false',
    'close preview', 'render', 'motion true',
  ], 'Studio does not refresh or fit the camera on either direction or reversal');
  const count = h.calls.length;
  h.mode.finishTransition(true);
  assert.equal(h.calls.length, count, 'desktop completion keeps columns without an extra render');
});
