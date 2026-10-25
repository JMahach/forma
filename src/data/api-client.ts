import { fetchResource, responseError } from './http-transport.ts';
export type { HttpResponseError as ApiError } from './http-transport.ts';

export async function requestJSON<T = unknown>(url: string, options: RequestInit = {}): Promise<T> {
  let response;
  try { response = await fetchResource(url, options); }
  catch (error) {
    if ((error as Error).name === 'AbortError' || (error as Error).name === 'ConnectionError') throw error;
    throw Object.assign(new Error('Нет связи с сервером'), { code: 'connection_failed' });
  }
  let data;
  try { data = await response.json(); }
  catch (error) {
    if ((error as Error).name === 'AbortError' || (error as Error).name === 'ConnectionError') throw error;
    if (!response.ok && (error as Error).name !== 'TypeError') throw responseError(response.status, null, 'Не удалось выполнить расчёт. Попробуйте ещё раз.');
    throw Object.assign(new Error('Не удалось получить ответ сервера'), { code: (error as Error).name === 'TypeError' ? 'connection_failed' : 'invalid_response', status: response.status });
  }
  if (!response.ok) throw responseError(response.status, data, 'Не удалось выполнить расчёт. Попробуйте ещё раз.');
  return data;
}
