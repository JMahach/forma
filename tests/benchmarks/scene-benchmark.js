import { renderBodygraph } from '/src/scene/bodygraph-svg.js';
import { createSceneRenderer } from '/src/scene/renderer.js';
import { createMandalaPreviewPainter } from '/src/scene/mandala-preview-painter.js';
import { alignPersonalityHeading } from '/src/scene/activation-columns.js';
import { gatePositionAtLongitude, GATE_ORDER } from '/src/domain/gate-wheel.js';
import { PLANET_IDS } from '/src/domain/planets.js';
import { crossAtLongitude } from '/src/domain/mandala-cross.js';

const roots = { reference: document.getElementById('reference-root'), persistent: document.getElementById('persistent-root') };
const report = document.getElementById('report'), status = document.getElementById('status');
const buttons = ['verify', 'compare', 'stop'].map(id => document.getElementById(id));
const prefix = { reference: 'reference-scene', persistent: 'persistent-scene' };
const sources = ['personality', 'design'];
const integrationGates = [20, 10, 57, 34];
const integrationChannels = ['10-20', '10-34', '10-57', '20-34', '20-57', '34-57'];
let baselinePromise, referenceRenderer = renderBodygraph, referenceAlign = alignPersonalityHeading;
let renderer = createSceneRenderer(roots.persistent), running = false, stopped = false;
const frame = () => new Promise(resolve => requestAnimationFrame(resolve));
const baseOptions = { interactive: true, showBackdrop: true, showActivations: true, showMandala: true };
const gates = entries => [...new Set(entries.map(entry => entry.gate))].sort((a, b) => a - b);

function chartFrom(activations) {
  return { id: 'synthetic-scene-benchmark', name: 'Синтетическая карта', source: 'calculated',
    personality: gates(activations.personality), design: gates(activations.design), activations };
}
function syntheticChart(minute = 0) {
  const activations = Object.fromEntries(sources.map((source, side) => {
    const longitudes = Object.fromEntries(PLANET_IDS.map((planet, index) => [planet,
      (17.314 + side * 88.113 + index * 27.131 + minute * (.009 + index * .0013 + side * .0007)) % 360]));
    longitudes.earth = (longitudes.sun + 180) % 360;
    longitudes.south_node = (longitudes.north_node + 180) % 360;
    return [source, PLANET_IDS.map(planet => ({ planet, ...gatePositionAtLongitude(longitudes[planet]) }))];
  }));
  return chartFrom(activations);
}
function entryAt(planet, gate, line) {
  const longitude = (302 + GATE_ORDER.indexOf(gate) * 5.625 + (line - .5) * .9375) % 360;
  return { planet, ...gatePositionAtLongitude(longitude) };
}
function fixingChart(kind) {
  const chart = syntheticChart(30 + kind);
  for (const source of sources) {
    const replacements = kind === 0 ? { pluto: [43, 2], moon: [23, 1] }
      : kind === 1 ? { sun: [55, 2], moon: [55, 1], venus: [39, 1], pluto: [54, 4] }
        : { sun: [54, 4], moon: [43, 2], pluto: [23, 1], venus: [39, 2] };
    chart.activations[source] = chart.activations[source].map(entry => replacements[entry.planet]
      ? entryAt(entry.planet, ...replacements[entry.planet]) : entry);
  }
  return chartFrom(chart.activations);
}
function integrationChart(combination) {
  const chart = syntheticChart(combination);
  // Exhaust the four independent source states of all four integration arms.
  // Gate arrays are the renderer's canonical definition input.
  for (const [side, source] of sources.entries()) {
    chart[source] = chart[source].filter(gate => !integrationGates.includes(gate));
    integrationGates.forEach((gate, index) => {
      if ((combination >> (index * 2)) & (1 << side)) chart[source].push(gate);
    });
    chart[source].sort((a, b) => a - b);
  }
  return chart;
}
const gate = id => ({ type: 'gate', id });
const targetSet = combination => [gate(integrationGates[combination % 4]), { type: 'center', id: ['throat', 'g', 'spleen', 'sacral'][combination % 4] },
  { type: 'channel', id: integrationChannels[combination % 6] }, { type: 'integration', id: 'integration' }];
