// The button owns one pending import. Closing that request never lets a late
// module open a dialog; the downloaded view remains reusable on the next click.
export function attachKnowledgeEntry({ button, dialog, onSelect, getSelection, beforeOpen = () => {}, onError = () => {},
  eventTarget = globalThis.document, load = () => import('./knowledge.js') }) {
  let view = null, pending = null, requested = false;
  async function show() {
    beforeOpen();
    if (view) { view.show(getSelection()); return true; }
    requested = true;
    button.setAttribute('aria-busy', 'true');
    pending ??= Promise.resolve().then(load).then(({ attachKnowledge }) => {
      view = attachKnowledge(dialog, onSelect);
      return view;
    }).catch(() => {
      if (requested) onError('Не удалось открыть справочник. Попробуйте ещё раз.');
      return null;
    }).finally(() => { pending = null; button.removeAttribute('aria-busy'); });
    const loaded = await pending;
    if (!loaded) { requested = false; return false; }
    if (!requested) return false;
    requested = false;
    loaded.show(getSelection());
    return true;
  }
  button.addEventListener('click', show);
  eventTarget?.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || !requested) return;
    requested = false;
    button.removeAttribute('aria-busy');
  });
  return { show };
}
