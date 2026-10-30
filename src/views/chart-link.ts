import { createActionNotice, type ActionNoticeHandle } from '../ui/feedback.ts';
import { UI_MESSAGES } from '../ui/messages.ts';
import {createResourceScope} from '../runtime/resource-scope.ts';

/** Copy an already confirmed public address. No saving, network request or fallback publication. */
export function attachChartLink({button, root, boundary, notice = createActionNotice(root),
  writeText = (value: string) => globalThis.navigator.clipboard.writeText(value)}: {
  button: HTMLButtonElement; root: HTMLElement; boundary: HTMLElement;
  notice?: ReturnType<typeof createActionNotice>; writeText?: (value: string) => Promise<void>;
}) {
  const scope=createResourceScope();
  let url: string | null = null, operation = 0, message: ActionNoticeHandle | undefined;
  function invalidate() { operation++; message?.close(); message = undefined; }
  scope.own(()=>{invalidate();url=null;});
  function update(next: string | null) {
    if(scope.stopped)return;
    button.hidden = !next; button.disabled = !next;
    if (url === next) return;
    url = next; invalidate();
  }
  update(null);
  button.addEventListener('click', async () => {
    if (!url || button.disabled) return;
    const target = url, current = ++operation, surfaceRevision = notice.revision;
    let copied = false;
    try { await writeText(target); copied = true; } catch { /* The same accepted failure covers denied or unavailable clipboard access. */ }
    if (current !== operation || target !== url || notice.revision !== surfaceRevision) return;
    message = notice.show(button, {
      message: copied ? UI_MESSAGES.linkCopied : UI_MESSAGES.linkCopyFailed,
      tone: copied ? 'success' : 'error',
    }, {boundary, durationMs: 2000, compact: true, placement: 'above'});
  }, {signal:scope.signal});
  // Starting another action retires an unfinished clipboard result, even before
  // that action has produced a message of its own.
  root.addEventListener('pointerdown', event => { if (!button.contains(event.target as Node)) invalidate(); }, {capture: true,signal:scope.signal});
  root.addEventListener('keydown', event => {
    if (event.key === 'Escape' || (event.key === 'Enter' || event.key === ' ') && !button.contains(event.target as Node)) invalidate();
  }, {capture: true,signal:scope.signal});
  return {update,dispose:scope.stop};
}
