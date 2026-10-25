// One design study inside the real account workspace; no authentication or personal-data writes.
import { standConnection } from './stand-connection.ts';
import { createAccountFlow } from '../state/account-flow.ts';
import { attachAccountView } from '../views/account.ts';
import { createAccountAdapter, accountPreviewIdentity, type AccountScenario } from './account-adapter.ts';
import type { AccountScreen } from '../state/account-flow.ts';
import { isDevelopmentPort } from '../../shared/development.ts';

if (typeof location !== 'undefined' && isDevelopmentPort(location.port)) {
  const page = document.getElementById('accountPage');
  const palettes = document.getElementById('controlColorPreviews');
  if (page && palettes) {
    const storageKey = 'forma.account-preview.v1';
    const screens = ['linked', 'unlinked', 'guest', 'expired', 'error'];
    let screen = 'linked';
    try {
      const saved = JSON.parse(sessionStorage.getItem(storageKey)!) as { screen: string };
      if (screens.includes(saved?.screen)) screen = saved.screen;
    } catch {}
    page.dataset.accountStudy = '';
    page.dataset.accountAccent = 'graphite';
    const style = document.createElement('style');
    const loading = `.app-shell[data-page-state='loading'] .account-page[data-account-study]`;
    style.textContent = `
      .account-page[data-account-study] { --account-ink: var(--account-accent); --account-edge: var(--panel-border); padding: 0; overflow: hidden; }
      .account-study-content { display: flex; flex-direction: column; flex: 1; min-height: 0; width: 100%; }
      .account-study-body { flex: 1; min-height: 0; overflow: auto; overscroll-behavior: contain; touch-action: pan-y; padding: 32px 24px max(40px, env(safe-area-inset-bottom)); }
      .account-study-panel { width: 100%; max-width: 760px; margin: 0 auto; }
      .account-study-details { margin: 0; padding: 0; }
      .account-study-details dt, .account-study-details dd { margin: 0; }
      .account-study-mail, .account-study-telegram { display: grid; grid-template-columns: 116px minmax(0, 1fr) max-content; align-items: center; gap: 16px; min-height: 96px; padding: 24px 0; border-bottom: 1px solid var(--panel-border); }
      .account-study-mail dt, .account-study-telegram dt { display: flex; align-items: center; gap: 10px; font-size: 14px; line-height: 22px; color: var(--panel-muted); }
      .account-study-details dt svg { width: 18px; height: 18px; flex: none; color: var(--account-ink); }
      .account-study-email, .account-study-handle { min-width: 0; overflow-wrap: anywhere; font-size: 20px; line-height: 28px; font-weight: 500; color: var(--panel-ink); letter-spacing: -.025em; }
      .account-study-confirmed { display: flex; align-items: center; gap: 6px; font-size: 13px; line-height: 20px; color: var(--panel-muted); }
      .account-study-confirmed .account-study-mask, .account-study-status .account-study-mask { display: inline-flex; align-items: center; gap: 6px; }
      .account-study-confirmed svg { width: 16px; height: 16px; flex: none; color: var(--sage-accent); }
      .account-study-status { grid-column: 2 / -1; font-size: 16px; line-height: 24px; color: var(--panel-muted); }
      .account-study-logout { display: grid; grid-template-columns: 116px minmax(0, 1fr); align-items: start; gap: 16px; padding: 28px 0; }
      .account-study-exit-action { display: flex; }
      .account-study-exit-note { padding-top: 3px; }
      .account-study-action { position: relative; display: inline-flex; align-items: center; justify-content: center; gap: 9px; min-height: 44px; padding: 10px 16px; border: 1px solid var(--panel-border); border-radius: 8px; background: var(--canvas-background); color: var(--account-ink); font: inherit; font-size: 14px; line-height: 22px; cursor: pointer; touch-action: manipulation; transition: transform 120ms ease-out, background 120ms ease-out; }
      .account-study-action:active:not(:disabled) { transform: scale(.97); }
      .account-study-action:focus-visible { outline: 2px solid var(--account-ink); outline-offset: 3px; }
      .account-study-primary { border-color: var(--account-ink); background: var(--account-ink); color: #fffefd; }
      .account-study-action svg { width: 18px; height: 18px; flex: none; }
      .account-study-logout p { margin: 0; font-size: 13px; line-height: 21px; color: var(--panel-muted); }
      .account-study-empty { padding: 24px 0; }
      .account-study-intro { max-width: 480px; margin: 0 0 24px; font-size: 20px; line-height: 1.5; letter-spacing: -.02em; color: var(--panel-ink); }
      .account-study-session { display: flex; flex-wrap: wrap; align-items: center; gap: 16px; padding: 20px; border: 1px solid var(--panel-border); border-radius: 8px; background: var(--panel-surface); }
      .account-study-session p { flex: 1 1 220px; margin: 0; font-size: 15px; line-height: 23px; }
      .app-shell[data-page-state='loading']:has(.studio[data-workspace-screen='account']) #accountPage[data-account-study] { display: flex !important; opacity: 1; }
      ${loading} :is(.account-study-mask, .account-study-status, .account-study-action, .account-study-intro, .account-study-session p, .account-study-exit-note p) { position: relative; color: transparent; }
      ${loading} :is(.account-study-mask, .account-study-status, .account-study-action, .account-study-intro, .account-study-session p, .account-study-exit-note p)::after { content: ''; position: absolute; inset: 50% 0 auto; transform: translateY(-50%); height: 7px; border-radius: 2px; background: var(--loading-ink); pointer-events: none; }
      ${loading} :is(.account-study-intro, .account-study-session p, .account-study-exit-note p)::after { inset: 3px 0; height: auto; transform: none; background: repeating-linear-gradient(to bottom, var(--loading-ink) 0 5px, transparent 5px 21px); opacity: .65; }
      ${loading} :is(.account-study-mask, .account-study-action) > * { visibility: hidden; }
      ${loading} .account-study-action { border-color: var(--panel-border); background: transparent; }
      ${loading} .account-study-action::after { inset-inline: 12px; }
      ${loading} .account-study-details dt svg { opacity: .4; }
      .account-study-options { display: none; flex: 0 0 100%; min-width: 0; padding: 0 0 10px; margin-bottom: 2px; border-bottom: 1px solid var(--panel-border); }
      body:has(.studio[data-workspace-screen='account']) .account-study-options { display: grid; gap: 9px; }
      .account-study-option-heading { display: flex; align-items: center; justify-content: space-between; gap: 8px; color: var(--panel-muted); font-size: 11px; }
      .account-study-option-heading select { width: auto; max-width: 176px; min-height: 32px; padding: 4px 18px 4px 7px; border: 1px solid var(--panel-border); border-radius: 6px; color: var(--panel-ink); background: var(--canvas-background); font: inherit; font-size: 12px; }
      @media (hover: hover) and (pointer: fine) { .account-study-action:hover:not(:disabled) { background: var(--panel-hover); } .account-study-primary:hover:not(:disabled) { background: var(--account-hover); } }
      @media (prefers-reduced-motion: reduce) { .account-study-action { transition: none; } .account-study-action:active:not(:disabled) { transform: none; } }
      @media (max-width: 1099px) {
        .account-study-mail, .account-study-telegram { grid-template-columns: minmax(0, 1fr) max-content; gap: 10px; padding: 20px 0; }
        .account-study-details dt { grid-column: 1; grid-row: 1; }
        .account-study-confirmed { grid-column: 2; grid-row: 1; }
        .account-study-email, .account-study-handle, .account-study-status { grid-column: 1 / -1; grid-row: 2; }
      }
      .app-shell:has(.canvas-wrap[data-layout='phone']) .account-study-body { padding: 24px 20px max(40px, env(safe-area-inset-bottom)); }
      .app-shell:has(.canvas-wrap[data-layout='phone']) .account-study-logout { grid-template-columns: 1fr; gap: 14px; padding-block: 24px; }
      .app-shell:has(.canvas-wrap[data-layout='phone']) .account-study-intro { font-size: 20px; }
      .app-shell:has(.canvas-wrap[data-layout='phone']) .account-study-session { padding: 16px; }
      .app-shell:has(.canvas-wrap[data-layout='phone']) .account-study-option-heading select { min-height: 40px; font-size: 16px; }
      .app-shell:has(.canvas-wrap[data-layout='phone']) .account-study-options { gap: 12px; padding-bottom: 13px; }
    `;
    document.head.append(style);
    const options = document.createElement('div');
    options.className = 'account-study-options';
    options.innerHTML = `<div class="account-study-option-heading"><span>Аккаунт</span><select data-account-screen aria-label="Состояние макета аккаунта"><option value="linked">Почта + Telegram</option><option value="unlinked">Только почта</option><option value="guest">Без входа</option><option value="expired">Войти снова</option><option value="error">Ошибка</option></select></div>
      <div class="account-study-option-heading"><span>Вход</span><select data-account-scenario aria-label="Сценарий входа"><option value="normal">Обычный</option><option value="new-telegram">Новый Telegram</option><option value="code-expired">Код истёк</option><option value="attempt-expired">Вход истёк</option><option value="rate-limit">Ограничение попыток</option><option value="send-failed">Код не отправлен</option><option value="delivery-failed">Письмо не доставлено</option><option value="verify-failed">Код не проверен</option><option value="telegram-conflict">Telegram занят</option></select></div>
      <p class="account-study-preview-note">Вариант для приёмки. Письма не отправляются. Код для проверки: 123456.</p>`;
    palettes.prepend(options);
    const select = options.querySelector<HTMLSelectElement>('[data-account-screen]')!;
    const scenario = options.querySelector<HTMLSelectElement>('[data-account-scenario]')!;
    select.value = screen;
    const flow = createAccountFlow({ initial: screen as AccountScreen, identity: accountPreviewIdentity(screen as AccountScreen), connection: () => standConnection.current,
      request: createAccountAdapter({scenario: () => scenario.value as AccountScenario}) });
    attachAccountView({page, flow, offline: () => standConnection.current === 'offline'});
    select.addEventListener('change', () => flow.choose(select.value as AccountScreen, accountPreviewIdentity(select.value as AccountScreen)));
    scenario.addEventListener('change', () => flow.cancel());
    flow.subscribe(state => {
      select.value = state.screen;
      try { sessionStorage.setItem(storageKey, JSON.stringify({screen:state.screen})); } catch {}
    });
    standConnection.subscribe(() => flow.connectionChanged());
    const timer = setInterval(() => flow.tick(), 1000);
    const observer = new MutationObserver(() => { if (page.hidden) flow.close(); });
    observer.observe(page, {attributes:true, attributeFilter:['hidden']});
    addEventListener('pagehide', event => {
      flow.close();
      if (!(event as PageTransitionEvent).persisted) { clearInterval(timer); observer.disconnect(); flow.destroy(); }
    });
  }
}
