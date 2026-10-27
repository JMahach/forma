import { normalizeTextSelection, type TextSelection } from '../domain/input-draft.ts';

export function captureTextSelection(input: HTMLInputElement | null | undefined): TextSelection | null {
  if (!input || input.ownerDocument.activeElement !== input) return null;
  return normalizeTextSelection({start:input.selectionStart,end:input.selectionEnd,direction:input.selectionDirection},input.value);
}
export function restoreTextSelection(input: HTMLInputElement | null | undefined, value: unknown): boolean {
  if (!input || input.disabled) return false;
  const selection=normalizeTextSelection(value,input.value);
  if (!selection) return false;
  input.focus({preventScroll:true});
  input.setSelectionRange(selection.start,selection.end,selection.direction);
  return input.ownerDocument.activeElement === input;
}
// Caret movement need not emit input; subscribe only to the owner's fields.
export function watchTextSelection(inputs: readonly HTMLInputElement[], onChange: () => void) {
  const names=['input','focus','blur','select','keyup','pointerup'];
  for (const input of inputs) for (const name of names) input.addEventListener(name,onChange);
  const document=inputs[0]?.ownerDocument;
  const selectionChanged=() => { if (inputs.some(input=>document?.activeElement === input)) onChange(); };
  document?.addEventListener?.('selectionchange',selectionChanged);
  return () => {
    for (const input of inputs) for (const name of names) input.removeEventListener(name,onChange);
    document?.removeEventListener?.('selectionchange',selectionChanged);
  };
}
