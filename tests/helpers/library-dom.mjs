// A small DOM surface for the library's behavioural tests. Layout and observer
// delivery are controlled explicitly; no storage or application globals exist.
export function libraryDom() {
  let created = 0, scrollTop = 0;
  const attributes = () => {
    const values = new Map();
    return { setAttribute: (name, value) => values.set(name, String(value)), getAttribute: name => values.get(name) ?? null };
  };
  const children = [];
  const list = {
    addEventListener() {}, get firstChild() { return children[0] || null; },
    getBoundingClientRect: () => ({ top: 0, bottom: 200 }),
    insertBefore(row, sibling) {
      const old = children.indexOf(row); if (old !== -1) children.splice(old, 1);
      const index = children.indexOf(sibling); children.splice(index < 0 ? children.length : index, 0, row);
    },
    get innerHTML() { return children.map(row => `<div class="${row.className}" data-active="${row.dataset.active}">${row.innerHTML}</div>`).join(''); },
  };
  const document = {
    createElement(tag) {
      created++;
      let markup = '';
      const button = { dataset: {}, ...attributes() }, image = { src: '' };
      const row = {
        dataset: {}, className: '',
        set innerHTML(value) { markup = value; image.src = ''; },
        get innerHTML() {
          return markup.replace(/(<button class="chart-card"[^>]*data-active=")[^"]*/, `$1${button.dataset.active}`)
            .replace(/(<button class="chart-card"[^>]*aria-pressed=")[^"]*/, `$1${button.getAttribute('aria-pressed')}`);
        },
        querySelector: selector => selector === 'img' ? image : button,
        getBoundingClientRect: () => ({ top: children.indexOf(row) * 76 - scrollTop, bottom: children.indexOf(row) * 76 + 76 - scrollTop }),
        get nextSibling() { return children[children.indexOf(row) + 1] || null; },
        remove() { const index = children.indexOf(row); if (index !== -1) children.splice(index, 1); },
      };
      return row;
    },
  };
  let count = '';
  const libraryCount = { get textContent() { return count; }, set textContent(value) { count = String(value); } };
  const nowButton = attributes();
  list.ownerDocument = document;
  return { document, chartList: list, libraryCount, nowButton, children, get created() { return created; }, set scrollTop(value) { scrollTop = value; } };
}
