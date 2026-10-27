// This UI mode belongs to the current tab, never to its address.
const STORAGE_KEY = 'forma.loading-preview.v1';

export function attachLoadingPreview({ button, location, getStorage = () => globalThis.sessionStorage, beforeNavigate = () => {} }: { button: HTMLButtonElement; location: Pick<Location, 'href' | 'reload'>; getStorage?: () => Storage; beforeNavigate?: () => void }) {
  let active = false;
  try { active = getStorage().getItem(STORAGE_KEY) === '1'; } catch {}
  button.hidden = false;
  button.setAttribute('aria-pressed', String(active));
  button.addEventListener('click', () => {
    beforeNavigate();
    try {
      const storage = getStorage();
      if (active) storage.removeItem(STORAGE_KEY);
      else storage.setItem(STORAGE_KEY, '1');
    } catch { return; }
    active = !active;
    button.setAttribute('aria-pressed', String(active));
    location.reload();
  });
  return active;
}
