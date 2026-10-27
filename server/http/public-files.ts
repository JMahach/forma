import { appMetadataAttributes } from '../../shared/app-metadata.ts';
import { readAppRoute } from '../../shared/app-routes.ts';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { StaticEntry, ReleaseEntry } from './static-assets.ts';
export type PublicFiles = Map<string, string | StaticEntry>;
interface PublicFileOptions {
  root: string;
  files?: PublicFiles;
  precompressed?: boolean;
  cyclesVersion?: string | null;
  calculationVersion?: string | null;
  environment?: 'stand' | 'production';
  appVersion?: string | null;
}

import fs from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import path from 'node:path';
import { isIP } from 'node:net';
import { brotliCompressSync, gzipSync } from 'node:zlib';
import { createStaticAssets } from './static-assets.ts';
import { negotiateEncoding } from './content-encoding.ts';
import { prepareLoadingPage } from '../../src/scene/loading-placeholder.ts';

// Every browser entry/dependency is explicit. Project files outside this map
// remain private even when a new directory or file is added to the repository.
export const PUBLIC_FILES = new Map<string, string>([
  ['index.html', 'public/index.html'],
  ['styles.css', 'public/styles.css'],
  ['favicon.svg', 'public/favicon.svg'],
  ['love.html', 'public/love.html'],
  ['love', 'public/love.html'],
  ['love.css', 'public/love.css'],
  ...[
    'src/dev/control-colors.ts',
    'src/dev/account-preview.ts',
    'src/dev/account-adapter.ts',
    'src/dev/calculation-preview.ts',
    'src/dev/stand-connection.ts',
    'src/account.ts',
    'src/data/account-client.ts',
    'src/data/telegram-login.ts',
    'src/data/account-logout-store.ts',
    'src/state/account-session.ts',
    'src/state/navigation.ts',
    'shared/app-routes.ts',
    'src/state/account-flow.ts',
    'src/views/account.ts',
    'src/ui/messages.ts',
    'src/ui/feedback.ts',
    'src/ui/action-state.ts',
    'src/data/http-transport.ts',
    'src/dev/shared-chart-preview.ts',
    'shared/lifetime-format.ts',
    'shared/lifetime-exact-format.ts',
    'shared/cycles-format.ts',
    'shared/chart-activations.ts',
    'shared/calculation-result.ts',
    'shared/chart-record-contract.ts',
    'shared/chart-return-contract.ts',
    'shared/utc-format.ts',
    'shared/date-limits.ts',
    'shared/development.ts',
    'shared/day-packets/decode.ts',
    'shared/day-packets/moment-columns.ts',
    'shared/day-packets/float64-codec.ts',
    'shared/day-packets/natal-format.ts',
    'shared/day-packets/transit-format.ts',
    'src/app.ts',
    'src/journal.ts',
    'src/offline/page-coordinator.ts',
    'shared/offline-contract.ts',
    'shared/client-report-contract.ts',
    'shared/account-contract.ts',
    'src/diagnostics/client-reports.ts',
    'src/diagnostics/browser-source.ts',
    'src/data/diagnostic-queue.ts',
    'src/data/diagnostic-delivery.ts',
    'src/data/diagnostic-client.ts',
    'src/data/birth-client.ts',
    'src/domain/chart-record.ts',
    'src/domain/birth-form-draft.ts',
    'src/domain/input-draft.ts',
    'src/views/returns-markers.ts',
    'src/views/returns-panel.ts',
    'src/views/returns-clock.ts',
    'src/state/returns.ts',
    'src/state/panels.ts',
    'src/state/library-selection.ts',
    'src/state/workspace.ts',
    'src/data/cycles-client.ts',
    'src/data/return-storage.ts',
    'src/domain/cycles.ts',
    'src/domain/returns-window.ts',
    'src/domain/personal-age.ts',
    'src/domain/chart-overlay.ts',
    'src/domain/chart-composition.ts',
    'src/domain/chart-data.ts',
    'src/scene/overlay-activation-columns.ts',
    'src/entry.ts',
    'src/startup.ts',
    'src/views/loading-preview.ts',
    'src/views/chart-loading.ts',
    'src/data/api-client.ts',
    'src/data/chart-store.ts',
    'src/data/chart-client.ts',
    'src/data/account-library-store.ts',
    'src/data/storage-pressure.ts',
    'src/domain/account-chart.ts',
    'src/state/account-library.ts',
    'src/state/chart-actions.ts',
    'src/data/binary-cache.ts', 'src/data/indexed-db.ts',
    'src/data/calculation-migration.ts',
    'src/data/calculation-updates.ts', 'src/data/calculation-clients.ts', 'src/data/calculation-cache.ts',
    'src/data/natal-day-client.ts',
    'src/data/shared-request.ts',
    'src/data/storage.ts',
    'src/data/view-store.ts',
    'src/data/transit-day-client.ts',
    'src/data/memory-cache.ts',
    'src/data/transit-day-cache.ts',
    'src/data/lifetime-client.ts',
    'src/diagnostics/frame-monitor.ts',
    'src/domain/day-timeline.ts',
    'src/domain/gate-wheel.ts',
    'src/domain/line-fixing-data.ts',
    'src/domain/line-fixing.ts',
    'src/domain/mandala-cross.ts',
    'src/domain/natal-day.ts',
    'src/domain/planets.ts',
    'src/domain/substructure.ts',
    'src/domain/topology.ts',
    'src/domain/transit-day.ts',
    'src/domain/lifetime.ts',
    'src/domain/moment-projection.ts',
    'src/domain/variables.ts',
    'src/reference/catalog.ts',
    'src/reference/knowledge-content.ts',
    'src/reference/knowledge-catalog.ts',
    'src/scene/activation-columns.ts',
    'src/scene/activation-targets.ts',
    'src/scene/activation-hover.ts',
    'src/scene/activation-painter.ts',
    'src/scene/backdrop.ts',
    'src/scene/bodygraph-paint.ts',
    'src/scene/integration-paint.ts',
    'src/scene/bodygraph-painter.ts',
    'src/scene/bodygraph-svg.ts',
    'src/scene/gate-label.ts',
    'src/scene/camera.ts',
    'src/scene/camera-view.ts',
    'src/scene/geometry/activation-layout.ts',
    'src/scene/geometry/chart-geometry.ts',
    'src/scene/geometry/drawing-geometry.ts',
    'src/scene/geometry/drawing-presentation.ts',
    'src/scene/geometry/frames.ts',
    'src/scene/geometry/integration-geometry.ts',
    'src/scene/geometry/lotus-backdrop.ts',
    'src/scene/geometry/mandala-geometry.ts',
    'src/scene/geometry/mandala-planets.ts',
    'src/scene/gestures.ts',
    'src/scene/pointer-target.ts',
    'src/scene/camera-fit.ts',
    'src/scene/mandala-painter.ts',
    'src/scene/mandala-preview-painter.ts',
    'src/scene/mandala-preview.ts',
    'src/scene/mandala-paint-rules.ts',
    'src/scene/mandala.ts',
    'src/scene/modes/mandala-motion.ts',
    'src/scene/modes/mandala.ts',
    'src/scene/render-state.ts',
    'src/scene/renderer.ts',
    'src/ui/layout/studio.ts',
    'src/ui/layout/studio-controller.ts',
    'src/ui/layout/viewport.ts',
    'src/ui/layout/metrics.ts',
    'src/ui/timeline-ticks.ts',
    'src/ui/overlay-palette.ts',
    'src/ui/chart-palette.ts',
    'src/scene/svg-patches.ts',
    'src/scene/soft-highlight.ts',
    'src/scene/updates.ts',
    'src/scene/variable-arrows.ts',
    'src/selection/hover-preview.ts',
    'src/selection/selection-model.ts',
    'src/selection/selection-state.ts',
    'src/selection/selection-targets.ts',
    'src/state/chart-session.ts',
    'src/state/chart-exploration.ts',
    'src/state/view-session.ts',
    'src/state/live-transit.ts',
    'src/state/natal-day.ts',
    'src/state/lifetime.ts',
    'src/state/transit-planets.ts',
    'src/state/chart-highlight.ts',
    'src/stories/vessel-of-love.ts',
    'src/ui/html.ts',
    'src/ui/studio-presentation.ts',
    'src/ui/page-gestures.ts',
    'src/ui/telegram-gestures.ts',
    'src/ui/toast.ts',
    'src/views/activation-details.ts',
    'src/views/activation-popover.ts',
    'src/views/birth-form.ts',
    'src/views/camera-controls.ts',
    'src/views/chart-display.ts',
    'src/ui/layout/chart-heading.ts',
    'src/views/chart-summary-panel.ts',
    'src/views/side-panel-controls.ts',
    'src/views/date-input.ts',
    'src/views/input-selection.ts',
    'src/views/date-picker.ts',
    'src/views/timeline-range.ts',
    'src/views/timeline-marks.ts',
    'src/views/knowledge.ts',
    'src/views/knowledge-center-figure.ts',
    'src/views/workspace-header.ts',
    'src/views/random-chart.ts',
    'src/views/knowledge-entry.ts',
    'src/views/library.ts',
    'src/views/all-charts.ts',
    'src/views/chart-preview-canvas.ts',
    'src/views/live-transit.ts',
    'src/views/natal-day-controls.ts',
    'src/views/lifetime-controls.ts',
    'src/views/performance-monitor.ts',
    'src/views/transit-controls.ts',
  ].map(filename => [filename, filename] as [string, string]),
]);
const CONTENT_TYPES: Record<string, string> = { '.ts': 'text/javascript; charset=utf-8', '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json; charset=utf-8' };

