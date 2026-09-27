// Telegram's iOS browser detects dragging from CSS changes on the touched
// element and its ancestors. A blank SVG background moves a descendant, and
// a native range thumb does not change those styles, so that heuristic misses
// both. Use the same per-move cancellation signal on our gesture surfaces.
// This is an iOS implementation hook, not the Mini App swipe API:
// https://github.com/TelegramMessenger/Telegram-iOS/blob/master/submodules/BrowserUI/Sources/BrowserWebContent.swift
export function attachTelegramGestures(surfaces, { host = globalThis } = {}) {
  const elements = [...new Set(surfaces.filter(Boolean))];
  const options = { passive: true };
  function preserveTouch() {
    try {
      const proxy = host.TelegramWebviewProxy;
      if (typeof proxy?.postEvent !== 'function'
        || typeof host.webkit?.messageHandlers?.performAction?.postMessage !== 'function') return;
      proxy.postEvent('cancellingTouch', {});
    } catch {
      // A missing or incompatible host bridge must not interrupt the chart.
    }
  }
  for (const element of elements) element.addEventListener('touchmove', preserveTouch, options);
  return () => {
    for (const element of elements) element.removeEventListener('touchmove', preserveTouch, options);
  };
}
