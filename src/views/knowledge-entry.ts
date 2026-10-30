import type { SavedView } from '../data/view-store.ts';
import type { Knowledge } from './knowledge.ts';
import type { SelectionIdentity } from '../selection/selection-targets.ts';
import {createResourceScope} from '../runtime/resource-scope.ts';
interface KnowledgeEntryOptions {
  initialView?: SavedView['knowledge']; onChange?: () => void;
  button: HTMLButtonElement; dialog: HTMLElement; onSelect: (selection: SelectionIdentity) => void;
  getSelection: () => SelectionIdentity | null; onOpen?: () => void; isCurrent?: () => boolean;
  onError?: (message: string) => void; load?: () => Promise<typeof import('./knowledge.ts')>;
}
export type KnowledgeEntry = ReturnType<typeof attachKnowledgeEntry>;

// Navigation owns the active screen. One pending import can be reused, but
// only the latest request for the library may reveal its page.
export function attachKnowledgeEntry({ button, dialog, onSelect, getSelection, onOpen,
  isCurrent = () => true, onError = () => {}, initialView, onChange, load = () => import('./knowledge.ts') }: KnowledgeEntryOptions) {
  const scope=createResourceScope();
  const initialSelection = getSelection();
  let view: Knowledge | null = null, pending: Promise<Knowledge | null> | null = null, revision = 0, requested: number | null = null;
  scope.own(()=>{
    requested=null;pending=null;button.removeAttribute('aria-busy');dialog.hidden=true;
    const loaded=view;view=null;return loaded?.dispose();
  });
  async function show() {
    if (scope.stopped || !isCurrent()) return false;
    const request = ++revision;
    requested = request;
    if (view) { requested = null; view.show(getSelection()); return true; }
    button.setAttribute('aria-busy', 'true');
    pending ??= Promise.resolve().then(()=>scope.stopped?null:load()).then(module => {
      if(scope.stopped || !module)return null;
      view = module.attachKnowledge(dialog, onSelect, { initialView, initialSelection, onChange });
      return view;
    }).catch(() => {
      if (requested !== null && isCurrent()) onError('Не удалось открыть справочник. Попробуйте ещё раз.');
      return null;
    }).finally(() => { pending = null; if(!scope.stopped)button.removeAttribute('aria-busy'); });
    const loaded = await pending;
    if (requested !== request) return false;
    requested = null;
    if (!loaded || !isCurrent()) return false;
    loaded.show(getSelection());
    return true;
  }
  function hide() {
    if(scope.stopped)return;
    requested = null;
    button.removeAttribute('aria-busy');
    if (view) view.hide();
    else dialog.hidden = true;
  }
  button.addEventListener('click', () => onOpen ? onOpen() : show(), {signal:scope.signal});
  return { dispose:scope.stop, show, hide, restoreInputFocus: () => view?.restoreInputFocus() ?? false, get snapshot() { return scope.stopped?undefined:view?.snapshot ?? initialView; } };
}
