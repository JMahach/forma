import { createTransitDayClient } from './data/transit-day-client.js';
import { createStudioLayout } from './scene/studio-controller.js';

// Start the current UTC packet before loading the main application. The live view
// receives this same client and owns the local-day range, retry and visibility.
const dayClient = createTransitDayClient({
  initialDate: document.hidden ? null : new Date().toISOString().slice(0, 10),
});
const element = id => document.getElementById(id);
const layout = createStudioLayout({ canvas: element('canvasWrap'), drawing: element('bodygraph'), art: element('chartLoadingArt'),
  panels: [element('transitControls'), element('chartDayControls'), element('lifetimeControls')] });
// The shared layout positions the preview while the larger application loads.
// Its temporary observer hands resize ownership to the app without recreating
// the layout or starting a second camera.
const loadingLayoutObserver = new ResizeObserver(() => layout.refresh());
loadingLayoutObserver.observe(element('canvasWrap'));
const app = await import('./app.js').catch(() => {
  const canvas = document.getElementById('canvasWrap');
  canvas.dataset.chartState = 'error';
  canvas.setAttribute('aria-busy', 'false');
  document.getElementById('chartLoadingStatus').textContent = 'Не удалось загрузить приложение';
  const retry = document.getElementById('chartLoadingRetry');
  retry.hidden = false;
  retry.addEventListener('click', () => location.reload());
});
if (app) {
  loadingLayoutObserver.disconnect();
  app.startApp({ dayClient, layout });
}
