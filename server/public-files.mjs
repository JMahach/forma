import fs from 'node:fs/promises';
import path from 'node:path';

// Every browser entry/dependency is explicit. Project files outside this map
// remain private even when a new directory or file is added to the repository.
export const PUBLIC_FILES = new Map([
  ['index.html', 'public/index.html'],
  ['styles.css', 'public/styles.css'],
  ['favicon.svg', 'public/favicon.svg'],
  ['love.html', 'public/love.html'],
  ['love', 'public/love.html'],
  ['love.css', 'public/love.css'],
  ...[
    'src/app.js',
    'src/api/client.js',
    'src/ui/html.js',
    'src/ui/toast.js',
    'src/ui/telegram-gestures.js',
    'src/domain/gate-wheel.js',
    'src/transit/day-packet.js',
    'src/transit/day-client.js',
    'src/transit/day-timeline.js',
    'src/transit/chart-day-packet.js',
    'src/transit/chart-day-client.js',
    'src/transit/chart-day-cache.js',
    'src/stories/vessel-of-love.js',
    'src/bodygraph/bodygraph.js',
    'src/bodygraph/chart-backdrop.js',
    'src/bodygraph/lotus-backdrop.js',
    'src/bodygraph/lotus-mode.js',
    'src/bodygraph/graph-data.js',
    'src/bodygraph/graph-controller.js',
    'src/bodygraph/camera-controls.js',
    'src/bodygraph/studio-layout.js',
    'src/bodygraph/drawing-geometry.js',
    'src/bodygraph/render-state.js',
    'src/bodygraph/integration-geometry.js',
    'src/bodygraph/gestures.js',
    'src/bodygraph/mandala.js',
    'src/bodygraph/mandala-mode.js',
    'src/bodygraph/mandala-motion.js',
    'src/bodygraph/mandala-cross.js',
    'src/bodygraph/mandala-preview.js',
    'src/bodygraph/mandala-preview-painter.js',
    'src/bodygraph/mandala-underlay.js',
    'src/selection/mandala-selection-state.js',
    'src/selection/selection-state.js',
    'src/selection/selection-targets.js',
    'src/selection/hover-preview.js',
    'src/activations/activations.js',
    'src/activations/activation-layout.js',
    'src/activations/activation-details.js',
    'src/activations/activation-popover.js',
    'src/activations/variables.js',
    'src/activations/variable-arrows.js',
    'src/activations/line-fixing.js',
    'src/activations/line-fixing-data.js',
    'src/charts/storage.js',
    'src/charts/chart-store.js',
    'src/charts/chart-display.js',
    'src/charts/chart-heading-layout.js',
    'src/charts/chart-library.js',
    'src/charts/birth-form.js',
    'src/charts/live-transit.js',
    'src/charts/transit-controls.js',
    'src/charts/day-range.js',
    'src/charts/chart-day-explorer.js',
    'src/charts/chart-thumbnail.js',
    'src/charts/chart-summary-data.js',
    'src/charts/chart-summary-panel.js',
    'src/selection/summary-selection-state.js',
    'src/charts/date-input.js',
    'src/library/knowledge.js',
  ].map(filename => [filename, filename]),
]);
const CONTENT_TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json; charset=utf-8' };

export async function servePublicFile(root, req, res, pathname) {
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, { Allow: 'GET, HEAD' }); res.end(); return; }
  const filename = pathname === '/' ? 'index.html' : decodeURIComponent(pathname.slice(1));
  const file = PUBLIC_FILES.get(filename);
  if (!file) { res.writeHead(404); res.end('Not found'); return; }
  const data = await fs.readFile(path.join(root, file));
  res.writeHead(200, { 'Content-Type': CONTENT_TYPES[path.extname(file)] || 'text/plain', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
  res.end(req.method === 'HEAD' ? undefined : data);
}
