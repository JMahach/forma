export async function requestJSON(url, options = {}) {
  let response;
  try { response = await fetch(url, options); }
  catch (error) {
    if (error.name === 'AbortError') throw error;
    throw new Error('Локальный сервер недоступен. Проверьте, что он запущен, и повторите попытку.');
  }
  let data;
  try { data = await response.json(); }
  catch { throw new Error('Сервер расчёта не ответил. Проверьте локальный запуск и повторите попытку.'); }
  if (!response.ok) {
    const error = new Error(data.message || 'Не удалось выполнить расчёт. Попробуйте ещё раз.');
    error.code = data.error; error.choices = data.choices;
    throw error;
  }
  return data;
}