const modes = Array.from({ length: 4 }, (_, value) => ({ ...baseOptions,
  showMandala: Boolean(value & 1), showActivations: Boolean(value & 2) }));

function* phaseCases(label, chart, options, targets, identity = true) {
  yield { label: `${label}: idle`, chart, options, identity };
  for (const selection of targets) {
    const committed = { ...options, selections: [selection] };
    yield { label: `${label}: pin ${selection.type} ${selection.id ?? ''}`, chart, selection, options: committed, identity };
    yield { label: `${label}: hover with pinned ${selection.type}`, chart, selection,
      options: { ...committed, previewSelection: gate(selection.id === 20 ? 57 : 20) }, identity };
    yield { label: `${label}: release hover with pinned ${selection.type}`, chart, selection, options: committed, identity };
  }
}
function* parityCases() {
  for (let index = 0; index < modes.length; index++) {
    const options = modes[index];
    yield { label: `mode ${index}: enter`, chart: syntheticChart(index), options, identity: false };
    yield* phaseCases(`mode ${index}`, syntheticChart(index + 1), options, targetSet(index));
    yield { label: `mode ${index}: next minute`, chart: syntheticChart(index + 2), options, identity: true };
  }
  for (let combination = 0; combination < 256; combination++) {
    const options = modes[combination % modes.length];
    yield { label: `integration ${combination}: mode entry`, chart: integrationChart(combination), options, identity: false };
    yield* phaseCases(`integration ${combination}`, integrationChart(combination), options, targetSet(combination));
  }
  for (let kind = 0; kind < 3; kind++) {
    yield { label: `two-source fixing ${kind}: enter`, chart: fixingChart(kind), options: baseOptions, identity: false };
    yield* phaseCases(`two-source fixing ${kind}`, fixingChart(kind), baseOptions, [gate(43), gate(55)]);
  }
  for (const invalid of ['duplicate', 'nonfinite', 'missing', 'unknown', 'manual', 'transit', 'restored']) {
    const chart = syntheticChart(500);
    if (invalid === 'duplicate') for (const source of sources) chart.activations[source].push({ ...chart.activations[source][0] });
    if (invalid === 'nonfinite') { chart.activations.personality[0].longitude = NaN; chart.activations.design[1].longitude = Infinity; }
    if (invalid === 'missing') for (const source of sources) delete chart.activations[source][2].longitude;
    if (invalid === 'unknown') for (const source of sources) chart.activations[source].push({ planet: 'unknown', gate: 41, line: 1, longitude: 302 });
    if (invalid === 'manual') chart.source = 'manual';
    if (invalid === 'transit') { chart.source = 'transit'; chart.design = []; chart.activations.design = []; }
    yield { label: `ray validation: ${invalid}`, chart, options: baseOptions, identity: false };
  }
  const cross = crossAtLongitude(37.456), second = crossAtLongitude(189.789, { source: 'design' });
  const crossSelection = { type: 'mandala-cross', id: 'synthetic-cross', cross };
  for (const [label, options] of [
    ['pinned cross', { pinnedCrosses: [cross], selections: [crossSelection] }],
    ['two pinned crosses', { pinnedCrosses: [cross, second] }],
    ['reordered pinned crosses', { pinnedCrosses: [second, cross] }],
    ['raw source overlap stays distinct', { pinnedCrosses: [{ ...cross, source: undefined }], previewSelection: { type: 'mandala-cross', cross } }],
    ['same source overlap hides preview', { pinnedCrosses: [cross], previewSelection: { type: 'mandala-cross', cross } }],
    ['pinned and preview crosses', { pinnedCrosses: [cross], selections: [crossSelection], previewSelection: { type: 'mandala-cross', cross: second } }],
    ['cross preview release', { pinnedCrosses: [cross], selections: [crossSelection] }],
    ['cross clear', {}],
    ['line-filter', { activationFilter: { line: 2, source: 'design' }, selections: [gate(43)] }],
    ['group-filter', { activationFilter: { groups: [{ line: 1, source: 'personality', gates: [41, 43] }], unfilteredGates: [55] } }],
    ['filter clear', {}],
  ]) yield { label, chart: fixingChart(0), selection: options.selections?.[0], options: { ...baseOptions, ...options }, identity: true };
  yield { label: 'external fast preview A → B → A', chart: syntheticChart(701), options: { ...baseOptions, previewSelection: { type: 'mandala-cross', cross } },
    fast: { from: cross, to: crossAtLongitude(cross.longitude + .002) }, identity: true };
  for (const options of [{ showLabels: true }, { showGates: false }, { interactive: false }, { dimInactive: true }, { showMandala: false, showMandalaLayer: true }, {}]) {
    yield { label: `structural options ${JSON.stringify(options)}`, chart: syntheticChart(600), options: { ...baseOptions, ...options }, identity: false };
  }
}

