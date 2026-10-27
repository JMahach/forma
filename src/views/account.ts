import { captureTextSelection, restoreTextSelection, watchTextSelection } from './input-selection.ts';
import type { AccountIdentity, AccountScreen, AccountRequest, AccountReply } from '../state/account-flow.ts';
import type { AccountFlow, AccountIssue, AccountState } from '../state/account-flow.ts';
import { escapeHtml as esc } from '../ui/html.ts';
import { actionAvailability } from '../ui/action-state.ts';
import { createFeedback } from '../ui/feedback.ts';
import { UI_MESSAGES, failureMessage } from '../ui/messages.ts';

// Optional stand adapter access to the same mounted account view, independent of browser assembly.
export interface AccountPreviewAdapter {
  request: (request: AccountRequest, signal: AbortSignal) => Promise<AccountReply>;
  screen: AccountScreen; identity: AccountIdentity | null;
}
export interface AccountPreviewPort {
  preview(adapter: AccountPreviewAdapter | null): Pick<AccountFlow, 'subscribe'> | null;
  cancelPreview(): void;
}
let previewSetup: ((account: AccountPreviewPort) => void) | null = null;
let mountedPreview: AccountPreviewPort | null = null;
export function registerAccountPreview(setup: (account: AccountPreviewPort) => void) {
  previewSetup = setup;
  if (mountedPreview) setup(mountedPreview);
  return () => { if (previewSetup === setup) previewSetup = null; };
}
export function connectAccountPreview(port: AccountPreviewPort) {
  mountedPreview = port; previewSetup?.(port);
  return () => { if (mountedPreview === port) mountedPreview = null; };
}

