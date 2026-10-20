import { createChartPreview } from '../../src/views/chart-preview-canvas.js';

// Capture the real preview's SVG at its Image boundary. Node has no image
// decoder; paint/cleanup behaviour is covered by chart-preview-canvas tests.
export function chartPreviewSource(chart) {
  const image = { src: '', onload: null, onerror: null,
    removeAttribute() { this.src = ''; } };
  const canvas = { style: {}, getContext: () => ({ drawImage() {} }) };
  const dispose = createChartPreview(canvas, chart, { pixelRatio: 1, createImage: () => image });
  try { return decodeURIComponent(image.src.slice(image.src.indexOf(',') + 1)); }
  finally { dispose(); }
}
