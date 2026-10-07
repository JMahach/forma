import { createTransitDayClient } from './data/transit-day-client.js';
import { createViewStore } from './data/view-store.js';
import { createToast } from './ui/toast.js';
import { createStudioLayout } from './scene/studio-controller.js';

const element = id => document.getElementById(id);
const toast = createToast(element('toast'));
const viewStore = createViewStore({ onStorageError: toast }), savedView = viewStore.read();
// Read the tab once before prefetching. A saved lifetime, natal or exact return
// owns its own data; only Day and an explicitly live personal view need today.
const needsDay = (savedView?.selectedId ?? 'current-transit') === 'current-transit'
  ? savedView?.lifetime?.mode !== 'lifetime'
  : savedView?.lifetime?.personalLive === true && !savedView?.returns?.eventId;
const dayClient = createTransitDayClient({
  initialDate: !document.hidden && needsDay ? new Date().toISOString().slice(0, 10) : null,
});
const layout = createStudioLayout({ canvas: element('canvasWrap'), drawing: element('bodygraph'), art: element('chartLoadingArt'),
  panels: [element('transitControls'), element('natalDayControls'), element('lifetimeControls')] });
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
  app.startApp({ dayClient, layout, toast, viewStore, savedView });
}
