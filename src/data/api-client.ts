export interface ApiError extends Error { code?: string; choices?: unknown }

export async function requestJSON<T = unknown>(url: string, options: RequestInit = {}): Promise<T> {
  let response;
  try { response = await fetch(url, options); }
  catch (error) {
    if ((error as Error).name === 'AbortError') throw error;
    throw Object.assign(new Error('Локальный сервер недоступен. Проверьте, что он запущен, и повторите попытку.'), { code: 'connection_failed' });
  }
  let data;
  try { data = await response.json(); }
  catch (error) {
    if ((error as Error).name === 'AbortError') throw error;
    throw Object.assign(new Error('Сервер расчёта не ответил. Проверьте локальный запуск и повторите попытку.'), { code: (error as Error).name === 'TypeError' ? 'connection_failed' : 'invalid_response' });
  }
  if (!response.ok) {
    const error = new Error(data.message || 'Не удалось выполнить расчёт. Попробуйте ещё раз.') as ApiError;
    error.code = data.error; error.choices = data.choices;
    throw error;
  }
  return data;
}
