import fs from 'node:fs/promises';
import path from 'node:path';
import { createStaticAssets } from './static-assets.mjs';
import { negotiateEncoding } from './content-encoding.mjs';
import { prepareLoadingPage } from '../../src/scene/loading-placeholder.js';

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
    'shared/lifetime-format.js',
    'shared/lifetime-exact-format.js',
    'shared/cycles-format.js',
    'shared/date-limits.js',
    'shared/day-packets/decode.js',
    'shared/day-packets/moment-columns.js',
    'shared/day-packets/float64-codec.js',
    'shared/day-packets/natal-format.js',
    'shared/day-packets/transit-format.js',
    'src/app.js',
    'src/views/returns-markers.js',
    'src/views/returns-panel.js',
    'src/views/returns-clock.js',
    'src/state/returns.js',
    'src/data/cycles-client.js',
    'src/data/return-storage.js',
    'src/domain/cycles.js',
    'src/domain/returns-window.js',
    'src/domain/personal-age.js',
    'src/domain/chart-overlay.js',
    'src/domain/chart-composition.js',
    'src/scene/overlay-activation-columns.js',
    'src/startup.js',
    'src/views/chart-loading.js',
    'src/data/api-client.js',
    'src/data/chart-store.js',
    'src/data/binary-cache.js', 'src/data/indexed-db.js',
    'src/data/natal-day-client.js',
    'src/data/shared-request.js',
    'src/data/storage.js',
    'src/data/view-store.js',
    'src/data/transit-day-client.js',
    'src/data/memory-cache.js',
    'src/data/transit-day-cache.js',
    'src/data/lifetime-client.js',
    'src/diagnostics/frame-monitor.js',
    'src/domain/chart-facts.js',
    'src/domain/day-timeline.js',
    'src/domain/gate-wheel.js',
    'src/domain/line-fixing-data.js',
    'src/domain/line-fixing.js',
    'src/domain/mandala-cross.js',
    'src/domain/natal-day.js',
    'src/domain/planets.js',
    'src/domain/substructure.js',
    'src/domain/topology.js',
    'src/domain/transit-day.js',
    'src/domain/lifetime.js',
    'src/domain/moment-projection.js',
    'src/domain/variables.js',
    'src/reference/catalog.js',
    'src/reference/gate-descriptions.js',
    'src/scene/activation-columns.js',
    'src/scene/activation-painter.js',
    'src/scene/backdrop.js',
    'src/scene/bodygraph-paint.js',
    'src/scene/bodygraph-painter.js',
    'src/scene/bodygraph-svg.js',
    'src/scene/camera.js',
    'src/scene/camera-view.js',
    'src/scene/geometry/activation-layout.js',
    'src/scene/geometry/chart-geometry.js',
    'src/scene/geometry/drawing-geometry.js',
    'src/scene/geometry/drawing-presentation.js',
    'src/scene/geometry/frames.js',
    'src/scene/geometry/integration-geometry.js',
    'src/scene/geometry/lotus-backdrop.js',
    'src/scene/geometry/mandala-geometry.js',
    'src/scene/geometry/mandala-planets.js',
    'src/scene/gestures.js',
    'src/scene/pointer-target.js',
    'src/scene/layout.js',
    'src/scene/mandala-painter.js',
    'src/scene/mandala-preview-painter.js',
    'src/scene/mandala-preview.js',
    'src/scene/mandala-paint-rules.js',
    'src/scene/mandala.js',
    'src/scene/modes/mandala-motion.js',
    'src/scene/modes/mandala.js',
    'src/scene/render-state.js',
    'src/scene/renderer.js',
    'src/scene/studio-controller.js',
    'src/scene/svg-patches.js',
    'src/scene/updates.js',
    'src/scene/variable-arrows.js',
    'src/selection/hover-preview.js',
    'src/selection/selection-model.js',
    'src/selection/selection-state.js',
    'src/selection/selection-targets.js',
    'src/selection/summary-selection-state.js',
    'src/state/chart-session.js',
    'src/state/chart-exploration.js',
    'src/state/view-session.js',
    'src/state/live-transit.js',
    'src/state/natal-day.js',
    'src/state/lifetime.js',
    'src/state/transit-planets.js',
    'src/stories/vessel-of-love.js',
    'src/ui/html.js',
    'src/ui/telegram-gestures.js',
    'src/ui/toast.js',
    'src/views/activation-details.js',
    'src/views/activation-popover.js',
    'src/views/birth-form.js',
    'src/views/camera-controls.js',
    'src/views/chart-display.js',
    'src/views/chart-heading-layout.js',
    'src/views/chart-summary-data.js',
    'src/views/chart-summary-panel.js',
    'src/views/date-input.js',
    'src/views/date-picker.js',
    'src/views/timeline-range.js',
    'src/views/timeline-marks.js',
    'src/views/knowledge.js',
    'src/views/knowledge-entry.js',
    'src/views/library.js',
    'src/views/live-transit.js',
    'src/views/natal-day-controls.js',
    'src/views/lifetime-controls.js',
    'src/views/performance-monitor.js',
    'src/views/thumbnail.js',
    'src/views/transit-controls.js',
  ].map(filename => [filename, filename]),
]);
const CONTENT_TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json; charset=utf-8' };

