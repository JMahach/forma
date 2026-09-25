// Synthetic visual fixture; never loads or writes the user's saved charts.
// Run: node tests/previews/activation-preview.mjs; open http://localhost:4174.
import { PLANETS } from '../../src/activations/activations.js';
import { GATE_ORDER, GATE_LONGITUDE_START, GATE_WIDTH, LINE_WIDTH, normalizeLongitude } from '../../src/domain/gate-wheel.js';
import { startPreviewIfMain } from './preview-server.mjs';

const fixtureGates = [41, 20, 1, 29, 20, 41, 1, 29, 20, 41, 1, 29, 20];
const entry = (planet, index) => {
  const gate = fixtureGates[index], line = index % 6 + 1;
  return { planet, gate, line, longitude: normalizeLongitude(GATE_LONGITUDE_START + GATE_ORDER.indexOf(gate) * GATE_WIDTH + (line - 1) * LINE_WIDTH + .2345) };
};
export const preview = {
  title: 'Проверка активаций — тестовые данные', viewBox: '-360 0 1300 810',
  chart: { id: 'synthetic', personality: [1, 20, 29, 41], design: [1, 20, 29, 41], activations: { design: PLANETS.map(([planet], index) => entry(planet, index)), personality: PLANETS.map(([planet], index) => entry(planet, index)) } },
  controls: [
    { id: 'hover1', label: 'Навести на 1', action: 'hover', selector: '[data-activation="design-moon"]' },
    { id: 'hover20', label: 'Навести на 20', action: 'hover', selector: '[data-activation="design-earth"]' },
    { id: 'hover29', label: 'Навести на 29', action: 'hover', selector: '[data-activation="design-north_node"]' },
    { id: 'hoverNumber', label: 'Навести на 41', action: 'hover', selector: '[data-activation="design-sun"]' },
    { id: 'hoverCenter', label: 'Навести на Горловой', action: 'hover', selector: '[data-type="center"][data-id="throat"]' },
    { id: 'pinThroat', label: 'Выбрать / снять Горловой', action: 'select', selection: { type: 'center', id: 'throat' } },
    { id: 'leave', label: 'Увести мышь', action: 'leave' },
  ],
};
startPreviewIfMain(import.meta.url, preview);
