import { createGraphController } from '/src/scene/updates.js';
import { DEMO_CHART } from '/fixtures/demo-chart.js';

const viewport = document.getElementById('viewport');
const report = document.getElementById('report'), status = document.getElementById('status');
const verify = document.getElementById('verify'), stop = document.getElementById('stop');
let mandala = { enabled: false, visible: false }, stopped = false, running = false;
const graph = createGraphController({
  viewport, getChart: () => DEMO_CHART, getActiveElement: () => document.activeElement,
  getMandala: () => mandala, getShowActivations: () => false,
  activationPopover: { close() {}, refresh() {}, show() {} },
});
const gateNode = id => viewport.querySelector(`.bodygraph-gates > [data-type="gate"][data-id="${id}"]`);
const modeCases = [
  ['open', { enabled: true, visible: true }],
  ['closing-visible-layer', { enabled: false, visible: true }],
  ['closed', { enabled: false, visible: false }],
  ['reopen', { enabled: true, visible: true }],
  ['close', { enabled: false, visible: false }],
];
graph.render();

export async function verifyControllerFocus() {
  if (running) return;
  running = true; stopped = false; verify.disabled = true; stop.disabled = false;
  const started = performance.now();
  const result = { kind: 'controller-focus', status: 'running', controller: 'createGraphController', gates: 64,
    checked: 0, expectedChecks: 384, preconditionFailures: 0, focusFailures: 0, identityFailures: 0, reparentChecks: 0,
    examples: [] };
  try {
    graph.clear();
    for (let id = 1; id <= 64 && !stopped; id++) {
      mandala = { enabled: false, visible: false }; graph.render();
      const target = gateNode(id);
      target.focus({ preventScroll: true });
      if (document.activeElement !== target) {
        result.preconditionFailures++;
        if (result.examples.length < 12) result.examples.push({ id, mode: 'initial-focus', activeTag: document.activeElement?.tagName });
      }
      for (const [mode, next] of modeCases) {
        const formerParent = target.parentElement?.parentElement;
        mandala = next; graph.render();
        const sameNode = gateNode(id) === target, sameFocus = document.activeElement === target;
        if (formerParent !== target.parentElement?.parentElement) result.reparentChecks++;
        if (!sameNode) result.identityFailures++;
        if (!sameFocus) result.focusFailures++;
        if ((!sameNode || !sameFocus) && result.examples.length < 12) result.examples.push({ id, mode, sameNode, sameFocus,
          activeTag: document.activeElement?.tagName, activeType: document.activeElement?.dataset.type, activeId: document.activeElement?.dataset.id });
        result.checked++;
      }
      // Choosing an already-focused target must also leave real browser focus
      // on that target, independently of the mode reparenting checks above.
      graph.choose({ type: 'gate', id });
      const sameNode = gateNode(id) === target, sameFocus = document.activeElement === target;
      if (!sameNode) result.identityFailures++;
      if (!sameFocus) result.focusFailures++;
      if ((!sameNode || !sameFocus) && result.examples.length < 12) result.examples.push({ id, mode: 'choose', sameNode, sameFocus });
      result.checked++;
      if (id % 8 === 0) {
        status.textContent = `${id}/64 ворот; потеря фокуса ${result.focusFailures}`;
        report.textContent = JSON.stringify(result, null, 2);
        await new Promise(resolve => requestAnimationFrame(resolve));
      }
    }
    result.status = stopped ? 'stopped' : result.preconditionFailures || result.focusFailures || result.identityFailures || result.reparentChecks !== 256 ? 'failed' : 'passed';
  } catch (error) { result.status = 'error'; result.error = error.stack; }
  finally {
    result.elapsedMs = Math.round(performance.now() - started);
    report.textContent = JSON.stringify(result, null, 2); report.dataset.status = result.status;
    status.textContent = `${result.status}: ${result.checked} проверок`;
    running = false; verify.disabled = false; stop.disabled = true;
  }
  return result;
}
verify.addEventListener('click', verifyControllerFocus);
stop.addEventListener('click', () => { stopped = true; });
