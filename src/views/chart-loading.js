// Presentation only: the session owns whether a chart exists; transit owns
// loading/errors. A ready chart must never wait for the rest of the day packet.
export function attachChartLoading({ canvas, drawing, art, message, status, retry, heading, onRetry }) {
  let previous = null;
  retry.addEventListener('click', onRetry);
  return {
    update({ hasChart, failed = false, loading = false }) {
      const state = hasChart ? 'ready' : failed && !loading ? 'error' : 'loading';
      if (state === previous) return;
      previous = state;
      const ready = state === 'ready';
      canvas.dataset.chartState = state;
      canvas.setAttribute('aria-busy', String(state === 'loading'));
      canvas.inert = !ready;
      drawing.setAttribute('tabindex', ready ? '0' : '-1');
      drawing.setAttribute('aria-hidden', String(!ready));
      art.toggleAttribute('hidden', ready);
      message.hidden = ready;
      heading.style.visibility = ready ? '' : 'hidden';
      status.textContent = ready ? '' : state === 'error' ? 'Не удалось загрузить карту' : 'Загружаем карту…';
      retry.hidden = state !== 'error';
    },
  };
}
