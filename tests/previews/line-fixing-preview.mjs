// Deliberately synthetic chart, isolated from the user's saved cards.
// Run: node tests/previews/line-fixing-preview.mjs; open http://localhost:4174.
import { PLANETS } from '../../src/domain/planets.js';
import { GATE_ORDER, GATE_LONGITUDE_START, GATE_WIDTH, LINE_WIDTH, normalizeLongitude } from '../../src/domain/gate-wheel.js';
import { startPreviewIfMain } from './preview-server.mjs';

const overrides = {
  design: { sun: [55, 2], earth: [16, 3], moon: [23, 4], venus: [39, 1], mars: [48, 1], pluto: [43, 2] },
  personality: { sun: [55, 2], earth: [16, 4], moon: [23, 4], venus: [39, 1], mars: [48, 1], pluto: [43, 2] },
};
const entries = source => PLANETS.map(([planet], index) => {
  const [gate, line] = overrides[source][planet] || [41, index % 6 + 1];
  return { planet, gate, line, longitude: normalizeLongitude(GATE_LONGITUDE_START + GATE_ORDER.indexOf(gate) * GATE_WIDTH + (line - 1) * LINE_WIDTH + .123) };
});
const activations = { design: entries('design'), personality: entries('personality') };
export const preview = {
  title: 'Фиксации — тестовые данные', viewBox: '-52 28 744 740',
  chart: { id: 'synthetic', source: 'birth', activations, design: activations.design.map(entry => entry.gate), personality: activations.personality.map(entry => entry.gate) },
  controls: [
    { id: 'home', label: 'Домой', action: 'home' },
    { id: 'leave', label: 'Увести мышь', action: 'leave' },
  ],
};
startPreviewIfMain(import.meta.url, preview);