// A release manifest names only generated page/assets, never source or private
// project paths. It is read once at startup; a broken release fails to start.
export async function readReleaseManifest(directory: string): Promise<Map<string, ReleaseEntry>> {
  const entries = JSON.parse(await fs.readFile(path.join(directory, 'manifest.json'), 'utf8')) as Record<string, ReleaseEntry>;
  const files = new Map<string, ReleaseEntry>();
  const asset = /^assets\/[a-zA-Z0-9_-]+-[a-zA-Z0-9_-]{8,}\.(?:js|css|svg)$/;
  for (const [url, entry] of Object.entries(entries)) {
    const page = ['index.html', 'love.html', 'love'].includes(url);
    const worker = url === 'service-worker.js';
    if (!entry || !(page ? entry.file === (url === 'love' ? 'love.html' : url) : (worker || asset.test(url)) && entry.file === url)
      || entry.br !== `${entry.file}.br` || entry.gzip !== `${entry.file}.gz`
      || entry.immutable !== !(page || worker)) throw new Error(`Invalid public release entry: ${url}`);
    files.set(url, entry);
  }
  for (const page of ['index.html', 'love.html', 'love']) {
    if (!files.has(page)) throw new Error(`Missing release page: ${page}`);
  }
  await Promise.all([...files.values()].flatMap(entry => [entry.file, entry.br, entry.gzip])
    .map(async file => { if (!(await fs.stat(path.join(directory, file))).isFile()) throw new Error(`Invalid release file: ${file}`); }));
  return files;
}

