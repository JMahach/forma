export type AttributeValue = string | number | boolean | null | undefined;
// Small SVG mutations shared by the scene painters. No tree diff or render loop.
export function setAttribute(node: Element | null | undefined, name: string, value: AttributeValue) {
  if (!node) return;
  if (value === null || value === undefined) { if (node.hasAttribute(name)) node.removeAttribute(name); return; }
  const text = String(value);
  if (node.getAttribute(name) !== text) node.setAttribute(name, text);
}
export function setAttributes(node: Element | null | undefined, values: Record<string, AttributeValue>) {
  for (const [name, value] of Object.entries(values)) setAttribute(node, name, value);
}
export function svgNodes(parent: Element, markup: string) {
  if (!markup) return [];
  const holder = parent.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'g');
  holder.innerHTML = markup;
  return [...holder.childNodes];
}
// A variable, non-interactive fragment between persistent targets. Parsing is
// restricted to a changed fragment: a channel's lanes, or one integration mask.
export function fragmentSlot(parent: Element, before: Node | null, nodes: ChildNode[] = [], initialMarkup?: string) {
  let previous = initialMarkup ?? (nodes.length ? undefined : '');
  return (markup: string) => {
    if (markup === previous) return false;
    previous = markup;
    for (const node of nodes) node.remove();
    nodes = svgNodes(parent, markup);
    for (const node of nodes) parent.insertBefore(node, before);
    return true;
  };
}
