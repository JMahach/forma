import { reportServerFailure, type ServerFailureReport, type HttpFailureComponent } from '../journal/report.ts';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { CityCatalog } from '../services/cities.ts';
import type { Calculator } from '../services/calculate.ts';
import { calculationFailureStatus } from '../services/chart-calculation.ts';
import type { createChartHandler } from './charts.ts';
import type { createDiagnosticHandler } from './diagnostics.ts';
import type { createAccountHandler } from './accounts.ts';
import { sendJSON as json, readJSONObject, HttpInputError } from './json.ts';
interface RequestHandlerOptions {
  root: string;
  report?: ServerFailureReport;
  cities: CityCatalog;
  calculate: (...args: Parameters<Calculator>) => ReturnType<Calculator>;
  issueCalculationReceipt?:(input:Parameters<Calculator>[0],result:unknown)=>string|undefined;
  issueReturnReceipt?:NonNullable<Parameters<typeof createCyclesHandler>[1]>['issueReceipt'];
  transitDays?: Parameters<typeof createTransitDayHandler>[0];
  natalDays?: Parameters<typeof createNatalDayHandler>[0];
  cycles?: Parameters<typeof createCyclesHandler>[0];
  lifetime?: Parameters<typeof createLifetimeHandler>[0];
  now?: () => Date;
  publicFiles?: ReturnType<typeof createPublicFileHandler>;
  accountHandler?: ReturnType<typeof createAccountHandler>;
  chartHandler?: ReturnType<typeof createChartHandler>;
  diagnosticHandler?: ReturnType<typeof createDiagnosticHandler>;
}

import { requestSignal } from './request-signal.ts';
import { rejectApiMethod } from './api-methods.ts';
import { createTransitDayHandler } from './transit-days.ts';
import { createNatalDayHandler } from './natal-days.ts';
import { createPublicFileHandler } from './public-files.ts';
import { createCyclesHandler } from './cycles.ts';
import { createLifetimeHandler } from './lifetime.ts';

const MAX_REQUEST_BYTES = 20000;
// Transport validation lives here; the catalogue owns city identity and the
// calculator owns process execution. Importing this module starts no server.
export function createRequestHandler({ root, report, cities, calculate, transitDays, natalDays, lifetime, cycles, now, accountHandler, chartHandler, issueCalculationReceipt, issueReturnReceipt, diagnosticHandler, publicFiles = createPublicFileHandler({ root }) }: RequestHandlerOptions) {
  const transitDay = transitDays && createTransitDayHandler(transitDays, { now, report });
  const natalDay = natalDays && createNatalDayHandler(natalDays, { report });
  const cycleHandler = cycles && createCyclesHandler(cycles, { report, issueReceipt:issueReturnReceipt });
  const lifetimePoint = createLifetimeHandler(lifetime, { report });
  return async function handleRequest(req: IncomingMessage, res: ServerResponse) {
    let url: URL, originHost: string | undefined;
    // Malformed transport input is a client rejection, not an internal failure.
    try {
      url = new URL(req.url!, 'http://localhost');
      decodeURIComponent(url.pathname);
      originHost = req.headers.origin ? new URL(req.headers.origin).host : undefined;
    } catch { json(res, 400, { error: 'invalid_request', message: 'Не удалось обработать запрос.' }); return; }
    let component: HttpFailureComponent = 'routing';
    try {
      // No cross-origin access to the API; no birth details in logs.
      if (originHost && originHost !== req.headers.host) {
        json(res, 403, { error: 'origin', message: 'Откройте сайт с адреса локального сервера.' }); return;
      }
      if (rejectApiMethod(req,res,url.pathname)) return;
      if (url.pathname === '/api/diagnostics') {
        if (!diagnosticHandler) { json(res,503,{error:'diagnostics_unavailable'});return; }
        await diagnosticHandler(req,res);return;
      }
      if (url.pathname === '/api/account' || url.pathname.startsWith('/api/auth/')) {
        if (!accountHandler) { json(res, 503, { error: 'account_unavailable' }); return; }
        component = 'account';
        await accountHandler(req, res, url); return;
      }
      if (url.pathname === '/api/charts' || url.pathname.startsWith('/api/charts/') || url.pathname.startsWith('/api/shared-charts/')) {
        if (!chartHandler) { json(res,503,{error:'chart_unavailable'}); return; }
        component = 'charts';
        await chartHandler(req,res,url); return;
      }
      if (url.pathname === '/api/cycles/events' || url.pathname === '/api/cycles/chart') {
        if (!cycleHandler) { json(res, 503, { error: 'cycles_unavailable', message: 'Расчёт циклов недоступен.' }); return; }
        await cycleHandler(req, res, url); return;
      }
      if (url.pathname === '/api/lifetime' || url.pathname === '/api/lifetime/meta') {
        await lifetimePoint(req, res, url); return;
      }
      if (url.pathname === '/api/transit/day') {
        if (!transitDays) { json(res, 503, { error: 'transit_unavailable', message: 'Дневной транзит недоступен.' }); return; }
        await transitDay!(req, res, url); return;
      }
      if (url.pathname === '/api/chart/day') {
        if (!natalDays) { json(res, 503, { error: 'natal_day_unavailable', message: 'День рождения недоступен.' }); return; }
        await natalDay!(req, res, cities); return;
      }
      if (url.pathname === '/api/cities' && req.method === 'GET') {
        component = 'cities';
        json(res, 200, { cities: cities.search(url.searchParams.get('q') || '') }); return;
      }
      if (url.pathname === '/api/calculate' && req.method === 'POST') {
        component = 'calculator';
        let input;
        try { input = await readJSONObject(req, MAX_REQUEST_BYTES); }
        catch (error) {
          if (!(error instanceof HttpInputError)) throw error;
          const messages: Record<string, string> = {
            content_type: 'Нужны данные JSON.', too_large: 'Слишком большой запрос.',
            invalid_json: 'Не удалось прочитать данные.', invalid_request: 'Некорректные данные.',
          };
          json(res, error.status, { error: error.code, message: messages[error.code] }); return;
        }
        if (input.mode !== 'transit') {
          const city = cities.find(input.cityId, typeof input.cityName === 'string' ? input.cityName : undefined);
          if (!city) { json(res, 422, { error: 'city_required', message: 'Выберите город из списка подсказок.' }); return; }
          input.city = city;
        }
        const consumer = requestSignal(req, res);
        try {
          const result = await calculate(input, { signal: consumer.signal });
          if (consumer.signal.aborted) return;
          const status = result.error ? calculationFailureStatus(result.error) : 200;
          const receipt=issueCalculationReceipt?.(input,result);
          const body=receipt && result && typeof result==='object' && 'chart' in result && result.chart && typeof result.chart==='object'
            ?{...result,chart:{...result.chart,calculationReceipt:receipt}}:result;
          json(res, status, body); return;
        } finally { consumer.close(); }
      }
      component = 'public_files';
      await publicFiles(req, res, url.pathname);
    } catch {
      if (req.aborted || res.destroyed) return;
      reportServerFailure(report, {event:'http_request_failed',component,reason:'unexpected'});
      if (!res.headersSent) json(res, 500, { error: 'internal_error', message: 'Не удалось обработать запрос.' }); else res.end();
    }
  };
}