// A release manifest names only generated page/assets, never source or private
// project paths. It is read once at startup; a broken release fails to start.
export async function readReleaseManifest(directory) {
  const entries = JSON.parse(await fs.readFile(path.join(directory, 'manifest.json'), 'utf8'));
  const files = new Map();
  const asset = /^assets\/[a-zA-Z0-9_-]+-[a-zA-Z0-9_-]{8,}\.(?:js|css|svg)$/;
  for (const [url, entry] of Object.entries(entries)) {
    const page = ['index.html', 'love.html', 'love'].includes(url);
    if (!entry || !(page ? entry.file === (url === 'love' ? 'love.html' : url) : asset.test(url) && entry.file === url)
      || entry.br !== `${entry.file}.br` || entry.gzip !== `${entry.file}.gz`
      || entry.immutable !== !page) throw new Error(`Invalid public release entry: ${url}`);
    files.set(url, entry);
  }
  for (const page of ['index.html', 'love.html', 'love']) {
    if (!files.has(page)) throw new Error(`Missing release page: ${page}`);
  }
  await Promise.all([...files.values()].flatMap(entry => [entry.file, entry.br, entry.gzip])
    .map(async file => { if (!(await fs.stat(path.join(directory, file))).isFile()) throw new Error(`Invalid release file: ${file}`); }));
  return files;
}

export function createPublicFileHandler({ root, files = PUBLIC_FILES, precompressed = false, cyclesVersion = null, calculationVersion = null }) {
  const cycleAttribute = typeof cyclesVersion === 'string' && /^[a-f0-9]{64}$/.test(cyclesVersion) ? ` data-cycles-version="${cyclesVersion}"` : '';
  const numericAttribute = typeof calculationVersion === 'string' && /^[a-f0-9]{64}$/.test(calculationVersion)
    ? ` data-calculation-version="${calculationVersion}"` : '';
  const assets = createStaticAssets(root, { precompressed, transform: (entry, bytes) => {
    if (!['public/index.html', 'index.html'].includes(entry.file)) return bytes;
    let html = prepareLoadingPage(bytes.toString('utf8'));
    html = html.replace('<body>', `<body${cycleAttribute}${numericAttribute}>`);
    return Buffer.from(html);
  } });
  return async function servePublicFile(req, res, pathname) {
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, { Allow: 'GET, HEAD' }); res.end(); return; }
    const filename = pathname === '/' ? 'index.html' : decodeURIComponent(pathname.slice(1));
    const entry = files.get(filename);
    if (!entry) { res.writeHead(404); res.end('Not found'); return; }
    const encoding = negotiateEncoding(req.headers['accept-encoding']);
    if (!encoding) { res.writeHead(406, { Vary: 'Accept-Encoding' }); res.end(); return; }
    const asset = await assets.get(typeof entry === 'string' ? { file: entry } : entry);
    const body = asset.bytes[encoding], etag = asset.etags[encoding];
    const headers = {
      'Content-Type': CONTENT_TYPES[path.extname(filename)] || CONTENT_TYPES[path.extname(asset.file)] || 'text/plain',
      'Content-Length': body.length,
      'Cache-Control': entry.immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
      'X-Content-Type-Options': 'nosniff', Vary: 'Accept-Encoding', ETag: etag,
      ...(encoding === 'identity' ? {} : { 'Content-Encoding': encoding }),
    };
    const matched = String(req.headers['if-none-match'] || '').split(',').some(value => value.trim() === '*' || value.trim().replace(/^W\//, '') === etag);
    res.writeHead(matched ? 304 : 200, headers);
    res.end(matched || req.method === 'HEAD' ? undefined : body);
  };
}
