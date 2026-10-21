// This stand-only UI mode belongs to the current tab, never to its address.
const STORAGE_KEY = 'forma.loading-preview.v1';

export function attachLoadingPreview({ button, location, getStorage = () => globalThis.sessionStorage, beforeNavigate = () => {} }) {
  const allowed = new URL(location.href).port === '3636';
  let active = false;
  if (allowed) {
    try { active = getStorage().getItem(STORAGE_KEY) === '1'; } catch {}
  }
  button.hidden = !allowed;
  button.setAttribute('aria-pressed', String(active));
  if (allowed) button.addEventListener('click', () => {
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