const numericAttributes = new Set(['x', 'y', 'x1', 'x2', 'y1', 'y2', 'cx', 'cy', 'r', 'rx', 'ry', 'width', 'height', 'opacity', 'fill-opacity', 'stroke-opacity',
  'stroke-width', 'font-size', 'letter-spacing', 'dx', 'dy', 'data-longitude', 'data-longitude-start', 'data-longitude-center']);
const numericToken = /^[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?$/i;
function canonicalAttribute(name, value, pane, node) {
  value = value.replaceAll(prefix[pane], 'scene');
  // A pair of side-by-side panes cancels different screen translations in
  // getCTM().inverse(): tolerate only that measured heading's sub-nanometre
  // arithmetic noise. Exact longitudes and every other SVG number stay strict.
  if (name === 'x' && node.classList.contains('activation-heading') && numericToken.test(value)) return { alignment: Number(value) };
  if (name === 'd' && node.classList.contains('activation-header-rule')) return (value.match(/[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?|[a-z]+|[^\s,]/ig) || [])
    .map(token => numericToken.test(token) ? { alignment: Number(token) } : token);

  if (numericAttributes.has(name) && numericToken.test(value)) return String(Number(value));
  if (['d', 'points', 'transform'].includes(name)) return (value.match(/[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?|[a-z]+|[^\s,]/ig) || [])
    .map(token => numericToken.test(token) ? String(Number(token)) : token).join(' ');
  if (name === 'class') return value.trim().split(/\s+/).sort().join(' ');
  return value;
}
function canonical(node, pane) {
  if (node.nodeType === Node.TEXT_NODE) return node.nodeValue.trim() ? { text: node.nodeValue } : null;
  if (node.nodeType !== Node.ELEMENT_NODE) return null;
  return { tag: node.localName, attributes: [...node.attributes].map(({ name, value }) => [name, canonicalAttribute(name, value, pane, node)])
    .sort(([a], [b]) => a.localeCompare(b)), children: [...node.childNodes].map(child => canonical(child, pane)).filter(Boolean) };
}
function scene(root, pane) { return [...root.childNodes].map(node => canonical(node, pane)).filter(Boolean); }
function difference(a, b, path = 'scene') {
  if (Object.is(a, b)) return null;
  if (a && b && Object.hasOwn(a, 'alignment') && Object.hasOwn(b, 'alignment') && Math.abs(a.alignment - b.alignment) <= 1e-9) return null;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return { path, expected: a, actual: b };
  if (Array.isArray(a) !== Array.isArray(b)) return { path, expected: a, actual: b };
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])];
  for (const key of keys) {
    if (!(key in a) || !(key in b)) return { path: `${path}.${key}`, expected: a[key], actual: b[key] };
    const result = difference(a[key], b[key], `${path}.${key}`);
    if (result) return result;
  }
  return null;
}
function compactDifference(value) {
  if (!value) return value;
  const brief = item => item && typeof item === 'object'
    ? JSON.stringify(item).slice(0, 1200) : typeof item === 'string' ? item.slice(0, 1200) : item;
  return { ...value, expected: brief(value.expected), actual: brief(value.actual) };
}
function interactiveNodes(root) {
  const result = new Map();
  for (const node of root.querySelectorAll('.bodygraph-gates > [data-type], .bodygraph-centers > [data-type], .bodygraph-channels > [data-type]')) {
    result.set(`core:${node.dataset.type}:${node.dataset.id}`, node);
  }
  for (const column of root.querySelectorAll('.activation-column')) {
    result.set(`column:${column.dataset.source}`, column);
    for (const row of column.querySelectorAll('.activation-row')) for (const node of row.querySelectorAll('[data-type]')) {
      result.set(`column:${column.dataset.source}:${node.dataset.type}:${node.dataset.activation || node.dataset.id}`, node);
    }
  }
  for (const node of root.querySelectorAll('.mandala-gate[data-id]')) result.set(`mandala:${node.dataset.id}`, node);
  return result;
}
function renderReference(chart, selection, options) {
  roots.reference.innerHTML = referenceRenderer(chart, selection, { ...options, idPrefix: prefix.reference });
  referenceAlign(roots.reference);
}
function renderPersistent(chart, selection, options) {
  renderer.update(chart, selection, { ...options, idPrefix: prefix.persistent });
}
async function chooseReference(benchmark = false) {
  let config = {};
  try { const response = await fetch('/benchmark-config.json'); if (response.ok) config = await response.json(); } catch {}
  const control = document.getElementById('baseline-control');
  if (control) control.hidden = !config.baselineAvailable;
  if (config.baselineAvailable && (benchmark || document.getElementById('use-baseline')?.checked)) {
    baselinePromise ||= Promise.all([import('/baseline/src/bodygraph/bodygraph.js'), import('/baseline/src/activations/activations.js')]);
    const [body, columns] = await baselinePromise;
    referenceRenderer = body.renderBodygraph; referenceAlign = columns.alignPersonalityHeading;
    return 'published renderer before refactor (read-only baseline)';
  }
  referenceRenderer = renderBodygraph; referenceAlign = alignPersonalityHeading;
  return 'current initial-string renderer';
}

