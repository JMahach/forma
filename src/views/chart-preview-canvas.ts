import type { ChartView } from '../domain/chart-composition.ts';
import type { ChartData } from '../../shared/chart-types.ts';
interface ChartPreviewOptions { width?: number; height?: number; onReady?: (success: boolean) => void; pixelRatio?: number; createImage?: () => HTMLImageElement }

import { renderBodygraph } from '../scene/bodygraph-svg.ts';
import { CHART_SURFACE_RIM_WIDTH } from '../scene/backdrop.ts';
import { LOTUS_BACKDROP_BOUNDS } from '../scene/geometry/lotus-backdrop.ts';
import { CENTERS } from '../scene/geometry/chart-geometry.ts';

// The complete silhouette, its rim and the Head above it share this viewBox.
const inset = CHART_SURFACE_RIM_WIDTH / 2 + 1;
const { x, y, width: figureWidth, height: figureHeight } = LOTUS_BACKDROP_BOUNDS;
const top = Math.min(y, ...CENTERS.flatMap(center => center.points.split(' ').map(point => Number(point.split(',')[1]))));
const viewBox = [x - inset, top - inset, figureWidth + inset * 2, y + figureHeight - top + inset * 2].join(' ');

// A saved single-chart thumbnail shows only these gates and their two colours.
// Record metadata and activation-column details do not change its pixels.
export function sameSavedChartPreview(a: ChartData, b: ChartData) {
  return (['personality', 'design'] as const).every(side => a[side] === b[side]
    || (a[side].length === b[side].length && a[side].every((gate, index) => gate === b[side][index])));
}

// Only visible list rows own pixels. The caller disposes a row as soon as it
// leaves its visibility margin; neither the SVG nor the decoded Image is kept.
export function createChartPreview(canvas: HTMLCanvasElement, chart: ChartView, {
  width = 92, height = 120, onReady = () => {},
  pixelRatio = canvas.ownerDocument?.defaultView?.devicePixelRatio ?? globalThis.devicePixelRatio ?? 1,
  createImage = () => new (canvas.ownerDocument?.defaultView?.Image ?? globalThis.Image)(),
}: ChartPreviewOptions = {}) {
  const ratio = Number.isFinite(pixelRatio) && pixelRatio > 0 ? pixelRatio : 1;
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  canvas.width = Math.max(1, Math.round(width * ratio));
  canvas.height = Math.max(1, Math.round(height * ratio));
  const context = canvas.getContext('2d');
  let disposed = false, image: HTMLImageElement | null = null, settled = false;
  function finish(success: boolean) {
    if (settled) return;
    settled = true; onReady(success);
  }
  function releaseImage() {
    if (!image) return;
    image.onload = image.onerror = null;
    // Resetting src creates a broken-image fallback retained by Chrome's
    // viewport listeners. Drop this detached image and its data URL together.
    image = null;
  }
  function dispose() {
    if (disposed) return;
    disposed = true;
    releaseImage();
    canvas.width = canvas.height = 0;
    finish(false);
  }
  if (!context) { dispose(); return dispose; }
  try {
    image = createImage();
    image.onload = () => {
      if (disposed || !image) return;
      try { context.drawImage(image, 0, 0, canvas.width, canvas.height); }
      catch { dispose(); return; }
      releaseImage();
      finish(true);
    };
    image.onerror = dispose;
    const drawing = renderBodygraph(chart, null, { profile: 'thumbnail', idPrefix: 'chart-preview' });
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${canvas.width}" height="${canvas.height}" viewBox="${viewBox}" preserveAspectRatio="xMidYMid meet">${drawing}</svg>`;
    image.src = `data:image/svg+xml,${encodeURIComponent(svg)}`;
  } catch { dispose(); }
  return dispose;
}
