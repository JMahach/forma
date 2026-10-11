import { createTransitDayClient } from './data/transit-day-client.js';
import { createViewStore } from './data/view-store.js';
import { createToast } from './ui/toast.js';
import { createStudioLayout } from './ui/layout/studio-controller.js';
import { STUDIO_FOOTPRINT } from './scene/geometry/frames.js';
import { attachPageGestures } from './ui/page-gestures.js';

attachPageGestures(document);

const element = id => document.getElementById(id);
const toast = createToast(element('toast'));
const viewStore = createViewStore({ onStorageError: toast }), savedView = viewStore.read();
// Read the tab once before prefetching. A saved lifetime, natal or exact return
// owns its own data; only Day and an explicitly live personal view need today.
const needsDay = (savedView?.selectedId ?? 'current-transit') === 'current-transit'
  ? savedView?.lifetime?.mode !== 'lifetime'
  : savedView?.lifetime?.personalLive === true && !savedView?.returns?.eventId;
const dayClient = createTransitDayClient({
  calculationVersion: document.body.dataset.calculationVersion,
  initialDate: !document.hidden && needsDay ? new Date().toISOString().slice(0, 10) : null,
});
const layout = createStudioLayout({ footprint: STUDIO_FOOTPRINT, canvas: element('canvasWrap'), drawing: element('bodygraph'), art: element('chartLoadingArt'),
  panels: [element('transitControls'), element('natalDayControls'), element('lifetimeControls')] });
// The shared layout positions the preview while the larger application loads.
// Its temporary observer hands resize ownership to the app without recreating
// the layout or starting a second camera.
const loadingLayoutObserver = new ResizeObserver(() => layout.refresh());
loadingLayoutObserver.observe(element('canvasWrap'));
try {
  const app = await import('./app.js');
  loadingLayoutObserver.disconnect();
  app.startApp({ dayClient, layout, toast, viewStore, savedView });
} catch {
  const canvas = document.getElementById('canvasWrap');
  canvas.dataset.chartState = 'error';
  canvas.setAttribute('aria-busy', 'false');
  document.getElementById('chartLoadingStatus').textContent = 'Не удалось загрузить приложение';
  const retry = document.getElementById('chartLoadingRetry');
  retry.hidden = false;
  retry.addEventListener('click', () => location.reload());
}
