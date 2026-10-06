// Small event/tree surface for date controls; browser QA owns actual geometry.
function eventTarget() {
  const listeners = new Map();
  return {
    addEventListener(type, listener) { const list = listeners.get(type) || new Set(); list.add(listener); listeners.set(type, list); },
    removeEventListener(type, listener) { listeners.get(type)?.delete(listener); },
    dispatch(type, event = {}) {
      event.target ||= this; event.preventDefault ||= () => {}; event.stopPropagation ||= () => {};
      let result; for (const listener of [...(listeners.get(type) || [])]) result = listener(event); return result;
    },
    listenerCount(type) { return listeners.get(type)?.size || 0; },
  };
}
export function dateDom() {
  const document = { ...eventTarget(), activeElement: null };
  document.defaultView = { ...eventTarget(), innerWidth: 320, innerHeight: 800 };
  document.createElement = tag => {
    const attributes = new Map();
    return { ...eventTarget(), tagName: tag, ownerDocument: document, children: [], parentElement: null,
      hidden: false, disabled: false, dataset: {}, value: '', textContent: '', dateTime: '', title: '', id: '', className: '',
      style: { setProperty(name, value) { this[name] = value; } }, selectionStart: 0, selectionEnd: 0,
      setAttribute(name, value) { attributes.set(name, String(value)); },
      getAttribute(name) { return attributes.get(name) ?? null; },
      setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end; },
      select() { this.setSelectionRange(0, this.value.length); },
      focus() { document.activeElement = this; this.dispatch('focus'); document.dispatch('focusin', { target: this }); },
      append(...nodes) { for (const node of nodes) this.insertBefore(node, null); },
      insertBefore(node, reference) {
        if (node === reference) return node;
        node.remove();
        const index = reference === null ? this.children.length : this.children.indexOf(reference);
        this.children.splice(index, 0, node); node.parentElement = this; return node;
      },
      remove() {
        if (!this.parentElement) return;
        const siblings = this.parentElement.children;
        siblings.splice(siblings.indexOf(this), 1); this.parentElement = null;
      },
      replaceChildren(...nodes) { for (const node of this.children) node.parentElement = null; this.children = []; this.append(...nodes); },
      contains(target) { return this === target || this.children.some(child => child.contains(target)); },
      all(predicate) { return this.children.flatMap(child => [...(predicate(child) ? [child] : []), ...child.all(predicate)]); },
      querySelectorAll() { return []; },
      getBoundingClientRect() { return this.className === 'date-picker'
        ? { left: 0, top: 0, width: 286, height: 280, bottom: 280 }
        : { left: 260, top: 710, right: 284, bottom: 738, width: 24, height: 28 }; },
    };
  };
  document.body = document.createElement('body');
  return document;
}