function setReport(value) { report.textContent = JSON.stringify(value, null, 2); }
function setRunning(value) { running = value; buttons[0].disabled = buttons[1].disabled = value; buttons[2].disabled = !value; }
function restart() { renderer.clear(); roots.reference.replaceChildren(); renderer = createSceneRenderer(roots.persistent); }

function verifyLongitudeOnly(result) {
  const original = syntheticChart(0);
  const centered = chartFrom(Object.fromEntries(sources.map(source => [source, original.activations[source].map(entry => entryAt(entry.planet, entry.gate, entry.line))])));
  renderReference(centered, null, baseOptions); renderPersistent(centered, null, baseOptions);
  const stable = [...roots.persistent.querySelectorAll('.mandala-gate, .mandala-planet-marker, .mandala-planet-ray, .mandala-planet-endpoint')];
  const targets = interactiveNodes(roots.persistent);
  const focus = roots.persistent.querySelector('.bodygraph-gates > [data-type="gate"]');
  focus.focus();
  const observer = new MutationObserver(() => {});
  observer.observe(roots.persistent, { childList: true, subtree: true });
  const summary = { updates: 40, rays: roots.persistent.querySelectorAll('.mandala-planet-ray').length,
    sectors: roots.persistent.querySelectorAll('.mandala-gate').length, childListRecords: 0, lostNodes: 0, focusLost: 0, parityFailures: 0, staleLongitudes: 0 };
  for (let step = 1; step <= 40; step++) {
    const chart = chartFrom(Object.fromEntries(sources.map(source => [source, centered.activations[source].map(entry =>
      ({ planet: entry.planet, ...gatePositionAtLongitude((entry.longitude + step * .002) % 360) }))])));
    renderReference(chart, null, baseOptions); renderPersistent(chart, null, baseOptions);
    summary.childListRecords += observer.takeRecords().length;
    summary.lostNodes += stable.filter(node => !roots.persistent.contains(node)).length;
    if (document.activeElement !== focus) summary.focusLost++;
    const after = interactiveNodes(roots.persistent);
    summary.lostNodes += [...targets].filter(([key, node]) => after.get(key) !== node).length;
    for (const node of roots.persistent.querySelectorAll('.mandala-planet-marker')) {
      const expected = chart.activations[node.dataset.source].find(entry => entry.planet === node.dataset.mandalaPlanet)?.longitude;
      if (Number(node.dataset.longitude) !== expected) summary.staleLongitudes++;
    }
    const mismatch = difference(scene(roots.reference, 'reference'), scene(roots.persistent, 'persistent'));
    result.checked++;
    if (mismatch) {
      summary.parityFailures++; result.failures++;
      if (result.examples.length < 12) result.examples.push({ case: `longitude only ${step}`, mismatch: compactDifference(mismatch) });
    }
  }
  observer.disconnect();
  summary.passed = summary.rays === 26 && summary.sectors === 64 && !summary.childListRecords && !summary.lostNodes && !summary.focusLost && !summary.parityFailures && !summary.staleLongitudes;
  if (!summary.passed) result.identityFailures++;
  result.longitudeOnly = summary;
}

