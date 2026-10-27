// The stand chooses an adapter; startup owns the sole account workspace.
import { registerAccountPreview } from '../views/account.ts';
import { createAccountAdapter, accountPreviewIdentity, type AccountScenario } from './account-adapter.ts';
import type { AccountScreen } from '../state/account-flow.ts';
import { isDevelopmentPort } from '../../shared/development.ts';

if (typeof location !== 'undefined' && isDevelopmentPort(location.port)) {
  registerAccountPreview(account => {
    const palettes = document.getElementById('controlColorPreviews');
    if (!palettes) return;
    const storageKey = 'forma.account-preview.v1';
    const screens = ['linked', 'unlinked', 'guest', 'expired', 'error'];
    let screen = 'real';
    try {
      const saved = JSON.parse(sessionStorage.getItem(storageKey)!);
      // Older records came from an automatic fake account, not a user choice.
      if (saved?.enabled === true && screens.includes(saved.screen)) screen = saved.screen;
    } catch {}
    const options = document.createElement('div'); options.className = 'account-study-options';
    options.innerHTML = `<div class="account-study-option-heading"><span>Аккаунт</span><select data-account-screen aria-label="Состояние макета аккаунта"><option value="real">Обычный</option><option value="linked">Почта + Telegram</option><option value="unlinked">Только почта</option><option value="guest">Без входа</option><option value="expired">Войти снова</option><option value="error">Ошибка</option></select></div>
      <div class="account-study-option-heading" data-account-scenario-row><span>Вход</span><select data-account-scenario aria-label="Сценарий входа"><option value="normal">Обычный</option><option value="new-telegram">Новый Telegram</option><option value="code-expired">Код истёк</option><option value="attempt-expired">Вход истёк</option><option value="rate-limit">Ограничение попыток</option><option value="send-failed">Код не отправлен</option><option value="delivery-failed">Письмо не доставлено</option><option value="verify-failed">Код не проверен</option><option value="telegram-conflict">Telegram занят</option></select></div>
      <p class="account-study-preview-note">Вариант для приёмки. Письма не отправляются. Код для проверки: 123456.</p>`;
    palettes.prepend(options);
    const select = options.querySelector<HTMLSelectElement>('[data-account-screen]')!;
    const scenario = options.querySelector<HTMLSelectElement>('[data-account-scenario]')!;
    const row = options.querySelector<HTMLElement>('[data-account-scenario-row]')!;
    const note = options.querySelector<HTMLElement>('.account-study-preview-note')!;
    let stop = () => {};
    function remember() {
      try { sessionStorage.setItem(storageKey, JSON.stringify({ enabled: select.value !== 'real', screen: select.value })); } catch {}
    }
    function apply() {
      stop(); row.hidden = note.hidden = select.value === 'real';
      const chosen = select.value as AccountScreen;
      const flow = account.preview(select.value === 'real' ? null : { screen: chosen, identity: accountPreviewIdentity(chosen),
        request: createAccountAdapter({ scenario: () => scenario.value as AccountScenario }) });
      if (flow) stop = flow.subscribe(state => { select.value = state.screen; remember(); });
      remember();
    }
    select.value = screen; row.hidden = note.hidden = screen === 'real';
    select.addEventListener('change', apply);
    scenario.addEventListener('change', () => account.cancelPreview());
    if (screen !== 'real') apply();
  });
}
