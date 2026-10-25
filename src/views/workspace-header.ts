// CSS owns the responsive layout; this controller only expands search and
// manages its accessible state and focus. The filter value belongs to the view.
export function attachWorkspaceHeader(page: HTMLElement,
  { initialExpanded, onChange = () => {} }: { initialExpanded?: boolean; onChange?: () => void } = {}) {
  const button = page.querySelector<HTMLButtonElement>('[data-workspace-search-toggle]');
  if (!button) return;
  const controls = button.getAttribute('aria-controls');
  const input = controls
    ? [...page.querySelectorAll<HTMLInputElement>('input[type="search"]')].find(field => field.id === controls)
    : page.querySelector<HTMLInputElement>('.workspace-search input[type="search"]');
  if (!input) return;

  button.type = 'button';
  function setExpanded(expanded: boolean) {
    page.dataset.searchOpen = String(expanded);
    button!.setAttribute('aria-expanded', String(expanded));
    button!.setAttribute('aria-label', expanded ? 'Закрыть поиск' : 'Открыть поиск');
  }
  setExpanded(initialExpanded ?? (page.dataset.searchOpen === 'true' || button.getAttribute('aria-expanded') === 'true'));

  button.addEventListener('click', () => {
    const expanded = page.dataset.searchOpen !== 'true';
    setExpanded(expanded);
    (expanded ? input : button).focus({ preventScroll: true });
    onChange();
  });
  page.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || event.isComposing || page.dataset.searchOpen !== 'true') return;
    // Search inputs can clear themselves on Escape. Collapse the field while
    // leaving the view's existing query and results intact.
    event.preventDefault();
    event.stopPropagation();
    setExpanded(false);
    button.focus({ preventScroll: true });
    onChange();
  });
  return { get expanded() { return page.dataset.searchOpen === 'true'; } };
}
