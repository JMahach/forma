import { renderBodygraph } from '../scene/bodygraph-svg.ts';
import { createRenderState } from '../scene/render-state.ts';
import { createCameraView } from '../scene/camera-view.ts';
import { attachGestures } from '../scene/gestures.ts';
import { INTEGRATION_CASES, INTEGRATION_GATES } from './integration-cases.ts';
import { paintIntegrationLayers } from './integration-paint.ts';
import { PALETTE } from '../ui/chart-palette.ts';

const svg = document.querySelector<SVGSVGElement>('#graph')!;
const surface = document.querySelector<HTMLElement>('#surface')!;
const range = document.querySelector<HTMLInputElement>('#caseRange')!;
const points = document.querySelector<HTMLElement>('#casePoints')!;
const number = document.querySelector<HTMLOutputElement>('#caseNumber')!;
const gates = document.querySelector<HTMLElement>('#caseGates')!;
const options = { interactive: false, showActivations: false, idPrefix: 'integration-lab' };
const labels = ['—', 'К', 'Ч', 'ЧК'];
const colors = ['transparent', PALETTE.design, PALETTE.ink, `linear-gradient(90deg,${PALETTE.ink} 50%,${PALETTE.design} 50%)`];

function show(index: number) {
  const chart = INTEGRATION_CASES[index];
  range.value = String(index + 1);
  number.value = `${String(index + 1).padStart(2, '0')} / 30`;
  svg.innerHTML = renderBodygraph(chart, null, options);
  const integration = svg.querySelector('[data-junction="integration"]')!;
  // Keep the native background contour; replace only its experimental color layer.
  const nativeArms = [...integration.querySelectorAll('.bg-integration-arm')];
  const first = nativeArms[0];
  let current: Element | null = first;
  while (current) { const next: Element | null = current.nextElementSibling; current.remove(); current = next; }
  integration.insertAdjacentHTML('beforeend', paintIntegrationLayers(createRenderState(chart, null, options)));
  gates.innerHTML = INTEGRATION_GATES.map((gate, i) => {
    const state = Number(chart.pattern[i]);
    return `<span><b>${gate}</b><i style="background:${colors[state]}"></i>${labels[state]}</span>`;
  }).join('');
  [...points.children].forEach((button, i) => button.setAttribute('aria-pressed', String(i === index)));
}
INTEGRATION_CASES.forEach((example, index) => {
  const button = document.createElement('button');
  button.type = 'button';
  button.setAttribute('aria-label', `Вариант ${example.id}`);
  button.textContent = String(example.id);
  button.addEventListener('click', () => show(index));
  points.append(button);
});
range.addEventListener('input', () => show(Number(range.value) - 1));
show(0);
const view = createCameraView({ svg, surface });
const gestures = attachGestures(svg, { cameraView: view });
gestures.reset();
document.querySelector('#zoomIn')!.addEventListener('click', () => gestures.zoom(1.35));
document.querySelector('#zoomOut')!.addEventListener('click', () => gestures.zoom(1 / 1.35));
document.querySelector('#home')!.addEventListener('click', () => gestures.reset());
new ResizeObserver(() => gestures.resize()).observe(surface);
