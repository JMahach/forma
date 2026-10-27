interface LibraryAttributes {
  setAttribute(name: string, value: unknown): void;
  getAttribute(name: string): string | null;
}
interface LibraryActions { hidden: boolean; open: boolean }
interface LibraryButton extends LibraryAttributes { dataset: Record<string, string | undefined> }
interface LibraryRow {
  dataset: Record<string, string | undefined>; className: string; innerHTML: string;
  querySelector(selector: string): LibraryButton | LibraryActions | { src: string };
  getBoundingClientRect(): { top: number; bottom: number };
  nextSibling: LibraryRow | null; remove(): void;
}

// A small DOM surface for the library's behavioural tests. Layout and observer
// delivery are controlled explicitly; no storage or application globals exist.
export function libraryDom() {
  let created = 0, scrollTop = 0;
  const attributes = (): LibraryAttributes => {
    const values = new Map<string, string>();
    return { setAttribute: (name, value) => values.set(name, String(value)), getAttribute: name => values.get(name) ?? null };
  };
  const children: LibraryRow[] = [];
  const list = {
    ownerDocument: undefined as unknown as Document,
    addEventListener() {}, get firstChild() { return children[0] || null; },
    getBoundingClientRect: () => ({ top: 0, bottom: 200 }),
    insertBefore(row: LibraryRow, sibling: LibraryRow | null) {
      const old = children.indexOf(row); if (old !== -1) children.splice(old, 1);
      const index = children.indexOf(sibling!); children.splice(index < 0 ? children.length : index, 0, row);
    },
    get innerHTML() { return children.map(row => `<div class="${row.className}" data-active="${row.dataset.active}">${row.innerHTML}</div>`).join(''); },
  };
  const document = {
    createElement(tag: string) {
      created++;
      let markup = '';
      const button: LibraryButton = { dataset: {}, ...attributes() }; const image = { src: '' }, actions: LibraryActions = { hidden: false, open: false };
      const row: LibraryRow = {
        dataset: {}, className: '',
        set innerHTML(value) {
          markup = value; image.src = '';
          const card = value.match(/<button class="chart-card"[^>]*>/)?.[0] || '';
          button.dataset.active = card.match(/data-active="([^"]*)"/)?.[1];
          const pressed = card.match(/aria-pressed="([^"]*)"/)?.[1];
          if (pressed !== undefined) button.setAttribute('aria-pressed', pressed);
        },
        get innerHTML() {
          return markup.replace(/(<button class="chart-card"[^>]*data-active=")[^"]*/, `$1${button.dataset.active}`)
            .replace(/(<button class="chart-card"[^>]*aria-pressed=")[^"]*/, `$1${button.getAttribute('aria-pressed')}`);
        },
        querySelector: selector => selector === 'img' ? image : selector === '.chart-actions' ? actions : button,
        getBoundingClientRect: () => ({ top: children.indexOf(row) * 76 - scrollTop, bottom: children.indexOf(row) * 76 + 76 - scrollTop }),
        get nextSibling() { return children[children.indexOf(row) + 1] || null; },
        remove() { const index = children.indexOf(row); if (index !== -1) children.splice(index, 1); },
      };
      return row as LibraryRow & HTMLElement;
    },
  };
  let count = '';
  const libraryCount = { get textContent() { return count; }, set textContent(value: unknown) { count = String(value); } };
  const nowButton = attributes();
  list.ownerDocument = document as unknown as Document;
  return { document: document as typeof document & Document, chartList: list as typeof list & HTMLElement, libraryCount: libraryCount as typeof libraryCount & HTMLElement, nowButton: nowButton as typeof nowButton & HTMLElement, children, get created() { return created; }, set scrollTop(value: number) { scrollTop = value; } };
}
