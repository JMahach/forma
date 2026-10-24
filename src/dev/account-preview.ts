// One design study inside the real account workspace; no authentication or personal-data writes.
import { standConnection } from './control-colors.ts';
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
    const content = document.createElement('div');
    content.className = 'account-study-content';
    page.append(content);
    const options = document.createElement('div');
    options.className = 'account-study-options';
    options.innerHTML = '<div class="account-study-option-heading"><span>Аккаунт</span><select aria-label="Состояние макета аккаунта"><option value="linked">Почта + Telegram</option><option value="unlinked">Только почта</option><option value="guest">Без входа</option><option value="expired">Войти снова</option><option value="error">Ошибка</option></select></div>';
    palettes.prepend(options);
    const select = options.querySelector('select')!;
    select.value = screen;
    function remember() { try { sessionStorage.setItem(storageKey, JSON.stringify({ screen: select.value })); } catch {} }
    const check = '<svg width="14" height="14" viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="m4 10 4 4 8-8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    const exitIcon = '<svg width="16" height="16" viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M9 3H4v14h5m4-11 4 4-4 4m-6-4h10" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    const mailIcon = '<svg width="14" height="14" viewBox="0 0 20 20" fill="none" aria-hidden="true"><rect x="2.5" y="4" width="15" height="12" rx="1.5" stroke="currentColor" stroke-width="1.25"/><path d="m3 5 7 5 7-5" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    const telegramIcon = '<svg width="14" height="14" viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="m17 3-3 14-5-4-3 2V10L2 8l15-5ZM6 10l11-7-8 10" stroke="currentColor" stroke-width="1.15" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    function signedIn(state: string) {
      return `${state === 'expired' ? '<div class="account-study-session"><p>Войдите снова, чтобы сохранять изменения.</p><button class="account-study-action" type="button" data-account-action="login">Войти</button></div>' : ''}
        <dl class="account-study-details"><div class="account-study-mail"><dt>${mailIcon}<span>Почта</span></dt><dd class="account-study-email"><span class="account-study-mask">anna@example.com</span></dd><dd class="account-study-confirmed"><span class="account-study-mask">${check} Подтверждена</span></dd></div>
        <div class="account-study-telegram"><dt>${telegramIcon}<span>Telegram</span></dt>${state === 'unlinked' ? '<dd class="account-study-status is-unlinked">Не привязан</dd>' : `<dd class="account-study-handle"><span class="account-study-mask">@username</span></dd><dd class="account-study-confirmed"><span class="account-study-mask">${check} Привязан</span></dd>`}</div></dl>
        <div class="account-study-logout"><div class="account-study-exit-action"><button class="account-study-action account-study-mask" type="button" data-account-action="logout">${exitIcon}<span>Выйти</span></button></div><div class="account-study-exit-note"><p>Выход из всех вкладок этого браузера.<br>Несохранённые изменения будут удалены.<br>Карты в аккаунте сохранятся.</p></div></div>`;
    }
    function updateAvailability() {
      // Connection changes affect actions, never the already shown account data.
      for (const button of content.querySelectorAll<HTMLButtonElement>('[data-account-action]')) {
        button.disabled = button.dataset.accountAction !== 'logout' && standConnection.current === 'offline';
      }
    }
    function render() {
      const state = select.value;
      let body;
      if (state === 'guest') body = '<div class="account-study-empty"><p class="account-study-intro">Войдите, чтобы сохранять карты и открывать их на других устройствах.</p><button class="account-study-action account-study-primary" type="button" data-account-action="login">Войти</button></div>';
      else if (state === 'error') body = '<div class="account-study-empty"><p class="account-study-intro" role="status">Не удалось загрузить аккаунт.</p><button class="account-study-action" type="button" data-account-action="retry">Повторить</button></div>';
      else body = signedIn(state);
      content.innerHTML = `<header class="workspace-header"><div class="workspace-heading"><h1>Аккаунт</h1></div></header><div class="account-study-body"><div class="account-study-panel">${body}</div></div>`;
      updateAvailability();
    }
    select.addEventListener('change', () => { render(); remember(); });
    content.addEventListener('click', event => {
      const button = (event.target as Element).closest<HTMLElement>('[data-account-action]');
      if (!button) return;
      const action = button.dataset.accountAction;
      // A server failure cannot turn a login/link/retry rehearsal into success.
      // Logout is local and remains available regardless of the connection.
      if (action !== 'logout' && standConnection.current !== 'online') return;
      select.value = action === 'logout' ? 'guest' : 'linked';
      render(); remember();
      const nextAction = content.querySelector<HTMLElement>('[data-account-action]');
      nextAction?.focus({preventScroll:true});
    });
    standConnection.subscribe(updateAvailability);
    render(); remember();
  }
}
