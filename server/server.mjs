import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCityCatalog } from './services/cities.mjs';
import { createCalculator } from './services/calculate.mjs';
import { createRequestHandler } from './http/app.mjs';
import { createTransitDays } from './services/transit-days.mjs';
import { createChartDays } from './services/natal-days.mjs';
import { createPublicFileHandler, readReleaseManifest } from './http/public-files.mjs';
import { createLifetimeArchive } from './services/lifetime.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const port = Number(process.env.PORT || 4173);
const host = process.env.HOST || '127.0.0.1';
const cities = await loadCityCatalog(path.join(root, 'data/cities.json'));
const calculate = createCalculator({ root });
const transitDays = await createTransitDays({ root, cacheDir: process.env.TRANSIT_CACHE_DIR });
const chartDays = createChartDays({ root });
const lifetimeFile = process.env.FORMA_LIFETIME_CORPUS;
const lifetime = lifetimeFile ? await createLifetimeArchive({ file: lifetimeFile,
  metadataFile: lifetimeFile.replace(/\.f64le$/, '.metadata.json') }) : null;
const releaseDir = process.argv.includes('--release') ? path.join(root, 'dist') : null;
const publicFiles = createPublicFileHandler({ lifetimeEnabled: Boolean(lifetime), ...(releaseDir
  ? { root: releaseDir, files: await readReleaseManifest(releaseDir), precompressed: true } : { root }) });
const handler = createRequestHandler({ root, cities, calculate, transitDays, chartDays, lifetime, publicFiles });

const server = http.createServer(handler).listen(port, host, () => {
  console.log(`Форма: http://${host}:${port}`);
  transitDays.startWarmup();
});
server.on('close', () => { void Promise.allSettled([transitDays.close(), lifetime?.close(), calculate.close()]); });
// Let HTTP requests drain, then close owned sessions instead of orphaning them.
process.once('SIGTERM', () => server.close());
process.once('SIGINT', () => server.close());
