const PREFERENCE_KEY = 'forma.view.lotus';

// A decorative view preference only. It never enters the saved chart, changes
// selection or moves the camera. Storage is optional, including on startup.
export function attachLotusMode({ button, render, storage }) {
  let preferenceStorage = null, enabled = false;
  try {
    preferenceStorage = storage === undefined ? globalThis.localStorage : storage;
    enabled = preferenceStorage?.getItem(PREFERENCE_KEY) === 'true';
  } catch { /* The switch still works when browser preferences are unavailable. */ }
  button.setAttribute('aria-checked', String(enabled));
  button.addEventListener('click', () => {
    enabled = !enabled;
    button.setAttribute('aria-checked', String(enabled));
    try { preferenceStorage?.setItem(PREFERENCE_KEY, String(enabled)); } catch { /* Keep this session's choice. */ }
    render();
  });
  return { get enabled() { return enabled; } };
}
