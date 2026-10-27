import type { City, CalculationRequest } from '../../shared/chart-types.ts';
import type { ChartCalculation } from '../domain/chart-record.ts';
import { requestJSON, type ApiError } from './api-client.ts';

// The form asks for cities or a calculation; HTTP shape and response checks stay here.
export function createBirthClient(request = requestJSON) {
  return {
    async findCities(query: string, signal: AbortSignal): Promise<City[]> {
      const data = await request<{ cities?: City[] }>(`/api/cities?q=${encodeURIComponent(query)}`, { signal });
      return Array.isArray(data.cities) ? data.cities : [];
    },
    async calculate(payload: CalculationRequest, signal: AbortSignal): Promise<ChartCalculation> {
      // /api/calculate never saves a chart. Only an explicit admission refusal
      // may be retried; lost responses and writes have different rules.
      const body = JSON.stringify(payload);
      let pauseMs = 500;
      for (;;) {
        signal.throwIfAborted();
        try {
          const data = await request<{ chart?: ChartCalculation }>('/api/calculate', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body, signal,
          });
          signal.throwIfAborted();
          if (!data.chart || !Array.isArray(data.chart.personality) || !Array.isArray(data.chart.design)) {
            throw new Error('Сервер вернул неполный расчёт. Карта не сохранена.');
          }
          return data.chart;
        } catch (error) {
          signal.throwIfAborted();
          const failure = error as ApiError | null;
          if (failure?.status !== 503 || failure.code !== 'busy') throw error;
          await waitForAdmission(pauseMs, signal);
          pauseMs = Math.min(pauseMs * 2, 4000);
        }
      }
    },
  };
}

function waitForAdmission(ms: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const cancel = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', cancel); resolve(); }, ms);
    signal.addEventListener('abort', cancel, { once: true });
  });
}