// The source stand can replace a previously installed release worker at its
// original URL. No fetch handler, storage cleanup or forced page navigation.
const RETIRE_LOCAL_WORKER = `self.addEventListener('install', event => event.waitUntil(self.skipWaiting()));
self.addEventListener('activate', event => event.waitUntil(self.registration.unregister()));
`;

export function createPublicFileHandler({ root, files = PUBLIC_FILES, precompressed = false, cyclesVersion = null, calculationVersion = null, environment = 'stand', appVersion = null }: PublicFileOptions) {
  const metadataAttributes = appMetadataAttributes({environment, appVersion, cyclesVersion, calculationVersion});
  const assets = createStaticAssets(root, { precompressed, transform: (entry, bytes) => {
    if (!precompressed && entry.file.endsWith('.ts')) {
      return Buffer.from(stripTypeScriptTypes(bytes.toString('utf8'), { mode: 'strip' }));
    }
    if (!['public/index.html', 'index.html'].includes(entry.file)) return bytes;
    let html = prepareLoadingPage(bytes.toString('utf8'));
    html = html.replace(/<body\b/, `<body${metadataAttributes}`);
    return Buffer.from(html);
  } });
  return async function servePublicFile(req: IncomingMessage, res: ServerResponse, pathname: string) {
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, { Allow: 'GET, HEAD' }); res.end(); return; }
    const filename = readAppRoute(pathname) ? 'index.html' : decodeURIComponent(pathname.slice(1));
    if (filename === 'service-worker.js' && !precompressed && environment === 'stand') {
      const address = req.socket?.remoteAddress?.replace(/^::ffff:/, '');
      const loopback = address === '::1' || !!address && isIP(address) === 4 && address.startsWith('127.');
      if (loopback && /^(?:localhost|127\.0\.0\.1|\[::1\])(?::[0-9]{1,5})?$/i.test(req.headers.host ?? '')) {
        const encoding = negotiateEncoding(req.headers['accept-encoding']);
        if (!encoding) { res.writeHead(406, { Vary: 'Accept-Encoding' }); res.end(); return; }
        const source = Buffer.from(RETIRE_LOCAL_WORKER);
        const body = encoding === 'br' ? brotliCompressSync(source) : encoding === 'gzip' ? gzipSync(source) : source;
        res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Content-Length': body.length,
          'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', Vary: 'Accept-Encoding',
          ...(encoding === 'identity' ? {} : { 'Content-Encoding': encoding }) });
        res.end(req.method === 'HEAD' ? undefined : body); return;
      }
    }
    const entry = files.get(filename);
    if (!entry) { res.writeHead(404); res.end('Not found'); return; }
    const encoding = negotiateEncoding(req.headers['accept-encoding']);
    if (!encoding) { res.writeHead(406, { Vary: 'Accept-Encoding' }); res.end(); return; }
    const asset = await assets.get(typeof entry === 'string' ? { file: entry } : entry);
    const body = asset.bytes[encoding], etag = asset.etags[encoding];
    const headers = {
      'Content-Type': CONTENT_TYPES[path.extname(filename)] || CONTENT_TYPES[path.extname(asset.file)] || 'text/plain',
      'Content-Length': body.length,
      'Cache-Control': typeof entry !== 'string' && entry.immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
      'X-Content-Type-Options': 'nosniff', Vary: 'Accept-Encoding', ETag: etag,
      ...(encoding === 'identity' ? {} : { 'Content-Encoding': encoding }),
    };
    const matched = String(req.headers['if-none-match'] || '').split(',').some(value => value.trim() === '*' || value.trim().replace(/^W\//, '') === etag);
    res.writeHead(matched ? 304 : 200, headers);
    res.end(matched || req.method === 'HEAD' ? undefined : body);
  };
}
