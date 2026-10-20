// Navigation owns the active screen. One pending import can be reused, but
// only the latest request for the library may reveal its page.
export function attachKnowledgeEntry({ button, dialog, onSelect, getSelection, onOpen,
  isCurrent = () => true, onError = () => {}, load = () => import('./knowledge.js') }) {
  let view = null, pending = null, revision = 0, requested = null;
  async function show() {
    if (!isCurrent()) return false;
    const request = ++revision;
    requested = request;
    if (view) { requested = null; view.show(getSelection()); return true; }
    button.setAttribute('aria-busy', 'true');
    pending ??= Promise.resolve().then(load).then(({ attachKnowledge }) => {
      view = attachKnowledge(dialog, onSelect);
      return view;
    }).catch(() => {
      if (requested !== null && isCurrent()) onError('Не удалось открыть справочник. Попробуйте ещё раз.');
      return null;
    }).finally(() => { pending = null; button.removeAttribute('aria-busy'); });
    const loaded = await pending;
    if (requested !== request) return false;
    requested = null;
    if (!loaded || !isCurrent()) return false;
    loaded.show(getSelection());
    return true;
  }
  function hide() {
    requested = null;
    button.removeAttribute('aria-busy');
    if (view) view.hide();
    else dialog.hidden = true;
  }
  button.addEventListener('click', () => onOpen ? onOpen() : show());
  return { show, hide };
}
