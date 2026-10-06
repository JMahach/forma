import http from 'node:http';
import { networkInterfaces } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCityCatalog } from './services/cities.mjs';
import { createCalculator } from './services/calculate.mjs';
import { createRequestHandler } from './http/app.mjs';
import { createTransitDays } from './services/transit-days.mjs';
import { createChartDays } from './services/natal-days.mjs';
import { createPublicFileHandler, readReleaseManifest } from './http/public-files.mjs';
import { createCycles, cyclesCalculationFingerprint } from './services/cycles.mjs';
import { createLifetimeArchive, lifetimeCalculationFingerprint } from './services/lifetime.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const port = Number(process.env.PORT || 4176);
const host = process.env.HOST || '0.0.0.0';
const cities = await loadCityCatalog(path.join(root, 'data/cities.json'));
const calculate = createCalculator({ root });
const transitDays = await createTransitDays({ root, cacheDir: process.env.TRANSIT_CACHE_DIR });
const chartDays = createChartDays({ root });
const cyclesVersion = await cyclesCalculationFingerprint(root);
const cycles = createCycles({ root, cacheVersion: cyclesVersion });
const lifetimeFile = process.env.FORMA_LIFETIME_CORPUS;
const lifetime = lifetimeFile ? await createLifetimeArchive({ file: lifetimeFile,
  metadataFile: lifetimeFile.replace(/\.f64le$/, '.metadata.json') }) : null;
const lifetimeFingerprint = lifetime ? await lifetimeCalculationFingerprint(root) : null;
const releaseDir = process.argv.includes('--release') ? path.join(root, 'dist') : null;
const publicFiles = createPublicFileHandler({ lifetimeEnabled: Boolean(lifetime), cyclesVersion, ...(releaseDir
  ? { root: releaseDir, files: await readReleaseManifest(releaseDir), precompressed: true } : { root }) });
const handler = createRequestHandler({ root, cities, calculate, transitDays, chartDays, lifetime, lifetimeFingerprint, cycles, publicFiles });

const server = http.createServer(handler).listen(port, host, () => {
  const addresses = host === '0.0.0.0'
    ? ['localhost', ...new Set(Object.values(networkInterfaces()).flat()
      .filter(entry => entry.family === 'IPv4').map(entry => entry.address))]
    : [host];
  for (const address of addresses) {
    const authority = address.includes(':') ? `[${address}]` : address;
    console.log(`Форма: http://${authority}:${port}/`);
  }
  transitDays.startWarmup();
});
server.on('close', () => { void Promise.allSettled([transitDays.close(), lifetime?.close(), cycles.close(), calculate.close()]); });
// Let HTTP requests drain, then close owned sessions instead of orphaning them.
process.once('SIGTERM', () => server.close());
process.once('SIGINT', () => server.close());
