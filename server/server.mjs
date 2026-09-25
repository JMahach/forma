import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCityCatalog } from './city-catalog.mjs';
import { createCalculator } from './calculator-process.mjs';
import { createRequestHandler } from './app.mjs';
import { createTransitDays } from './transit-days.mjs';
import { createChartDays } from './chart-days.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const port = Number(process.env.PORT || 4173);
const host = process.env.HOST || '127.0.0.1';
const cities = await loadCityCatalog(path.join(root, 'data/cities.json'));
const calculate = createCalculator({ root });
const transitDays = await createTransitDays({ root, cacheDir: process.env.TRANSIT_CACHE_DIR });
const chartDays = createChartDays({ root });
const handler = createRequestHandler({ root, cities, calculate, transitDays, chartDays });

const server = http.createServer(handler).listen(port, host, () => {
  console.log(`Форма: http://${host}:${port}`);
  transitDays.startWarmup();
});
server.on('close', () => transitDays.close());
