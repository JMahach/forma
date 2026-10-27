export type FeedbackKind = 'field' | 'tool' | 'action' | 'page';
export interface FeedbackMessage {
  message: string; detail?: string; tone?: 'neutral' | 'error' | 'success'; busy?: boolean;
  actions?: Array<{ label: string; run: () => void; disabled?: boolean }>;
}
let nextId = 0;
/** Presentation only. The caller owns requests, validation, retry and cancellation. */
export function createFeedback(container: HTMLElement, { kind, field }: { kind: FeedbackKind; field?: HTMLElement }) {
  let revision = 0, disposed = false;
  container.id ||= `feedback-${++nextId}`;
  container.className += ` ui-feedback ui-feedback--${kind}`;
  container.setAttribute('aria-live', 'polite'); container.setAttribute('aria-atomic', 'true');
  function describe(active: boolean) {
    if (!field) return;
    const ids = new Set((field.getAttribute('aria-describedby') || '').split(/\s+/).filter(Boolean));
    ids.delete(container.id); if (active) ids.add(container.id);
    if (ids.size) field.setAttribute('aria-describedby', [...ids].join(' ')); else field.removeAttribute('aria-describedby');
    if (active) field.setAttribute('aria-invalid', 'true'); else field.removeAttribute('aria-invalid');
  }
  function clear() {
    revision++; container.replaceChildren(); container.hidden = true;
    container.setAttribute('aria-busy', 'false'); describe(false);
  }
  clear();
  return {
    show({ message, detail, tone = 'neutral', busy = false, actions = [] }: FeedbackMessage) {
      if (disposed) return;
      const current = ++revision, document = container.ownerDocument;
      const text = document.createElement('p'); text.textContent = message; text.className = 'ui-feedback-text';
      container.replaceChildren(text);
      if (detail) { const more = document.createElement('p'); more.className = 'ui-feedback-detail'; more.textContent = detail; container.append(more); }
      if (actions.length) {
        const group = document.createElement('div'); group.className = 'ui-feedback-actions';
        for (const action of actions) {
          const button = document.createElement('button'); button.type = 'button'; button.className = 'secondary-button';
          button.textContent = action.label; button.disabled = Boolean(action.disabled);
          button.addEventListener('click', () => { if (!disposed && revision === current && !button.disabled) action.run(); });
          group.append(button);
        }
        container.append(group);
      }
      container.dataset.tone = tone; container.hidden = false;
      container.setAttribute('aria-busy', String(busy)); describe(tone === 'error');
    },
    clear,
    destroy() { clear(); disposed = true; },
  };
}