export async function verifyScene() {
  if (running) return;
  setRunning(true); stopped = false; restart();
  const started = performance.now();
  const result = { kind: 'parity', status: 'running', checked: 0, failures: 0, identityFailures: 0,
    alignmentToleranceSvgUnits: 1e-9,
    coverage: { modes: 8, integrationSourceCombinations: 256, selectionTypes: ['gate', 'center', 'channel', 'integration'], phases: ['pin', 'hover', 'release'], fullScene: true }, examples: [] };
  try {
    result.reference = await chooseReference();
    verifyLongitudeOnly(result);
    setReport(result); await frame();
    for (const item of parityCases()) {
      if (stopped) break;
      const before = item.identity ? interactiveNodes(roots.persistent) : new Map();
      let mismatch, identityFailures = [];
      try {
        if (item.fast) {
          renderPersistent(item.chart, null, { ...baseOptions, previewSelection: { type: 'mandala-cross', cross: item.fast.from } });
          const fast = createMandalaPreviewPainter(roots.persistent);
          fast.capture(item.fast.from);
          if (!fast.update(item.fast.to)) throw new Error('Fast A → B precondition failed');
        }
        renderReference(item.chart, item.selection, item.options);
        renderPersistent(item.chart, item.selection, item.options);
        mismatch = difference(scene(roots.reference, 'reference'), scene(roots.persistent, 'persistent'));
        const after = interactiveNodes(roots.persistent);
        identityFailures = [...before].filter(([key, node]) => after.get(key) !== node).map(([key]) => key);
      } catch (error) { mismatch = { exception: error.message, stack: error.stack }; }
      result.checked++;
      if (mismatch) result.failures++;
      if (identityFailures.length) result.identityFailures++;
      if ((mismatch || identityFailures.length) && result.examples.length < 12) result.examples.push({ case: item.label, mismatch: compactDifference(mismatch), identityFailures });
      if (result.checked % 12 === 0) {
        result.elapsedMs = Math.round(performance.now() - started);
        status.textContent = `Проверено ${result.checked}; различий ${result.failures}; замен целей ${result.identityFailures}`;
        setReport(result); await frame();
      }
    }
    result.status = stopped ? 'stopped' : result.failures || result.identityFailures ? 'failed' : 'passed';
  } catch (error) { result.status = 'error'; result.error = error.stack; }
  finally {
    result.elapsedMs = Math.round(performance.now() - started);
    setReport(result); report.dataset.status = result.status;
    status.textContent = `Проверка: ${result.status}. ${result.checked} состояний.`;
    setRunning(false);
  }
  return result;
}

