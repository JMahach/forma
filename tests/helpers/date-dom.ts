interface FixtureEvent extends Record<string, unknown> {
  target?: EventSurface; relatedTarget?: DateNode | null;
  preventDefault?: () => void; stopPropagation?: () => void;
}
type Listener = (event: FixtureEvent) => unknown;
interface EventSurface {
  addEventListener(type: string, listener: Listener): void;
  removeEventListener(type: string, listener: Listener): void;
  dispatch(type: string, event?: FixtureEvent): unknown;
  listenerCount(type: string): number;
}
export interface DateDocument extends EventSurface {
  activeElement: DateNode | null;
  defaultView: EventSurface & { innerWidth: number; innerHeight: number; getComputedStyle?: (input: Element) => CSSStyleDeclaration; visualViewport?: EventTarget & Partial<VisualViewport> };
  body: DateNode;
  createElement(tag: string): DateNode & HTMLInputElement;
}
export interface DateNode extends EventSurface {
  tagName: string; ownerDocument: DateDocument; children: DateNode[]; parentElement: DateNode | null;
  hidden: boolean; disabled: boolean; dataset: Record<string, string>;
  value: string; textContent: string; dateTime: string; title: string; id: string; className: string;
  style: { setProperty(name: string, value: string): void; [name: string]: unknown };
  selectionStart: number; selectionEnd: number;
  setAttribute(name: string, value: unknown): void; getAttribute(name: string): string | null;
  setSelectionRange(start: number, end: number): void; select(): void; focus(): void;
  append(...nodes: DateNode[]): void; insertBefore(node: DateNode, reference: DateNode | null): DateNode;
  remove(): void; replaceChildren(...nodes: DateNode[]): void; contains(target: unknown): boolean;
  all(predicate: (node: DateNode) => boolean): DateNode[];
  min?: string; max?: string; step?: string; placeholder?: string; offsetWidth?: number; clientLeft?: number; scrollLeft?: number;
  querySelectorAll(selector?: string): DateNode[]; getBoundingClientRect(): Partial<DOMRect>;
}

// Small event/tree surface for date controls; browser QA owns actual geometry.
function eventTarget(): EventSurface {
  const listeners = new Map<string, Set<Listener>>();
  return {
    addEventListener(type, listener) { const list = listeners.get(type) || new Set(); list.add(listener); listeners.set(type, list); },
    removeEventListener(type, listener) { listeners.get(type)?.delete(listener); },
    dispatch(type, event = {}) {
      event.target ||= this; event.preventDefault ||= () => {}; event.stopPropagation ||= () => {};
      let result; for (const listener of [...(listeners.get(type) || [])] as const) result = listener(event); return result;
    },
    listenerCount(type) { return listeners.get(type)?.size || 0; },
  };
}
export function dateDom() {
  const document = { ...eventTarget(), activeElement: null } as DateDocument;
  document.defaultView = { ...eventTarget(), innerWidth: 320, innerHeight: 800 };
  document.createElement = tag => {
    const attributes = new Map<string, string>();
    const node: DateNode = { ...eventTarget(), tagName: tag, ownerDocument: document, children: [], parentElement: null,
      hidden: false, disabled: false, dataset: {}, value: '', textContent: '', dateTime: '', title: '', id: '', className: '',
      style: { setProperty(name: string, value: string) { this[name] = value; } }, selectionStart: 0, selectionEnd: 0,
      setAttribute(name, value) { attributes.set(name, String(value)); },
      getAttribute(name) { return attributes.get(name) ?? null; },
      setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end; },
      select() { this.setSelectionRange(0, this.value.length); },
      focus() {
        if (document.activeElement === this) return;
        const previous = document.activeElement;
        document.activeElement = document.body;
        previous?.dispatch('blur', { relatedTarget: this });
        document.activeElement = this;
        this.dispatch('focus', { relatedTarget: previous }); document.dispatch('focusin', { target: this });
      },
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
      getBoundingClientRect() { return this.className.split(' ').includes('date-picker')
        ? { left: 0, top: 0, width: 286, height: 280, bottom: 280 }
        : { left: 260, top: 710, right: 284, bottom: 738, width: 24, height: 28 }; },
    };
    return node as DateNode & HTMLInputElement;
  };
  document.body = document.createElement('body');
  return document as Omit<Document, keyof DateDocument> & DateDocument;
}
