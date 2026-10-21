export const escapeHtml = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]!));

// Reassigning textContent replaces child text nodes even when the text matches.
export function setText(element: Node, value: string) {
  if (element.textContent !== value) element.textContent = value;
}
