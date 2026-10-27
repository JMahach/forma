import type { ChartRecord } from '../../shared/chart-types.ts';
export type ChartCalculation = Omit<ChartRecord, 'id' | 'note' | 'createdAt' | 'updatedAt'> & Partial<Pick<ChartRecord, 'id' | 'note' | 'createdAt' | 'updatedAt'>>;
// Stable names and local record identity; no storage access or UI policy.
export function normalizeChartName(value: unknown) {
  return String(value ?? '').trim().replace(/\p{L}/u, letter => letter.toUpperCase());
}

export function createChartId(cryptoApi = globalThis.crypto) {
  if (typeof cryptoApi?.randomUUID === 'function') return cryptoApi.randomUUID();
  if (typeof cryptoApi?.getRandomValues !== 'function') {
    throw new Error('Браузер не поддерживает создание идентификатора карты. Обновите браузер.');
  }
  // randomUUID requires HTTPS; random bytes also work on ordinary HTTP.
  const bytes = cryptoApi.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
