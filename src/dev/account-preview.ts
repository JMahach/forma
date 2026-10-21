// One design study inside the real account workspace; no authentication or personal-data writes.
import './control-colors.ts';

if (location.port === '3636') {
  const page = document.getElementById('accountPage');
  const palettes = document.getElementById('controlColorPreviews');
  if (page && palettes) {
    const storageKey = 'forma.account-preview.v1';
    const accents = { sand: 'Песок', sage: 'Шалфей', graphite: 'Графит' };
    type AccountAccent = keyof typeof accents;
    const screens = ['linked', 'unlinked', 'guest', 'expired', 'error'];
    let accent: AccountAccent = 'graphite', screen = 'linked';
    try {
      const saved = JSON.parse(sessionStorage.getItem(storageKey)!) as { accent: AccountAccent; screen: string };
      if (Object.hasOwn(accents, saved?.accent)) accent = saved.accent;
      if (screens.includes(saved?.screen)) screen = saved.screen;
    } catch {}
    page.dataset.accountStudy = '';
    const style = document.createElement('style');
    const loading = `.app-shell[data-page-state='loading'] .account-page[data-account-study]`;
    style.textContent = `
      .account-page[data-account-study] { --account-ink: #715438; --account-tint: #eee6d8; --account-edge: #c7b79f; overflow: auto; overscroll-behavior: contain; touch-action: pan-y; }
      .account-page[data-account-accent='sage'] { --account-ink: var(--sage-accent); --account-tint: var(--sage-tint); --account-edge: var(--sage-border); }
      .account-page[data-account-accent='graphite'] { --account-ink: var(--account-accent); --account-tint: #e7e7e3; --account-edge: #b9b9b1; }
      .account-study-content { flex: 0 0 auto; width: calc(100% - 80px); max-width: 480px; margin: 46px auto 30px; }
      .account-study-panel { border: 1px solid var(--account-edge); border-radius: 7px; overflow: hidden; background: var(--canvas-background); }
      .account-study-heading { display: flex; align-items: center; justify-content: space-between; gap: 16px; min-height: 50px; padding: 11px 20px; border-bottom: 1px solid var(--account-ink); background: var(--account-ink); color: #fffefd; }
      .account-study-heading h1 { margin: 0; font-size: 22px; line-height: 28px; letter-spacing: -.35px; font-weight: 500; color: inherit; }
      .account-study-details { margin: 0; padding: 0 20px; }
      .account-study-details dt, .account-study-details dd { margin: 0; }
      .account-study-mail, .account-study-telegram { display: grid; grid-template-columns: 80px minmax(0, 1fr) max-content; align-items: center; gap: 10px; min-height: 52px; padding: 12px 0; }
      .account-study-mail { border-bottom: 1px solid var(--panel-border); }
      .account-study-mail dt, .account-study-telegram dt { grid-column: 1; grid-row: 1; align-self: center; display: flex; align-items: center; gap: 7px; padding: 0; font-size: 13px; line-height: 24px; color: var(--panel-muted); }
      .account-study-details dt span { flex: 1; text-align: center; }
      .account-study-details dt svg { width: 14px; height: 14px; flex: none; color: var(--account-ink); }
      .account-study-email, .account-study-handle { grid-column: 2; grid-row: 1; min-width: 0; padding-inline-start: 12px; overflow: auto; scrollbar-width: none; white-space: nowrap; font-size: 16px; line-height: 24px; font-weight: 500; color: var(--panel-ink); letter-spacing: -.15px; }
      .account-study-confirmed { grid-column: 3; grid-row: 1; justify-self: end; white-space: nowrap; display: flex; align-items: center; gap: 6px; font-size: 12px; line-height: 17px; color: var(--panel-muted); }
      .account-study-confirmed .account-study-mask, .account-study-status .account-study-mask { display: inline-flex; align-items: center; gap: 6px; }
      .account-study-confirmed svg, .account-study-status svg { width: 14px; height: 14px; flex: none; color: var(--sage-accent); }
      .account-study-status { grid-column: 3; grid-row: 1; justify-self: end; white-space: nowrap; display: flex; align-items: center; gap: 6px; color: var(--panel-ink); font-size: 14px; line-height: 24px; }
      .account-study-status.is-unlinked { color: var(--panel-muted); }
      .account-study-logout { display: grid; grid-template-columns: 118px minmax(0, 1fr); border-top: 1px solid var(--account-edge); background: var(--panel-surface); }
      .account-study-exit-action { display: grid; place-items: center; padding: 13px 0; border-right: 1px solid var(--panel-border); }
      .account-study-exit-note { display: grid; place-items: center; padding: 13px 16px; text-align: center; }
      .account-study-action { position: relative; display: inline-flex; flex: none; align-items: center; justify-content: center; gap: 7px; min-height: 34px; padding: 7px 12px; border: 1px solid var(--account-ink); border-radius: 7px; background: var(--canvas-background); color: var(--account-ink); font: inherit; font-size: 13px; font-weight: 500; line-height: 18px; cursor: pointer; touch-action: manipulation; }
      .account-study-action::after { content: ''; position: absolute; inset: -5px 0; }
      .account-study-action:focus-visible { outline: 1px dashed var(--account-ink); outline-offset: 3px; }
      .account-study-primary { background: var(--account-ink); color: #fffefd; }
      .account-study-action svg { width: 16px; height: 16px; flex: none; }
      .account-study-logout p { margin: 0; font-size: 12px; line-height: 18px; color: var(--panel-muted); }
      .account-study-empty { padding: 24px 22px 26px; }
      .account-study-intro { max-width: 350px; margin: 0 0 22px; font-size: 15px; line-height: 1.6; color: var(--panel-muted); }
      .account-study-session { display: flex; flex-wrap: wrap; align-items: center; gap: 14px; padding: 18px 22px; border-bottom: 1px solid var(--panel-border); }
      .account-study-session p { flex: 1 1 230px; margin: 0; font-size: 13px; line-height: 19px; }
      .app-shell[data-page-state='loading']:has(.studio[data-workspace-screen='account']) #accountPage[data-account-study] { display: flex !important; opacity: 1; }
      ${loading} .account-study-heading { background: var(--panel-surface); border-bottom-color: var(--account-edge); }
      ${loading} .account-study-heading h1,
      ${loading} :is(.account-study-mask, .account-study-status, .account-study-action, .account-study-intro, .account-study-session p, .account-study-exit-note p) { position: relative; color: transparent; }
      ${loading} .account-study-heading h1::after,
      ${loading} :is(.account-study-mask, .account-study-status, .account-study-action, .account-study-intro, .account-study-session p, .account-study-exit-note p)::after {
        content: ''; position: absolute; inset: 50% 0 auto; transform: translateY(-50%); height: 6px; border-radius: 2px; background: var(--loading-ink); pointer-events: none;
      }
      ${loading} .account-study-heading h1::after { height: 10px; }
      ${loading} :is(.account-study-intro, .account-study-session p, .account-study-exit-note p)::after { inset: 3px 0; height: auto; transform: none; background: repeating-linear-gradient(to bottom, var(--loading-ink) 0 5px, transparent 5px 18px); opacity: .65; }
      ${loading} :is(.account-study-mask, .account-study-action) > * { visibility: hidden; }
      ${loading} .account-study-action { border-color: var(--panel-border); background: transparent; }
      ${loading} .account-study-action::after { inset-inline: 12px; }
      ${loading} .account-study-details dt { color: var(--panel-muted); }
      ${loading} .account-study-details dt svg { opacity: .4; }
      .control-color-previews { flex-wrap: wrap; }
      .account-study-options { display: none; flex: 0 0 100%; min-width: 0; padding: 0 0 10px; margin-bottom: 2px; border-bottom: 1px solid var(--panel-border); }
      body:has(.studio[data-workspace-screen='account']) .account-study-options { display: grid; gap: 9px; }
      .account-study-option-heading { display: flex; align-items: center; justify-content: space-between; gap: 8px; color: var(--panel-muted); font-size: 11px; }
      .account-study-option-heading select { width: auto; max-width: 176px; min-height: 32px; padding: 4px 18px 4px 7px; border: 1px solid var(--panel-border); border-radius: 6px; color: var(--panel-ink); background: var(--canvas-background); font: inherit; font-size: 12px; }
      .account-study-accents { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 6px; }
      .account-study-accent { position: relative; display: inline-flex; align-items: center; justify-content: center; gap: 5px; min-height: 32px; padding: 4px 5px; border: 1px solid var(--swatch-edge); border-radius: 7px; color: var(--swatch-ink); background: var(--swatch-tint); font: inherit; font-size: 11px; line-height: 16px; cursor: pointer; touch-action: manipulation; }
      .account-study-accent::before { content: ''; width: 6px; height: 6px; border-radius: 50%; background: var(--swatch-ink); flex: none; }
      .account-study-accent::after { content: ''; position: absolute; inset: -5px 0; }
      .account-study-accent[aria-pressed='true'] { border-color: var(--swatch-ink); box-shadow: inset 0 0 0 .5px var(--swatch-ink); }
      .account-study-accent:focus-visible { outline: 1px dashed var(--swatch-ink); outline-offset: 2px; }
      @media (hover: hover) and (pointer: fine) { .account-study-action:hover { box-shadow: inset 0 0 0 .5px currentColor; } .account-study-accent:hover { border-color: var(--swatch-ink); } }
      .app-shell:has(.canvas-wrap[data-layout='phone']) .account-page[data-account-study] { padding-bottom: max(68px, calc(env(safe-area-inset-bottom) + 20px)); }
      .app-shell:has(.canvas-wrap[data-layout='phone']) .account-study-content { width: calc(100% - 32px); margin-block: auto; }
      .app-shell:has(.canvas-wrap[data-layout='phone']) .account-study-heading { min-height: 50px; padding: 11px 18px; }
      .app-shell:has(.canvas-wrap[data-layout='phone']) .account-study-heading h1 { font-size: 22px; }
      .app-shell:has(.canvas-wrap[data-layout='phone']) .account-study-details { padding: 0 18px; }
      .app-shell:has(.canvas-wrap[data-layout='phone']) :is(.account-study-mail, .account-study-telegram) { grid-template-columns: 74px minmax(0, 1fr) max-content; gap: 6px; min-height: 49px; padding: 11px 0; }
      .app-shell:has(.canvas-wrap[data-layout='phone']) :is(.account-study-email, .account-study-handle) { font-size: 14px; }
      .app-shell:has(.canvas-wrap[data-layout='phone']) .account-study-confirmed { font-size: 11px; }
      .app-shell:has(.canvas-wrap[data-layout='phone']) .account-study-confirmed .account-study-mask { gap: 3px; }
      .app-shell:has(.canvas-wrap[data-layout='phone']) .account-study-details dt { gap: 5px; font-size: 12px; }
      .app-shell:has(.canvas-wrap[data-layout='phone']) .account-study-logout { grid-template-columns: 106px minmax(0, 1fr); }
      .app-shell:has(.canvas-wrap[data-layout='phone']) .account-study-exit-action { padding: 13px 0; }
      .app-shell:has(.canvas-wrap[data-layout='phone']) .account-study-exit-note { padding: 13px 12px; }
      .app-shell:has(.canvas-wrap[data-layout='phone']) .account-study-empty { padding: 22px 18px; }
      .app-shell:has(.canvas-wrap[data-layout='phone']) .account-study-session { padding: 16px 18px; }
      .app-shell:has(.canvas-wrap[data-layout='phone']) .account-study-option-heading select { min-height: 40px; font-size: 16px; }
      .app-shell:has(.canvas-wrap[data-layout='phone']) .account-study-options { gap: 12px; padding-bottom: 13px; }
      @media (max-width: 359px) { .account-study-logout { grid-template-columns: 90px minmax(0, 1fr); } .account-study-exit-note { padding: 13px 9px; } .account-study-mail, .account-study-telegram { grid-template-columns: 70px minmax(0, 1fr) max-content; gap: 5px; } }
    `;
    document.head.append(style);
    const content = document.createElement('div');
    content.className = 'account-study-content';
    page.append(content);
    const options = document.createElement('div');
    options.className = 'account-study-options';
    options.innerHTML = '<div class="account-study-option-heading"><span>Аккаунт</span><select aria-label="Состояние макета аккаунта"><option value="linked">Почта + Telegram</option><option value="unlinked">Только почта</option><option value="guest">Без входа</option><option value="expired">Войти снова</option><option value="error">Ошибка</option></select></div><div class="account-study-accents" role="group" aria-label="Акцент аккаунта"></div>';
    palettes.prepend(options);
    const select = options.querySelector('select')!;
    select.value = screen;
    const accentGroup = options.querySelector<HTMLElement>('.account-study-accents')!;
    const swatches = { sand: ['#715438','#eee6d8','#c7b79f'], sage: ['var(--sage-accent)','var(--sage-tint)','var(--sage-border)'], graphite: ['var(--account-accent)','#e7e7e3','#b9b9b1'] };
    for (const [value, label] of Object.entries(accents) as [AccountAccent, string][]) {
      const button = document.createElement('button');
      button.type = 'button'; button.className = 'account-study-accent'; button.textContent = label;
      button.dataset.accent = value;
      button.setAttribute('aria-label', `Аккаунт: ${label}`);
      ['ink','tint','edge'].forEach((key, index) => button.style.setProperty(`--swatch-${key}`,swatches[value][index]));
      button.addEventListener('click', () => { accent = value; paintAccent(); remember(); });
      accentGroup.append(button);
    }
    function remember() { try { sessionStorage.setItem(storageKey,JSON.stringify({accent,screen:select.value})); } catch {} }
    function paintAccent() {
      page!.dataset.accountAccent = accent;
      for (const button of accentGroup.children) button.setAttribute('aria-pressed', String((button as HTMLElement).dataset.accent === accent));
    }
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
    function render() {
      const state = select.value;
      let body;
      if (state === 'guest') body = '<div class="account-study-empty"><p class="account-study-intro">Войдите, чтобы сохранять карты и открывать их на других устройствах.</p><button class="account-study-action account-study-primary" type="button" data-account-action="login">Войти</button></div>';
      else if (state === 'error') body = '<div class="account-study-empty"><p class="account-study-intro" role="status">Не удалось загрузить аккаунт.</p><button class="account-study-action" type="button" data-account-action="retry">Повторить</button></div>';
      else body = signedIn(state);
      content.innerHTML = `<div class="account-study-panel"><header class="account-study-heading"><h1>Аккаунт</h1></header>${body}</div>`;
    }
    select.addEventListener('change', () => { render(); remember(); });
    content.addEventListener('click', event => {
      const button = (event.target as Element).closest<HTMLElement>('[data-account-action]');
      if (!button) return;
      select.value = button.dataset.accountAction === 'logout' ? 'guest' : 'linked';
      render(); remember();
      const nextAction = content.querySelector<HTMLElement>('[data-account-action]');
      nextAction?.focus({preventScroll:true});
    });
    paintAccent(); render();
  }
}
