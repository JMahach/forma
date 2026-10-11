// The page stays at its native scale, including body portals and modal dialogs.
// Cancel browser zoom without stopping propagation: the scene still owns its
// camera gestures, while ordinary scrolling and editable controls stay native.
export function attachPageGestures(document) {
  const cancelZoom = event => { if (event.cancelable) event.preventDefault(); };
  const options = { capture: true, passive: false };
  document.addEventListener('wheel', event => {
    if (event.ctrlKey || event.metaKey) cancelZoom(event);
  }, options);
  for (const type of ['gesturestart', 'gesturechange', 'gestureend']) {
    document.addEventListener(type, cancelZoom, options);
  }
  document.addEventListener('keydown', event => {
    if (event.altKey || !(event.ctrlKey || event.metaKey)) return;
    if (['+', '=', '-', '_', '0'].includes(event.key)) cancelZoom(event);
  }, { capture: true });
}
