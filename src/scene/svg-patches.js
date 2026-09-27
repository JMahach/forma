// Small SVG mutations shared by the scene painters. No tree diff or render loop.
export function setAttribute(node, name, value) {
  if (!node) return;
  if (value === null || value === undefined) { if (node.hasAttribute(name)) node.removeAttribute(name); return; }
  const text = String(value);
  if (node.getAttribute(name) !== text) node.setAttribute(name, text);
}
export function setAttributes(node, values) {
  for (const [name, value] of Object.entries(values)) setAttribute(node, name, value);
}
export function svgNodes(parent, markup) {
  const holder = parent.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'g');
  holder.innerHTML = markup;
  return [...holder.childNodes];
}
// A variable, non-interactive fragment between persistent targets. Parsing is
// restricted to a changed fragment: a channel's lanes, or one integration mask.
export function fragmentSlot(parent, before, nodes = []) {
  let previous;
  return markup => {
    if (markup === previous) return false;
    previous = markup;
    for (const node of nodes) node.remove();
    nodes = svgNodes(parent, markup);
    for (const node of nodes) parent.insertBefore(node, before);
    return true;
  };
}
