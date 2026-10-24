import { standConnection } from './control-colors.ts';
import { isDevelopmentPort } from '../../shared/development.ts';

type Connection = 'online' | 'offline' | 'server';
type CardKind = 'temporary' | 'saved';
interface StudyState { connection: Connection; kind: CardKind; pending: boolean; notice: '' | 'offline' }

// A stand simulation: the clock represents acknowledgement, never a server write.
export function createSharedChartStudy(onChange: (state: StudyState) => void,
  schedule: (callback: () => void) => ReturnType<typeof setTimeout> = callback => setTimeout(callback, 750),
  unschedule: (timer: ReturnType<typeof setTimeout>) => void = clearTimeout) {
  let state: StudyState = { connection: 'online', kind: 'temporary', pending: false, notice: '' };
  let timer: ReturnType<typeof setTimeout> | undefined, version = 0;
  const emit = () => onChange({ ...state });
  function stopClock() { version++; if (timer !== undefined) unschedule(timer); timer = undefined; }
  function advance() {
    stopClock();
    if (!state.pending || state.connection !== 'online') return;
    const expected = version;
    timer = schedule(() => {
      if (expected !== version || !state.pending || state.connection !== 'online') return;
      timer = undefined;
      state = { ...state, kind: 'saved', pending: false, notice: '' }; emit();
    });
  }
  return {
    get state() { return { ...state }; },
    add() {
      if (state.kind === 'saved' || state.pending) return;
      state = { ...state, pending: state.connection !== 'offline', notice: state.connection === 'offline' ? 'offline' : '' };
      advance(); emit();
    },
    setConnection(connection: Connection) {
      state = { ...state, connection, notice: '' }; advance(); emit();
    },
    setKind(kind: CardKind) { stopClock(); state = { ...state, kind, pending: false, notice: '' }; emit(); },
    cancel() { stopClock(); state = { ...state, pending: false, notice: '' }; emit(); },
    dismiss() { state = { ...state, notice: '' }; emit(); },
  };
}