export interface ActionNoticeOptions {
  boundary?: HTMLElement; durationMs?: number; compact?: boolean; placement?: 'above';
  onDismiss?: () => void; onExpire?: () => void;
  returnFocus?: () => HTMLElement | null;
}
export interface ActionNoticeHandle {
  readonly active: boolean;
  update(message: FeedbackMessage): void;
  close(restoreFocus?: boolean): void;
}
interface ActionNoticeEntry { anchor: HTMLElement; options: ActionNoticeOptions; token: number }
interface ActionNotice {
  readonly revision: number;
  show(anchor: HTMLElement, message: FeedbackMessage, options?: ActionNoticeOptions): ActionNoticeHandle;
  close(): void;
  contains(target: Node | null): boolean;
}
const actionNotices = new WeakMap<HTMLElement, ActionNotice>();
/** One anchored action surface per shell. Replacing its content never cancels an action. */
export function createActionNotice(root: HTMLElement): ActionNotice {
  const existing = actionNotices.get(root);
  if (existing) return existing;
  const document = root.ownerDocument, view = document.defaultView!;
  const container = document.createElement('div'); container.className = 'action-notice';
  const feedback = createFeedback(container, {kind:'action'});
  root.append(container);
  let current: ActionNoticeEntry | null = null, revision = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  function describe(entry: ActionNoticeEntry, active: boolean) {
    const ids = new Set((entry.anchor.getAttribute('aria-describedby') || '').split(/\s+/).filter(Boolean));
    ids.delete(container.id); if (active) ids.add(container.id);
    if (ids.size) entry.anchor.setAttribute('aria-describedby',[...ids].join(' '));
    else entry.anchor.removeAttribute('aria-describedby');
  }
  function close() {
    if (timer !== undefined) clearTimeout(timer); timer = undefined;
    if (current) describe(current,false);
    current = null; revision++; feedback.clear();
  }
  function restore(entry: ActionNoticeEntry) {
    const target = entry.options.returnFocus?.() || entry.anchor;
    if (root.contains(target) && !target.hidden) target.focus({preventScroll:true});
  }
  function place() {
    if (!current) return;
    const anchor = current.anchor.getBoundingClientRect();
    if (!root.contains(current.anchor) || !anchor.width || !anchor.height) { close(); return; }
    const viewport = view.visualViewport;
    const left = viewport?.offsetLeft ?? 0, top = viewport?.offsetTop ?? 0;
    const right = left + (viewport?.width ?? view.innerWidth), bottom = top + (viewport?.height ?? view.innerHeight);
    let hidden = anchor.right <= left || anchor.left >= right || anchor.bottom <= top || anchor.top >= bottom;
    for (let node: HTMLElement | null = current.anchor; node; node = node.parentElement) {
      hidden ||= Boolean(node.hidden) || node.inert || node.getAttribute('aria-hidden') === 'true';
      if (node === root) break;
    }
    hidden ||= view.getComputedStyle?.(current.anchor).visibility === 'hidden';
    if (hidden) { container.hidden = true; describe(current,false); return; }
    container.hidden = false; describe(current,true);
    const boundary = current.options.boundary?.getBoundingClientRect();
    const minX = Math.max(left, boundary?.left ?? left) + 8;
    const maxX = Math.min(right, boundary?.right ?? right) - 8;
    container.style.maxWidth = `${Math.max(0,maxX-minX)}px`;
    container.style.maxHeight = `${Math.max(0,bottom-top-16)}px`;
    const size = container.getBoundingClientRect();
    const above = anchor.top - 8 - size.height;
    const side = current.options.placement === 'above' || above >= top + 8 ? 'top' : 'bottom';
    container.dataset.side = side;
    container.style.left = `${Math.max(minX,Math.min(maxX-size.width,(anchor.left+anchor.right-size.width)/2))}px`;
    container.style.top = `${Math.max(top+8,Math.min(bottom-8-size.height,side==='top'?above:anchor.bottom+8))}px`;
  }
  function paint(message: FeedbackMessage) {
    const buttons = Array.from(container.querySelectorAll<HTMLButtonElement>('button'));
    const focused = buttons.indexOf(document.activeElement as HTMLButtonElement);
    feedback.show(message); place();
    if (focused >= 0) container.querySelectorAll<HTMLButtonElement>('button')[focused]?.focus({preventScroll:true});
  }
  const owner: ActionNotice = {
    get revision() { return revision; },
    show(anchor, message, options = {}) {
      const focused = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).indexOf(document.activeElement as HTMLButtonElement);
      close();
      const entry: ActionNoticeEntry = {anchor,options,token:++revision}; current = entry;
      const active = () => current === entry && entry.token === revision;
      container.dataset.compact = String(Boolean(options.compact));
      paint(message);
      if (active()) {
        if (!container.hidden) describe(entry,true);
        if (focused >= 0) {
          const target = container.querySelectorAll<HTMLButtonElement>('button')[focused];
          if (target) target.focus({preventScroll:true}); else restore(entry);
        }
      }
      if (active() && options.durationMs) timer = setTimeout(() => {
        if (!active()) return;
        close(); options.onExpire?.();
      }, options.durationMs);
      return {
        get active() { return active(); },
        update(next) { if (active()) paint(next); },
        close(restoreFocus = false) { if (!active()) return; close(); if (restoreFocus) restore(entry); },
      };
    },
    close,
    contains(target) { return container.contains(target); },
  };
  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || !current || container.hidden) return;
    const entry = current;
    event.preventDefault(); event.stopPropagation(); event.stopImmediatePropagation?.();
    close(); entry.options.onDismiss?.(); restore(entry);
  }, {capture:true});
  view.addEventListener('resize', place);
  view.visualViewport?.addEventListener('resize', place);
  view.visualViewport?.addEventListener('scroll', place);
  root.addEventListener('scroll', place, {capture:true});
  root.addEventListener('transitionend', place);
  if (view.MutationObserver) new view.MutationObserver(records => {
    if (current && records.some(record => (record.target as Node).contains(current!.anchor))) place();
  }).observe(root,{subtree:true,attributes:true,attributeFilter:['hidden','inert','aria-hidden','class','data-page-state','data-workspace-screen','data-panels-layout']});
  actionNotices.set(root,owner);
  return owner;
}
