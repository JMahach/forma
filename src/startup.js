import { createTransitDayClient } from './data/transit-day-client.js';

// Start the current UTC packet before evaluating the UI graph. The live view
// receives this same client and owns the local-day range, retry and visibility.
const dayClient = createTransitDayClient({
  initialDate: document.hidden ? null : new Date().toISOString().slice(0, 10),
});
const app = await import('./app.js').catch(() => {
  const canvas = document.getElementById('canvasWrap');
  canvas.dataset.chartState = 'error';
  canvas.setAttribute('aria-busy', 'false');
  document.getElementById('chartLoadingStatus').textContent = 'Не удалось загрузить приложение';
  const retry = document.getElementById('chartLoadingRetry');
  retry.hidden = false;
  retry.addEventListener('click', () => location.reload());
});
app?.startApp({ dayClient });