type Feedback = ReturnType<typeof createFeedback>;
export function attachAccountView({ page, flow, offline, telegram = true, onInputChange = () => {} }: { page: HTMLElement; flow: AccountFlow; offline: () => boolean; telegram?: boolean; onInputChange?: () => void }) {
  const document = page.ownerDocument;
  const content = document.createElement('div'); content.className = 'account-study-content'; page.append(content);
  let unwatchInput = () => {};
  let feedback: Feedback[] = [], previousStep = flow.state.step, rendered = '';
    const check = '<svg width="14" height="14" viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="m4 10 4 4 8-8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    const exitIcon = '<svg width="16" height="16" viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M9 3H4v14h5m4-11 4 4-4 4m-6-4h10" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    const mailIcon = '<svg width="14" height="14" viewBox="0 0 20 20" fill="none" aria-hidden="true"><rect x="2.5" y="4" width="15" height="12" rx="1.5" stroke="currentColor" stroke-width="1.25"/><path d="m3 5 7 5 7-5" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    const telegramIcon = '<svg width="14" height="14" viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="m17 3-3 14-5-4-3 2V10L2 8l15-5ZM6 10l11-7-8 10" stroke="currentColor" stroke-width="1.15" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const action = (name: string, text: string, primary = false, disabled = false) => `<button type="button" class="account-study-action ${primary ? 'account-study-primary' : ''}" data-account-action="${name}" ${disabled ? 'disabled' : ''}>${text}</button>`;
  function message(issue: AccountIssue) {
    const keys = { email_required: 'emailRequired', email_invalid: 'emailInvalid', code_invalid: 'codeInvalid', code_expired: 'codeExpired', attempt_expired: 'attemptExpired', auth_rate_limited: 'authRateLimited', code_send_failed: 'codeSendFailed', code_delivery_failed: 'codeDeliveryFailed', code_verify_failed: 'codeVerifyFailed', telegram_conflict: 'telegramConflict' } as const;
    const key = keys[issue.code as keyof typeof keys];
    return key ? UI_MESSAGES[key] : failureMessage({ code: issue.code }, UI_MESSAGES.accountActionFailed);
  }
  function signedIn(state: Readonly<AccountState>) {
    const disabled = actionAvailability({connection:offline() ? 'offline' : 'online', requiresConnection:true, pending:Boolean(state.busy)}).disabled;
    return `${state.screen === 'expired' ? `<div class="account-study-session"><p>Войдите снова, чтобы сохранять изменения.</p>${action('login', 'Войти', false, disabled)}</div>` : ''}
      <dl class="account-study-details"><div class="account-study-mail"><dt>${mailIcon}<span>Почта</span></dt><dd class="account-study-email"><span class="account-study-mask">${esc(state.identity?.email ?? '')}</span></dd><dd class="account-study-confirmed"><span class="account-study-mask">${check} Подтверждена</span></dd></div>
      <div class="account-study-telegram"><dt>${telegramIcon}<span>Telegram</span></dt>${state.screen === 'unlinked' ? `<dd class="account-study-status is-unlinked">Не привязан</dd><dd class="account-study-link">${action('telegram','Привязать Telegram',false,disabled || !telegram)}</dd>` : `<dd class="account-study-handle"><span class="account-study-mask">${esc(state.identity?.telegramHandle ?? '')}</span></dd><dd class="account-study-confirmed"><span class="account-study-mask">${check} Привязан</span></dd>`}</div></dl>
      <div class="account-study-logout"><div class="account-study-exit-action">${action('logout',`${exitIcon}<span>Выйти</span>`)}</div><div class="account-study-exit-note"><p>Выход из всех вкладок этого браузера.<br>Несохранённые изменения будут удалены.<br>Карты в аккаунте сохранятся.</p></div></div>`;
  }
  function form(state: Readonly<AccountState>) {
    const code = state.step === 'code', busy = Boolean(state.busy), disabled = actionAvailability({connection:offline() ? 'offline' : 'online', requiresConnection:true, pending:busy}).disabled, expired = !state.verificationPending && state.issue?.code === 'attempt_expired';
    if (state.step === 'telegram') return `<form class="account-auth-form" novalidate aria-busy="${busy}">
      <h2>Вход</h2><div id="accountActionFeedback"></div>
      <div class="account-auth-actions"><button type="button" class="secondary-button" data-account-action="${busy ? 'cancel' : 'close'}">${busy ? 'Отменить' : 'Назад'}</button>
        ${expired ? '<button type="button" class="primary-button" data-account-action="back">Начать заново</button>' : `<button type="submit" class="primary-button" ${disabled || !telegram ? 'disabled' : ''}>${state.verificationPending ? 'Войти' : 'Войти через Telegram'}</button>`}
      </div>
    </form>`;
    return `<form class="account-auth-form" novalidate aria-busy="${busy}">
      <h2>${code ? 'Введите код' : 'Вход'}</h2>
      <p class="account-auth-intro">${code ? `Код отправлен на <strong>${esc(state.email)}</strong>. ${esc(UI_MESSAGES.codeEmailHint)}` : state.telegramPending ? 'Подтвердите почту, чтобы завершить вход через Telegram.' : 'Отправим одноразовый код на вашу почту.'}</p>
      <div class="field"><label for="account${code ? 'Code' : 'Email'}">${code ? 'Код из письма' : 'Почта'}</label>
        ${code ? `<input id="accountCode" class="account-auth-code" name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" value="${esc(state.code)}" ${disabled || expired ? 'disabled' : ''}>` : `<input id="accountEmail" name="email" type="text" autocomplete="email" inputmode="email" autocapitalize="none" spellcheck="false" value="${esc(state.email)}" ${disabled ? 'disabled' : ''}>`}
        <div id="accountFieldFeedback"></div>
      </div>
      <div id="accountActionFeedback"></div>
      <div class="account-auth-actions"><button type="button" class="secondary-button" data-account-action="${busy ? 'cancel' : code ? 'back' : 'close'}">${busy ? 'Отменить' : 'Назад'}</button>
        ${expired ? '<button type="button" class="primary-button" data-account-action="back">Начать заново</button>' : `<button type="submit" class="primary-button" ${disabled || !state.verificationPending && state.issue?.code === 'code_expired' || !code && state.resendSeconds > 0 ? 'disabled' : ''}>${code ? 'Войти' : state.resendSeconds > 0 ? `Новый код через ${state.resendSeconds} с` : 'Получить код'}</button>`}
      </div>
      <div class="account-auth-alternatives">${code ? `<button type="button" class="secondary-button" data-account-action="resend" ${disabled || expired || state.resendSeconds > 0 ? 'disabled' : ''}>${state.resendSeconds > 0 ? `Новый код через ${state.resendSeconds} с` : 'Запросить новый код'}</button>` : action('telegram', 'Войти через Telegram', false, disabled || !telegram)}</div>
    </form>`;
  }
  function render(state: Readonly<AccountState>) {
    // A clock or keystroke must not replace the input node or move its caret.
    const signature = JSON.stringify([state.screen,state.identity,state.step,state.step === 'code' ? state.email : null,state.busy,state.issue,state.attempt,state.telegramPending,state.verificationPending,offline()]);
    if (signature === rendered) {
      const resend = content.querySelector<HTMLButtonElement>('[data-account-action="resend"]');
      if (resend) {
        resend.textContent = state.resendSeconds > 0 ? 'Новый код через ' + state.resendSeconds + ' с' : 'Запросить новый код';
        resend.disabled = actionAvailability({connection:offline() ? 'offline' : 'online',requiresConnection:true,pending:Boolean(state.busy),available:state.issue?.code !== 'attempt_expired' && state.resendSeconds === 0}).disabled;
      }
      const submit = content.querySelector<HTMLButtonElement>('button[type="submit"]');
      if (submit && state.step === 'email') {
        submit.textContent = state.resendSeconds > 0 ? `Новый код через ${state.resendSeconds} с` : 'Получить код';
        submit.disabled = offline() || Boolean(state.busy) || state.resendSeconds > 0;
      }
      return;
    }
    rendered = signature;
    const active = document.activeElement as HTMLInputElement | null;
    const focus = active && content.contains(active) ? { id: active.id, action: active.dataset.accountAction, start: active.selectionStart, end: active.selectionEnd, direction: active.selectionDirection } : null;
    unwatchInput();
    for (const item of feedback) item.destroy(); feedback = [];
    const disabled = actionAvailability({connection:offline() ? 'offline' : 'online', requiresConnection:true, pending:Boolean(state.busy)}).disabled;
    let body = state.step !== 'account' ? form(state)
      : state.screen === 'guest' ? `<div class="account-study-empty"><p class="account-study-intro">Войдите, чтобы сохранять карты и открывать их на других устройствах.</p>${action('login', 'Войти', true, disabled)}</div>`
      : state.screen === 'error' ? `<div class="account-study-empty">${action('retry', 'Повторить', false, disabled)}</div>` : signedIn(state);
    if (state.step === 'account') body += '<div id="accountActionFeedback"></div>';
    content.innerHTML = `<header class="workspace-header"><div class="workspace-heading"><h1>Аккаунт</h1></div></header><div class="account-study-body"><div class="account-study-panel">${body}</div></div>`;
    const actionFeedback = createFeedback(content.querySelector<HTMLElement>('#accountActionFeedback')!, { kind: 'action' }); feedback.push(actionFeedback);
    const field = content.querySelector<HTMLInputElement>('#accountEmail, #accountCode');
    unwatchInput = field && state.step === 'email' ? watchTextSelection([field],onInputChange) : () => {};
    const fieldFeedback = field ? createFeedback(content.querySelector<HTMLElement>('#accountFieldFeedback')!, {kind:'field',field}) : null;
    if (fieldFeedback) feedback.push(fieldFeedback);
    if (state.busy) {
      const key = ({begin:'authOpening',send:'authSending',resend:'authSending',verify:'authVerifying',telegram:'authTelegram',retry:'accountLoading'} as const)[state.busy];
      actionFeedback.show({message:UI_MESSAGES[key],busy:true,actions:state.step === 'account' ? [{label:'Отменить',run:flow.cancel}] : []});
    } else if (state.issue) {
      if (state.issue.field && fieldFeedback) fieldFeedback.show({message:message(state.issue),tone:'error'});
      if (offline()) actionFeedback.show({message:UI_MESSAGES.offline,tone:'neutral'});
      else if (!state.issue.field || !fieldFeedback) actionFeedback.show({message:message(state.issue),tone:'error'});
    } else if (offline()) actionFeedback.show({message:UI_MESSAGES.offline,tone:'neutral'});
    else if (state.screen === 'error' && state.step === 'account') actionFeedback.show({message:UI_MESSAGES.accountUnavailable,tone:'error'});
    if (!page.hidden) {
      const next = focus?.id ? content.querySelector<HTMLInputElement>(`#${focus.id}`) : focus?.action ? content.querySelector<HTMLButtonElement>(`[data-account-action="${focus.action}"]`) : null;
      if (next && !next.disabled) { next.focus({preventScroll:true}); if ('setSelectionRange' in next && next.type !== 'email' && focus?.start != null) next.setSelectionRange(focus.start,focus.end,focus.direction ?? 'none'); }
      else if (state.issue?.field && field) field.focus({preventScroll:true});
      else if (focus?.action === 'cancel') (field ?? content.querySelector<HTMLElement>('[data-account-action]'))?.focus({preventScroll:true});
      else if (previousStep !== state.step) (field ?? content.querySelector<HTMLElement>('[data-account-action]'))?.focus({preventScroll:true});
    }
    previousStep = state.step;
  }
  content.addEventListener('input', event => {
    const input = event.target as HTMLInputElement;
    if (input.id === 'accountEmail' || input.id === 'accountCode') flow.input(input.id === 'accountEmail' ? 'email' : 'code', input.value);
  });
  content.addEventListener('submit', event => { event.preventDefault(); void flow.submit(); });
  content.addEventListener('click', event => {
    const button = (event.target as Element).closest<HTMLButtonElement>('[data-account-action]'); if (!button || button.disabled) return;
    const actions: Record<string, () => unknown> = { login:flow.begin, retry:flow.retry, logout:flow.logout, close:flow.close, back:flow.back, cancel:flow.cancel, telegram:flow.telegram, resend:flow.resend };
    void actions[button.dataset.accountAction ?? '']?.();
  });
  const unsubscribe = flow.subscribe(render);
  return {
    get inputFocus() { return !page.hidden && flow.state.step === 'email' ? captureTextSelection(content.querySelector<HTMLInputElement>('#accountEmail')) : null; },
    restoreInputFocus(focus: unknown) { return !page.hidden && flow.state.step === 'email' && restoreTextSelection(content.querySelector<HTMLInputElement>('#accountEmail'),focus); },
    render: () => render(flow.state), destroy() { unwatchInput(); unsubscribe(); for (const item of feedback) item.destroy(); content.remove(); } };
}
