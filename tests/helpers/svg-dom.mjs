import assert from 'node:assert/strict';

export const SVG_NS = 'http://www.w3.org/2000/svg';
const decodeText = value => value.replace(/&(?:amp|lt|gt|quot|apos|#39);/g,
  entity => ({ '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'", '&#39;': "'" }[entity]));
const encodeText = value => String(value).replace(/[&<>"]/g,
  character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[character]));

// Small DOM for the real SVG renderer. It preserves text, child order, parents
// and node identity; it does not implement a second SVG drawing algorithm.
export class SvgText {
  constructor(value, ownerDocument) { this.nodeType = 3; this.value = value; this.ownerDocument = ownerDocument; this.parentNode = null; }
  get nodeValue() { return this.value; }
  set nodeValue(value) { this.value = String(value); }
  get textContent() { return this.value; }
  set textContent(value) { this.value = String(value); }
  remove() { this.parentNode?.removeChild(this); }
}

export class SvgElement {
  constructor(tagName, ownerDocument) {
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
  set id(value) { this.setAttribute('id', value); }
  get children() { return this.childNodes.filter(node => node.nodeType === 1); }
  get parentElement() { return this.parentNode?.nodeType === 1 ? this.parentNode : null; }
  get firstChild() { return this.childNodes[0] || null; }
  get firstElementChild() { return this.children[0] || null; }
  get lastElementChild() { return this.children.at(-1) || null; }
  get nextElementSibling() {
    if (!this.parentNode) return null;
    const siblings = this.parentNode.children;
    return siblings[siblings.indexOf(this) + 1] || null;
  }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return this.attributes[name] ?? null; }
  hasAttribute(name) { return Object.hasOwn(this.attributes, name); }
  removeAttribute(name) { delete this.attributes[name]; }
  getAttributeNames() { return Object.keys(this.attributes); }
  appendChild(node) { return this.insertBefore(node, null); }
  append(...nodes) {
    for (const node of nodes) this.appendChild(typeof node === 'string' ? this.ownerDocument.createTextNode(node) : node);
  }
  insertBefore(node, reference) {
    if (node === reference) return node;
    assert.ok(reference === null || reference.parentNode === this, 'insertBefore reference must belong to its parent');
    node.remove();
    const index = reference === null ? this.childNodes.length : this.childNodes.indexOf(reference);
    this.childNodes.splice(index, 0, node); node.parentNode = this;
    return node;
  }
  removeChild(node) {
    const index = this.childNodes.indexOf(node);
    assert.notEqual(index, -1, 'removeChild requires an attached child');
    this.childNodes.splice(index, 1); node.parentNode = null;
    return node;
  }
  remove() { this.parentNode?.removeChild(this); }
  replaceChildren(...nodes) {
    for (const child of [...this.childNodes]) this.removeChild(child);
    this.append(...nodes);
  }
  contains(node) { return this === node || this.children.some(child => child.contains(node)); }
  matches(selector) {
    if (selector.includes(',')) return selector.split(',').some(part => this.matches(part.trim()));
    const requiredTag = /^[a-zA-Z][\w-]*/.exec(selector)?.[0];
    if (requiredTag && this.localName !== requiredTag) return false;
    for (const [, name] of selector.matchAll(/\.([\w-]+)/g)) if (!this.classList.contains(name)) return false;
    for (const [, name, , value] of selector.matchAll(/\[([\w-]+)(?:=(['"]?)(.*?)\2)?\]/g)) {
      if (!this.hasAttribute(name) || value !== undefined && this.getAttribute(name) !== value) return false;
    }
    return true;
  }
  querySelectorAll(selector) {
    const matches = node => selector.split(',').some(alternative => {
      const parts = alternative.trim().split(/\s+/);
      if (parts.length === 1) return node.matches(alternative.trim());
      if (!node.matches(parts.pop())) return false;
      let ancestor = node.parentNode;
      while (parts.length) {
        const relation = parts.pop();
        if (relation === '>') {
          const parentSelector = parts.pop();
          if (!ancestor?.matches(parentSelector)) return false;
        } else {
          while (ancestor && !ancestor.matches(relation)) ancestor = ancestor.parentNode;
          if (!ancestor) return false;
        }
        ancestor = ancestor.parentNode;
      }
      return true;
    });
    return this.children.flatMap(child => [...(matches(child) ? [child] : []), ...child.querySelectorAll(selector)]);
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  get textContent() { return this.childNodes.map(child => child.textContent).join(''); }
  set textContent(value) { this.replaceChildren(this.ownerDocument.createTextNode(String(value))); }
  get innerHTML() { return this.childNodes.map(serialize).join(''); }
  set innerHTML(markup) {
    this.innerHTMLWrites++;
    this.ownerDocument.parses.push({ target: this, markup: String(markup) });
    this.replaceChildren();
    const stack = [this];
    for (const token of String(markup).matchAll(/<\/([\w:-]+)\s*>|<([\w:-]+)([^>]*)>|([^<]+)/g)) {
      if (token[1]) { assert.equal(stack.at(-1).localName, token[1]); stack.pop(); continue; }
      if (token[2]) {
        const node = this.ownerDocument.createElementNS(SVG_NS, token[2]);
        for (const [, name, , value] of token[3].matchAll(/([\w:-]+)\s*=\s*(["'])(.*?)\2/g)) node.setAttribute(name, decodeText(value));
        stack.at(-1).appendChild(node);
        if (!token[3].trimEnd().endsWith('/')) stack.push(node);
      } else if (token[4]) stack.at(-1).appendChild(this.ownerDocument.createTextNode(decodeText(token[4])));
    }
    assert.equal(stack.length, 1, 'renderer fixture must have balanced SVG tags');
  }
}

function serialize(node) {
  if (node.nodeType === 3) return encodeText(node.textContent);
  return `<${node.localName}${Object.entries(node.attributes).map(([key, value]) => ` ${key}="${encodeText(value)}"`).join('')}>${node.innerHTML}</${node.localName}>`;
}
export function svgDocument() {
  return { parses: [],
    createElementNS(namespace, tag) { assert.equal(namespace, SVG_NS); return new SvgElement(tag, this); },
    createTextNode(value) { return new SvgText(String(value), this); },
  };
}
export function significantDOM(node) {
  if (node.nodeType === 3) return node.textContent.trim() || null;
  return [node.localName, { ...node.attributes }, node.childNodes.map(significantDOM).filter(value => value !== null)];
}
