import assert from 'node:assert/strict';
type SvgNode = SvgText | SvgElement;
type SvgPort = SvgElement & SVGElement;
interface SvgDocument {
  parses: { target: SvgElement; markup: string }[];
  createElementNS(namespace: string, tag: string): SvgPort;
  createTextNode(value: unknown): SvgText;
}
interface ClassList {
  contains(name: string): boolean;
  add(...names: string[]): void;
  remove(...names: string[]): void;
  toggle?: (name: string, force?: boolean) => boolean;
}


export const SVG_NS = 'http://www.w3.org/2000/svg';
const decodeText = (value: string) => value.replace(/&(?:amp|lt|gt|quot|apos|#39);/g,
  entity => ({ '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'", '&#39;': "'" } as Record<string, string>)[entity]!);
const encodeText = (value: unknown) => String(value).replace(/[&<>"]/g,
  character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' } as Record<string, string>)[character]!);

// Small DOM for the real SVG renderer. It preserves text, child order, parents
// and node identity; it does not implement a second SVG drawing algorithm.
export class SvgText {
  declare nodeType: 3;
  declare value: string;
  declare ownerDocument: SvgDocument;
  declare parentNode: SvgElement | null;
  constructor(value: string, ownerDocument: SvgDocument) { this.nodeType = 3; this.value = value; this.ownerDocument = ownerDocument; this.parentNode = null; }
  get nodeValue(): string { return this.value; }
  set nodeValue(value: unknown) { this.value = String(value); }
  get textContent(): string { return this.value; }
  set textContent(value: unknown) { this.value = String(value); }
  remove() { this.parentNode?.removeChild(this); }
}

export class SvgElement {
  declare tagName: string;
  declare localName: string;
  declare nodeName: string;
  declare nodeType: 1;
  declare namespaceURI: string;
  declare ownerDocument: SvgDocument;
  declare parentNode: SvgElement | null;
  declare childNodes: SvgNode[];
  declare attributes: Record<string, string>;
  declare innerHTMLWrites: number;
  declare classList: ClassList;
  declare dataset: Record<string, string | undefined>;
  declare getBBox: () => DOMRect;
  declare getCTM: () => DOMMatrix | null;
  declare snapshot: () => unknown;
  constructor(tagName: string, ownerDocument: SvgDocument) {
    this.tagName = tagName; this.localName = tagName; this.nodeName = tagName;
    this.nodeType = 1; this.namespaceURI = SVG_NS; this.ownerDocument = ownerDocument;
    this.parentNode = null; this.childNodes = []; this.attributes = {}; this.innerHTMLWrites = 0;
    this.classList = {
      contains: name => (this.getAttribute('class') || '').split(/\s+/).includes(name),
      add: (...names) => this.setAttribute('class', [...new Set([...(this.getAttribute('class') || '').split(/\s+/).filter(Boolean), ...names])].join(' ')),
      remove: (...names) => this.setAttribute('class', (this.getAttribute('class') || '').split(/\s+/).filter(name => name && !names.includes(name)).join(' ')),
    };
    this.classList.toggle = (name, force) => {
      const enabled = force ?? !this.classList.contains(name);
      this.classList[enabled ? 'add' : 'remove'](name);
      return enabled;
    };
    this.dataset = new Proxy({}, {
      get: (_, key) => this.getAttribute(`data-${String(key).replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`)}`) ?? undefined,
      set: (_, key, value) => { this.setAttribute(`data-${String(key).replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`)}`, value); return true; },
    });
  }
  get id() { return this.getAttribute('id') || ''; }
  set id(value: string) { this.setAttribute('id', value); }
  get children(): SvgPort[] { return this.childNodes.filter((node): node is SvgElement => node.nodeType === 1) as SvgPort[]; }
  get parentElement(): SvgPort | null { return this.parentNode?.nodeType === 1 ? this.parentNode as SvgPort : null; }
  get firstChild() { return this.childNodes[0] || null; }
  get firstElementChild() { return this.children[0] || null; }
  get lastElementChild(): SvgPort | null { return this.children.at(-1) || null; }
  get nextElementSibling(): SvgPort | null {
    if (!this.parentNode) return null;
    const siblings = this.parentNode.children;
    return siblings[siblings.indexOf(this as unknown as SvgPort) + 1] || null;
  }
  setAttribute(name: string, value: unknown) { this.attributes[name] = String(value); }
  getAttribute(name: string): string | null { return this.attributes[name] ?? null; }
  hasAttribute(name: string) { return Object.hasOwn(this.attributes, name); }
  removeAttribute(name: string) { delete this.attributes[name]; }
  getAttributeNames() { return Object.keys(this.attributes); }
  appendChild<T extends SvgNode>(node: T): T { return this.insertBefore(node, null); }
  append(...nodes: (SvgNode | string)[]) {
    for (const node of nodes) this.appendChild(typeof node === 'string' ? this.ownerDocument.createTextNode(node) : node);
  }
  insertBefore<T extends SvgNode>(node: T, reference: SvgNode | null): T {
    if (node === reference) return node;
    assert.ok(reference === null || reference.parentNode === this, 'insertBefore reference must belong to its parent');
    node.remove();
    const index = reference === null ? this.childNodes.length : this.childNodes.indexOf(reference);
    this.childNodes.splice(index, 0, node); node.parentNode = this;
    return node;
  }
  removeChild<T extends SvgNode>(node: T): T {
    const index = this.childNodes.indexOf(node);
    assert.notEqual(index, -1, 'removeChild requires an attached child');
    this.childNodes.splice(index, 1); node.parentNode = null;
    return node;
  }
  remove() { this.parentNode?.removeChild(this); }
  replaceChildren(...nodes: (SvgNode | string)[]) {
    for (const child of [...this.childNodes] as const) this.removeChild(child);
    this.append(...nodes);
  }
  contains(node: unknown): boolean { return this === node || this.children.some(child => child.contains(node)); }
  matches(selector: string): boolean {
    if (selector.includes(',')) return selector.split(',').some(part => this.matches(part.trim()));
    const requiredTag = /^[a-zA-Z][\w-]*/.exec(selector)?.[0];
    if (requiredTag && this.localName !== requiredTag) return false;
    for (const [, name] of selector.matchAll(/\.([\w-]+)/g)) if (!this.classList.contains(name)) return false;
    for (const [, name, , value] of selector.matchAll(/\[([\w-]+)(?:=(['"]?)(.*?)\2)?\]/g)) {
      if (!this.hasAttribute(name) || value !== undefined && this.getAttribute(name) !== value) return false;
    }
    return true;
  }
  querySelectorAll(selector: string): SvgPort[] {
    const matches = (node: SvgElement) => selector.split(',').some(alternative => {
      const parts = alternative.trim().split(/\s+/);
      if (parts.length === 1) return node.matches(alternative.trim());
      if (!node.matches(parts.pop()!)) return false;
      let ancestor = node.parentNode;
      while (parts.length) {
        const relation = parts.pop();
        if (relation === '>') {
          const parentSelector = parts.pop();
          if (!ancestor?.matches(parentSelector!)) return false;
        } else {
          while (ancestor && !ancestor.matches(relation!)) ancestor = ancestor!.parentNode;
          if (!ancestor) return false;
        }
        ancestor = ancestor!.parentNode;
      }
      return true;
    });
    return this.children.flatMap(child => [...(matches(child) ? [child] : []), ...child.querySelectorAll(selector)]);
  }
  querySelector(selector: string): SvgPort | null { return this.querySelectorAll(selector)[0] || null; }
  get textContent(): string { return this.childNodes.map(child => child.textContent).join(''); }
  set textContent(value: unknown) { this.replaceChildren(this.ownerDocument.createTextNode(String(value))); }
  get innerHTML(): string { return this.childNodes.map(serialize).join(''); }
  set innerHTML(markup: string) {
    this.innerHTMLWrites++;
    this.ownerDocument.parses.push({ target: this, markup: String(markup) });
    this.replaceChildren();
    const stack: SvgElement[] = [this];
    for (const token of String(markup).matchAll(/<\/([\w:-]+)\s*>|<([\w:-]+)([^>]*)>|([^<]+)/g)) {
      if (token[1]) { assert.equal(stack.at(-1)!.localName, token[1]); stack.pop(); continue; }
      if (token[2]) {
        const node = this.ownerDocument.createElementNS(SVG_NS, token[2]);
        for (const [, name, , value] of token[3].matchAll(/([\w:-]+)\s*=\s*(["'])(.*?)\2/g)) node.setAttribute(name, decodeText(value));
        stack.at(-1)!.appendChild(node);
        if (!token[3].trimEnd().endsWith('/')) stack.push(node);
      } else if (token[4]) stack.at(-1)!.appendChild(this.ownerDocument.createTextNode(decodeText(token[4])));
    }
    assert.equal(stack.length, 1, 'renderer fixture must have balanced SVG tags');
  }
}

function serialize(node: SvgNode): string {
  if (node.nodeType === 3) return encodeText(node.textContent);
  return `<${node.localName}${Object.entries(node.attributes).map(([key, value]) => ` ${key}="${encodeText(value)}"`).join('')}>${node.innerHTML}</${node.localName}>`;
}
export function svgDocument(): SvgDocument {
  return { parses: [],
    createElementNS(namespace, tag) { assert.equal(namespace, SVG_NS); return new SvgElement(tag, this) as SvgPort; },
    createTextNode(value) { return new SvgText(String(value), this); },
  };
}
type DomSnapshot = string | [string, Record<string, string>, (DomSnapshot | null)[]] | null;
export function significantDOM(node: SvgNode | null): DomSnapshot {
  assert.ok(node);
  if (node!.nodeType === 3) return node!.textContent.trim() || null;
  return [node!.localName, { ...node!.attributes }, node!.childNodes.map(significantDOM).filter(value => value !== null)];
}