const quantile = (values, fraction) => { const sorted = [...values].sort((a, b) => a - b); return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))]; };
const elementCount = node => node.nodeType === Node.ELEMENT_NODE ? 1 + node.querySelectorAll('*').length : 0;
function forceLayout(root) {
  const box = root.getBBox(), screen = root.ownerSVGElement.getBoundingClientRect();
  return box.width + box.height + screen.width + screen.height;
}
function summarize(times) { return { samples: times.length, medianMs: quantile(times, .5), p95Ms: quantile(times, .95), totalMs: times.reduce((a, b) => a + b, 0) }; }
export async function compareScene() {
  if (running) return;
  setRunning(true); stopped = false;
  const result = { kind: 'benchmark', status: 'running', samplesPerRun: 240, runs: 2,
    sequence: 'every minute, no requestAnimationFrame coalescing', forcedLayout: 'getBBox + SVG getBoundingClientRect after every update',
    scenarios: [], note: 'Browser-only local measurements. DOM work and layout are measured; SVG rasterization/GPU time and phone performance are not inferred.' };
  try {
    result.reference = await chooseReference(true);
    for (const [name, options] of [['bodygraph', { ...baseOptions, showMandala: false }], ['mandala-with-all-rays', baseOptions]]) {
      const methods = { reference: { times: [], runs: [], addedElements: 0, removedElements: 0, rootRemovals: 0 }, persistent: { times: [], runs: [], addedElements: 0, removedElements: 0, rootRemovals: 0 } };
      const samples = Array.from({ length: 240 }, (_, index) => syntheticChart(index + 1000));
      for (let run = 0; run < 2 && !stopped; run++) {
        restart();
        renderReference(samples[0], null, options); renderPersistent(samples[0], null, options);
        for (let warmup = 0; warmup < 12; warmup++) {
          const chart = syntheticChart(900 + warmup); renderReference(chart, null, options); renderPersistent(chart, null, options);
          forceLayout(roots.reference); forceLayout(roots.persistent);
        }
        for (const method of run ? ['persistent', 'reference'] : ['reference', 'persistent']) {
          if (stopped) break;
          const root = roots[method], stats = methods[method], times = [], observer = new MutationObserver(() => {});
          observer.observe(root, { childList: true, subtree: true });
          const preserved = method === 'persistent' ? interactiveNodes(root) : null;
          let layoutChecksum = 0, raysMoved = 0, previousRay = root.querySelector('.mandala-planet-ray')?.getAttribute('d');
          for (let index = 0; index < samples.length; index++) {
            if (stopped) break;
            const started = performance.now();
            if (method === 'reference') renderReference(samples[index], null, options); else renderPersistent(samples[index], null, options);
            layoutChecksum += forceLayout(root);
            times.push(performance.now() - started);
            for (const record of observer.takeRecords()) {
              for (const node of record.addedNodes) stats.addedElements += elementCount(node);
              for (const node of record.removedNodes) stats.removedElements += elementCount(node);
              if (record.target === root) stats.rootRemovals += record.removedNodes.length;
            }
            const ray = root.querySelector('.mandala-planet-ray')?.getAttribute('d');
            if (ray && ray !== previousRay) raysMoved++;
            previousRay = ray;
            if ((index + 1) % 24 === 0) {
              status.textContent = `${name}: ${method}, прогон ${run + 1}/2, минута ${index + 1}/240`;
              await frame();
            }
          }
          observer.disconnect();
          const after = preserved && interactiveNodes(root);
          stats.times.push(...times); stats.runs.push({ run: run + 1, ...summarize(times), nodeCount: root.querySelectorAll('*').length,
            raysMoved, layoutChecksum, retainedInteractiveTargets: preserved ? [...preserved].filter(([key, node]) => after.get(key) === node).length : null,
            interactiveTargets: after?.size ?? interactiveNodes(root).size });
        }
      }
      const summary = Object.fromEntries(Object.entries(methods).map(([method, stats]) => [method, { ...summarize(stats.times),
        addedElements: stats.addedElements, removedElements: stats.removedElements, rootRemovals: stats.rootRemovals, runs: stats.runs }]));
      result.scenarios.push({ name, ...summary, medianRatio: summary.reference.medianMs / summary.persistent.medianMs });
      setReport(result);
      if (stopped) break;
    }
    result.status = stopped ? 'stopped' : 'complete';
  } catch (error) { result.status = 'error'; result.error = error.stack; }
  finally { setReport(result); report.dataset.status = result.status; status.textContent = `Сравнение: ${result.status}`; setRunning(false); }
  return result;
}
buttons[0].addEventListener('click', verifyScene);
buttons[1].addEventListener('click', compareScene);
buttons[2].addEventListener('click', () => { stopped = true; });
renderReference(syntheticChart(), null, baseOptions);
renderPersistent(syntheticChart(), null, baseOptions);

void chooseReference().catch(error => { status.textContent = `Baseline unavailable: ${error.message}`; });
