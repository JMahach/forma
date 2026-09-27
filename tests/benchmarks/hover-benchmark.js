import { createGraphController } from '/src/scene/updates.js';
import { renderBodygraph } from '/src/scene/bodygraph-svg.js';
import { crossAtLongitude } from '/src/domain/mandala-cross.js';
import { PLANETS } from '/src/domain/planets.js';
import { gatePositionAtLongitude, GATE_LONGITUDE_START, GATE_WIDTH, LINE_WIDTH } from '/src/domain/gate-wheel.js';

// The same synthetic 26-activation chart, camera and production renderer for A/B.
// No personal data, localStorage, network calculations or app entrypoint.
const activations = Object.fromEntries(['personality', 'design'].map((source, side) => [source,
  PLANETS.map(([planet], index) => ({ planet, ...gatePositionAtLongitude(17.234 + index * 26.13 + side * 88) })),
]));
const chart = { source: 'calculated', activations,
  personality: activations.personality.map(p => p.gate), design: activations.design.map(p => p.gate) };
const status = document.getElementById('status'), results = document.getElementById('results');
const frame = () => new Promise(requestAnimationFrame);
const emptyPopover = { close() {}, refresh() {} };

function createRunner(name) {
  const section = document.getElementById(name), viewport = section.querySelector('.viewport');
  let preview = null, rebuilds = 0, patches = 0;
  const graph = createGraphController({ getChart: () => chart, viewport,
    activationPopover: emptyPopover, getMandala: () => ({ enabled: true }),
    getHoverPreview: () => ({ currentSelection: preview, clear() { preview = null; } }),
    renderChart: (data, selection, options) => {
      rebuilds += 1;
      return renderBodygraph(data, selection, { ...options, idPrefix: name });
    },
  });
  return {
    section, viewport,
    reset() { graph.reset(); rebuilds = 0; patches = 0; },
    select(values) { graph.reset(); for (const value of values) graph.selectionState.choose({ ...value, additive: true }); graph.render(); },
    stats() { return { rebuilds, patches }; },
    update(longitude, source = 'personality') {
      const cross = crossAtLongitude(longitude, { source });
      preview = { type: 'mandala-cross', id: cross.longitude, cross };
      const previousRebuilds = rebuilds;
      // Both paths are actual production methods, not a benchmark-only renderer.
      if (name === 'baseline') graph.render(); else graph.preview();
      if (rebuilds === previousRebuilds) patches += 1;
    },
  };
}
const baseline = createRunner('baseline'), partial = createRunner('partial');
baseline.update(305.123);
function show(runner) { baseline.section.hidden = runner !== baseline; partial.section.hidden = runner !== partial; }
function summary(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return { median: sorted[Math.floor(sorted.length / 2)], p95: sorted[Math.floor(sorted.length * .95)], max: sorted.at(-1) };
}
let verified = false, busy = false;
async function guarded(task) {
  if (busy) return;
  busy = true; document.querySelectorAll('button').forEach(b => b.disabled = true);
  try { await task(); }
  catch (error) { status.textContent = 'Проверка остановлена'; results.textContent = error.stack; }
  finally { busy = false; document.querySelectorAll('button').forEach(b => b.disabled = false); }
}

document.getElementById('verify').addEventListener('click', () => guarded(async () => {
  baseline.reset(); partial.reset();
  const angles = [];
  // All gate boundaries plus both sides of every line/profile transition in a
  // representative gate, including the narrow 4/1 region. Test both sources.
  for (let i = 0; i < 64; i++) for (const offset of [-.00001, .00001, .5, 2.5, 4.5]) angles.push(GATE_LONGITUDE_START + i * GATE_WIDTH + offset);
  for (let line = 0; line <= 6; line++) for (const offset of [-.00001, .00001]) angles.push(GATE_LONGITUDE_START + line * LINE_WIDTH + offset);
  const pinned = crossAtLongitude(305.123);
  angles.push(305.123 - .000001, 305.123, 305.123 + .000001, -.000001, 0, .000001);
  let parityCases = 0;
  const normalized = markup => markup.replaceAll('baseline-', 'drawing-').replaceAll('partial-', 'drawing-');
  for (const selected of [[], [{ type: 'gate', id: 10 }, { type: 'gate', id: 20 }], [{ type: 'mandala-cross', id: pinned.longitude, cross: pinned }]]) {
  show(baseline); baseline.select(selected); show(partial); partial.select(selected);
  for (const source of ['personality', 'design']) for (let i = 0; i < angles.length; i++) {
    // Both are laid out at the same size before comparing their serialized SVG.
    show(baseline); baseline.update(angles[i], source);
    show(partial); partial.update(angles[i], source);
    if (normalized(baseline.viewport.innerHTML) !== normalized(partial.viewport.innerHTML)) {
      throw new Error(`A/B mismatch at ${angles[i]} (${source})`);
    }
    parityCases += 1;
    if (i % 8 === 0) { status.textContent = `Сравнение разметки: ${parityCases}`; await frame(); }
  }
  }
  verified = true;
  status.textContent = 'Разметка совпала';
  results.textContent = JSON.stringify({ parityCases, partialStats: partial.stats(), scope: 'Production methods; empty selection, two selected gates and pinned cross; both sources. No open summary/popover.' }, null, 2);
}));

document.getElementById('measure').addEventListener('click', () => guarded(async () => {
  if (!verified) throw new Error('Сначала выполните проверку совпадения.');
  if (document.hidden) throw new Error('Вкладка измерения должна быть видимой.');
  const output = { userAgent: navigator.userAgent, viewport: [innerWidth, innerHeight],
    metric: 'Main-thread update including forced SVG layout; rAF gaps are cadence, not a GPU paint/CPU/heap measure.',
    trajectory: 'One full circle, 480 samples; identical longitudes. 4 runs ABBA; 24 warmup frames.', runs: [] };
  const idle = []; let previous = await frame();
  for (let i = 0; i < 45; i++) { const now = await frame(); idle.push(now - previous); previous = now; }
  output.idleFrameMs = summary(idle);
  const expectedFrame = output.idleFrameMs.median;
  for (const runner of [baseline, partial, partial, baseline]) {
    show(runner); runner.reset();
    for (let i = 0; i < 24; i++) { await frame(); runner.update(302.123 + i * .2); runner.viewport.getBoundingClientRect(); }
    runner.reset();
    const work = [], gaps = [];
    previous = await frame();
    for (let i = 0; i < 480; i++) {
      const now = await frame(); gaps.push(now - previous); previous = now;
      if (document.hidden) throw new Error('Вкладка скрыта во время замера; результат отброшен.');
      const start = performance.now();
      runner.update(302.123 + i * 360 / 480);
      // Includes style/layout, not just the fast JS string renderer. This read
      // is identical in A/B; raster/paint occurs after returning to the browser.
      runner.viewport.getBoundingClientRect();
      work.push(performance.now() - start);
      if (i % 60 === 0) status.textContent = `${runner === baseline ? 'Полная перерисовка' : 'Частичное обновление'}: ${i}/480`;
    }
    output.runs.push({ mode: runner === baseline ? 'full' : 'partial', samples: work.length,
      workMs: summary(work), totalWorkMs: work.reduce((a, b) => a + b, 0),
      frameMs: summary(gaps), longFrameGaps: gaps.filter(v => v > expectedFrame * 1.5).length,
      ...runner.stats(), domElements: runner.viewport.querySelectorAll('*').length });
    results.textContent = JSON.stringify(output, null, 2);
  }
  output.complete = true;
  results.textContent = JSON.stringify(output, null, 2);
  status.textContent = 'Замер завершён';
}));