// Stand-only visual study: no saving, sharing, account writes or URL changes.
if (typeof location !== 'undefined' && isDevelopmentPort(location.port)) {
  const panelCaption = document.querySelector('#summaryChartCaption .summary-moment-heading');
  if (panelCaption) {
    const style = document.createElement('style');
    style.textContent = `
      .shared-chart-study { display: flex; align-items: center; gap: var(--chart-control-gap); position: static; margin: 0; pointer-events: auto; }
      .shared-chart-study[hidden] { display: flex !important; visibility: hidden; pointer-events: none; }
      .summary-chart-actions { position: relative; display: flex; flex: none; align-items: center; gap: var(--chart-control-gap); }
      .summary-title:has(.summary-comparison:not([hidden])) .summary-chart-actions { display: none; }
      .summary-chart-actions button:disabled { opacity: .45; cursor: default; }
      .shared-chart-study-options { display: none; flex: 0 0 100%; min-width: 0; padding: 0 0 10px; margin: 0 0 2px; border-bottom: 1px solid var(--panel-border); gap: 8px; }
      body:has(.studio[data-workspace-screen='chart']) .shared-chart-study-options { display: grid; }
      .shared-study-choices { display: flex; gap: 5px; flex-wrap: wrap; }
      .shared-study-choices button { min-height: 32px; padding: 5px 8px; border: 1px solid var(--panel-border); border-radius: 6px; background: transparent; color: var(--panel-ink); font: 11px/16px var(--sans); }
      .shared-study-choices button[aria-pressed='true'] { border-color: #89654a; background: #efe5da; color: #68472f; box-shadow: inset 0 0 0 1px #89654a; }
      .shared-study-choices button:focus-visible { outline: 1px dashed #68472f; outline-offset: 2px; }
      .summary-title:has(.summary-comparison:not([hidden])) .shared-chart-send { display: none; }
      .app-shell[data-page-state='loading'] :is(.shared-chart-study, .shared-chart-send) { visibility: hidden; pointer-events: none; }
    `;
    style.textContent += `
      .shared-chart-message[data-floating='true'] {
        position: absolute; z-index: 10; top: calc(100% + 8px); left: 0;
        display: grid; grid-template-columns: 16px minmax(0, 1fr) auto; align-items: center; column-gap: 8px;
        box-sizing: border-box; width: min(248px, calc(100vw - 48px)); margin: 0; padding: 10px;
        border: 1px solid var(--panel-border); border-radius: var(--floating-control-radius);
        color: var(--panel-ink); background: var(--canvas-background); box-shadow: 0 2px 8px #3028240a;
        font-family: var(--sans); animation: shared-notice-in .12s ease-out;
      }
      .shared-chart-study > .shared-chart-message { right: 0; left: auto; }
      .shared-chart-message-copy { display: contents; }
      .shared-chart-message-copy svg { width: 16px; height: 16px; color: var(--panel-muted); }
      .shared-chart-message p { min-width: 0; margin: 0; font-size: 12px; line-height: 17px; font-weight: 500; overflow-wrap: anywhere; }
      .shared-message-title { display: block; }
      .shared-message-retry { display: block; margin-top: 2px; color: var(--panel-muted); font-size: 11px; line-height: 15px; font-weight: 400; }
      .shared-chart-study :is(.shared-chart-message-cancel, .shared-chart-message-close) {
        position: relative; align-self: stretch; height: auto; min-height: 28px; margin: 0; padding: 0 0 0 9px;
        border: 0; border-left: 1px solid var(--panel-border); border-radius: 0; background: transparent;
        color: #68472f; font-size: 11px; line-height: 16px; font-weight: 500; box-shadow: none;
      }
      .shared-chart-study .shared-chart-message-close { width: 27px; color: var(--panel-muted); }
      .shared-chart-study :is(.shared-chart-message-cancel, .shared-chart-message-close)::before { content: ''; position: absolute; inset: -8px -5px; }
      .shared-chart-study :is(.shared-chart-message-cancel, .shared-chart-message-close):is(:hover, :active) { color: var(--panel-ink); border-color: var(--panel-border); box-shadow: none; }
      .shared-chart-study .shared-chart-message-cancel:hover { text-decoration: underline; text-underline-offset: 3px; }
      @keyframes shared-notice-in { from { opacity: 0; } to { opacity: 1; } }
      @media (prefers-reduced-motion: reduce) { .shared-chart-message[data-floating='true'] { animation: none; } }
    `;
    style.textContent += `
      .shared-chart-send > .shared-chart-copy-notice[data-floating='true'] {
        right: 0; left: auto; width: max-content; max-width: calc(100vw - 24px);
        grid-template-columns: 16px minmax(0, 1fr); pointer-events: none; text-align: left;
        font-size: 12px; line-height: 17px; font-weight: 500; white-space: normal;
      }
      .shared-chart-copy-notice svg { color: #50634a; }
    `;
    style.textContent += `
      .shared-chart-add-wrap { display: inline-flex; position: relative; }
      .shared-chart-add-wrap[data-unavailable='true'] .shared-chart-add { pointer-events: none; }
      .shared-chart-add-wrap:focus-visible { outline: 1px dashed var(--control-focus); outline-offset: 3px; border-radius: var(--floating-control-radius); }
    `;
    document.head.append(style);
    for (const host of [panelCaption]) {
      const group = document.createElement('div');
      group.className = 'shared-chart-study';
      group.innerHTML = `
        <button type="button" class="shared-chart-add" aria-label="Добавить карту" title="Добавить карту">
          <svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M10 4.5v11M4.5 10h11" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>
        </button>
        <button type="button" class="shared-chart-send" aria-label="Скопировать ссылку" title="Скопировать ссылку">
          <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="m10 13 4-4M8 16l-1 1a4 4 0 0 1-6-6l4-4a4 4 0 0 1 6 0m2 1 1-1a4 4 0 0 1 6 6l-4 4a4 4 0 0 1-6 0" transform="translate(1 0)" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </button>`;
      const add = group.querySelector<HTMLButtonElement>('.shared-chart-add')!;
      const wrap = document.createElement('span');
      wrap.className = 'shared-chart-add-wrap';
      const description = document.createElement('span');
      description.className = 'visually-hidden'; description.id = 'sharedOfflineDescription';
      description.textContent = 'Нет соединения';
      add.before(wrap); wrap.append(add, description);
      const send = group.querySelector('.shared-chart-send')!;
      const actions = document.createElement('div');
      actions.className = 'summary-chart-actions';
      group.hidden = true;
      actions.append(send, group); host.append(actions);

    }

    const groups = Array.from(document.querySelectorAll<HTMLElement>('.shared-chart-study'));
    const palettes = document.getElementById('controlColorPreviews');
    if (palettes) {
      const options = document.createElement('div');
      options.className = 'shared-chart-study-options';
      options.innerHTML = `<div class="shared-study-choices" role="group" aria-label="Карта">
        <button type="button" data-kind="temporary">Временная карта</button>
        <button type="button" data-kind="saved">В картотеке</button>
      </div>`;
      palettes.prepend(options);
      const clockIcon = '<circle cx="10" cy="10" r="6.5"/><path d="M10 6v4l2.5 1.5"/>';
      const errorIcon = '<circle cx="10" cy="10" r="6.5"/><path d="M10 6v4.5M10 13.2v.1"/>';
      const study = createSharedChartStudy(render);
      // Both action messages stay within the panel that clips their contents.
      function placeNotice(notice: HTMLElement) {
        notice.style.transform = '';
        const panel = notice.closest('.chart-summary')?.getBoundingClientRect();
        const left = Math.max(8, (panel?.left ?? 0) + 8);
        const right = Math.min(document.documentElement.clientWidth - 8, (panel?.right ?? document.documentElement.clientWidth) - 8);
        const rect = notice.getBoundingClientRect();
        const shift = Math.max(left - rect.left, Math.min(0, right - rect.right));
        if (shift) notice.style.transform = `translateX(${shift}px)`;
      }
      window.addEventListener('resize', () => requestAnimationFrame(() => {
        document.querySelectorAll<HTMLElement>('.shared-chart-message').forEach(placeNotice);
      }));
      // The agreed stand rehearsal changes only feedback, not the clipboard.
      let shareTimer: ReturnType<typeof setTimeout> | undefined;
      function closeShare() {
        if (shareTimer !== undefined) clearTimeout(shareTimer);
        shareTimer = undefined;
        document.querySelectorAll('.shared-chart-copy-notice').forEach(notice => notice.remove());
      }
      document.querySelectorAll<HTMLButtonElement>('.shared-chart-send').forEach(button => {
        button.addEventListener('click', () => {
          closeShare();
          const notice = document.createElement('span');
          notice.className = 'shared-chart-message shared-chart-copy-notice';
          notice.dataset.floating = 'true'; notice.setAttribute('role', 'status');
          notice.innerHTML = '<svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="m4 10 4 4 8-8" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round"/></svg><span>Ссылка скопирована</span>';
          button.append(notice);
          placeNotice(notice);
          shareTimer = setTimeout(closeShare, 2000);
        });
      });

      function restoreAddFocus(group: HTMLElement) {
        const add = group.querySelector<HTMLButtonElement>('.shared-chart-add')!;
        const target = add.disabled ? group.querySelector<HTMLElement>('.shared-chart-add-wrap')! : add;
        target.focus({ preventScroll: true });
      }

      function render(state: StudyState) {
        options.querySelectorAll<HTMLElement>('[data-kind]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.kind === state.kind)));
        for (const group of groups) {
          group.querySelector('.shared-chart-message')?.remove();
          group.hidden = state.kind === 'saved';
          const add = group.querySelector<HTMLButtonElement>('.shared-chart-add')!;
          add.disabled = state.pending || state.connection === 'offline';
          const wrap = group.querySelector<HTMLElement>('.shared-chart-add-wrap')!;
          const unavailable = state.connection === 'offline' && !state.pending;
          wrap.dataset.unavailable = String(unavailable);
          wrap.title = unavailable ? 'Нет соединения' : '';
          add.title = unavailable ? '' : 'Добавить карту';
          if (unavailable) {
            wrap.tabIndex = 0; wrap.setAttribute('role', 'group'); wrap.setAttribute('aria-label', 'Добавить карту');
            wrap.setAttribute('aria-describedby', wrap.querySelector('.visually-hidden')!.id);
            add.setAttribute('aria-describedby', wrap.querySelector('.visually-hidden')!.id);
          } else {
            wrap.removeAttribute('tabindex'); wrap.removeAttribute('role'); wrap.removeAttribute('aria-label'); wrap.removeAttribute('aria-describedby');
            add.removeAttribute('aria-describedby');
          }
          add.setAttribute('aria-busy', String(state.pending));
          if (!state.pending && !state.notice) continue;
          const message = document.createElement('div');
          message.className = 'shared-chart-message';
          message.dataset.floating = 'true';
          const text = !state.pending || state.connection === 'offline' ? 'Нет соединения'
            : state.connection === 'server' ? 'Ошибка на сервере. Пробуем ещё раз…' : 'Сохраняем карту…';
          const icon = state.pending && state.connection === 'online' ? clockIcon : errorIcon;
          message.innerHTML = '<div class="shared-chart-message-copy" role="status"><svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><g stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round">' + icon + '</g></svg><p></p></div>';
          const paragraph = message.querySelector('p')!;
          if (state.pending && state.connection === 'server') paragraph.innerHTML = '<span class="shared-message-title">Ошибка на сервере</span><span class="shared-message-retry">Пробуем ещё раз…</span>';
          else paragraph.textContent = text;
          if (state.pending) {
            const cancel = document.createElement('button');
            cancel.type = 'button'; cancel.className = 'shared-chart-message-cancel'; cancel.textContent = 'Прервать';
            cancel.addEventListener('click', () => { study.cancel(); restoreAddFocus(group); });
            message.append(cancel);
          } else {
            const close = document.createElement('button');
            close.type = 'button'; close.className = 'shared-chart-message-close'; close.setAttribute('aria-label', 'Закрыть');
            close.innerHTML = '<svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="m6 6 8 8m0-8-8 8" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>';
            close.addEventListener('click', () => { study.dismiss(); restoreAddFocus(group); });
            message.append(close);
          }
          group.append(message);
          placeNotice(message);
        }
      }
      options.addEventListener('click', event => {
        const button = (event.target as Element).closest<HTMLButtonElement>('button');
        if (button?.dataset.kind) { closeShare(); study.setKind(button.dataset.kind as CardKind); }
      });
      groups.forEach(group => group.querySelector('.shared-chart-add')!.addEventListener('click', () => study.add()));
      document.addEventListener('click', event => {
        const target = event.target as Element;
        // Stand switches remain usable to rehearse recovery of a pending action.
        if (target.closest('.shared-chart-study, #controlColorPreviews')) return;
        if (study.state.pending) study.cancel();
        else if (study.state.notice) study.dismiss();
        closeShare();
        const focused = document.activeElement as HTMLElement | null;
        if (focused?.matches('.shared-chart-add-wrap')) focused.blur();
      }, { capture: true });
      document.addEventListener('keydown', event => {
        if (event.key !== 'Escape') return;
        closeShare();
        if (!study.state.pending && !study.state.notice) return;
        event.preventDefault(); event.stopPropagation();
        const focusedMessage = document.activeElement?.closest('.shared-chart-message');
        const focusedGroup = focusedMessage?.closest<HTMLElement>('.shared-chart-study');
        if (study.state.pending) study.cancel(); else study.dismiss();
        if (focusedGroup) restoreAddFocus(focusedGroup);
      }, { capture: true });
      standConnection.subscribe(mode => study.setConnection(mode));
      const transitButton = document.getElementById('nowButton');
      const isTransit = () => transitButton?.getAttribute('aria-pressed') === 'true';
      let previousTransit = isTransit();
      if (previousTransit) study.setKind('temporary');
      if (transitButton) new MutationObserver(() => {
        const transit = isTransit();
        if (transit === previousTransit) return;
        previousTransit = transit;
        closeShare(); study.setKind(transit ? 'temporary' : 'saved');
      }).observe(transitButton, { attributes: true, attributeFilter: ['aria-pressed'] });
      const title = document.getElementById('chartTitle');
      if (title) {
        let previousTitle = title.textContent;
        new MutationObserver(() => {
          if (title.textContent === previousTitle) return;
          previousTitle = title.textContent;
          closeShare(); study.setKind(isTransit() ? 'temporary' : 'saved');
        }).observe(title, { childList: true, characterData: true, subtree: true });
      }
    }
  }
}
