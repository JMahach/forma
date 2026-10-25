import { actionAvailability } from '../ui/action-state.ts';
import { createActionNotice, type ActionNoticeHandle } from '../ui/feedback.ts';
import { UI_MESSAGES } from '../ui/messages.ts';
import { PALETTE } from '../ui/chart-palette.ts';
import { chartHighlight } from '../state/chart-highlight.ts';
import { standConnection } from './stand-connection.ts';
import { isDevelopmentPort } from '../../shared/development.ts';

type Connection = 'online' | 'offline' | 'server';
type CardKind = 'temporary' | 'saved';
interface StudyState { connection: Connection; kind: CardKind; pending: boolean; notice: '' | 'offline' }

// A stand simulation: the clock represents acknowledgement, never a server write.
export function createSharedChartStudy(onChange: (state: StudyState, action?: 'add') => void,
  schedule: (callback: () => void) => ReturnType<typeof setTimeout> = callback => setTimeout(callback, 750),
  unschedule: (timer: ReturnType<typeof setTimeout>) => void = clearTimeout) {
  let state: StudyState = { connection: 'online', kind: 'temporary', pending: false, notice: '' };
  let timer: ReturnType<typeof setTimeout> | undefined, version = 0;
  const emit = (action?: 'add') => onChange({ ...state }, action);
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
      advance(); emit('add');
    },
    setConnection(connection: Connection) {
      state = { ...state, connection, notice: '' }; advance(); emit();
    },
    setKind(kind: CardKind) { stopClock(); state = { ...state, kind, pending: false, notice: '' }; emit(); },
    cancel() { stopClock(); state = { ...state, pending: false, notice: '' }; emit(); },
    dismiss() { state = { ...state, notice: '' }; emit(); },
  };
}

interface SharedChartMessagePorts {
  add: HTMLElement; copy: HTMLElement; boundary?: HTMLElement;
  getState: () => StudyState; copyOutcome: () => string;
  cancel: () => void; dismiss: () => void; returnAddFocus?: () => HTMLElement;
}
// The action owns its continuation; the shared shell owns the single visible notice.
export function createSharedChartMessages(surface: ReturnType<typeof createActionNotice>, ports: SharedChartMessagePorts) {
  let adding: ActionNoticeHandle | undefined, copying: ActionNoticeHandle | undefined;
  function render(state: StudyState, action?: 'add') {
    if (!state.pending && !state.notice) { adding?.close(); return; }
    const message = {
      message: !state.pending || state.connection === 'offline' ? UI_MESSAGES.offline : UI_MESSAGES.chartSaving,
      detail: state.pending && state.connection === 'server' ? UI_MESSAGES.serverUnavailable : undefined,
      tone: state.connection === 'offline' ? 'error' as const : 'neutral' as const,
      busy: state.pending,
      actions: [{label: state.pending ? 'Прервать' : 'Закрыть',run: () => {
        adding?.close(true);
        if (ports.getState().pending) ports.cancel(); else ports.dismiss();
        (ports.returnAddFocus?.() || ports.add).focus({preventScroll:true});
      }}],
    };
    if (adding?.active) adding.update(message);
    // Background results may update their own notice; a new action may replace it.
    else if (action === 'add' || !copying?.active) adding = surface.show(ports.add,message,{
      boundary:ports.boundary,returnFocus:ports.returnAddFocus,
      onDismiss:()=>{if(ports.getState().pending) ports.cancel(); else ports.dismiss();},
    });
  }
  const resume = () => render(ports.getState());
  function copy() {
    const error = ports.copyOutcome() === 'error';
    copying = surface.show(ports.copy, {
      message:error ? UI_MESSAGES.linkCopyFailed : UI_MESSAGES.linkCopied,
      tone:error ? 'error' : 'success',
    },{boundary:ports.boundary,durationMs:2000,compact:true,placement:'above',onDismiss:resume,onExpire:resume});
  }
  return {render,copy,close:()=>{adding?.close();copying?.close();}};
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
      .shared-chart-study-options { position: relative; display: none; flex: 0 0 100%; min-width: 0; padding: 0 0 10px; margin: 0 0 2px; border-bottom: 1px solid var(--panel-border); gap: 8px; }
      body:has(.studio[data-workspace-screen='chart']) .shared-chart-study-options { position: relative; display: grid; }
      .shared-chart-study-options > .chart-highlight-switch {
        position: absolute; right: 0; top: 0; width: 44px; height: 32px;
        display: grid; place-items: center; padding: 0; border: 0;
        border-radius: 6px; background: transparent; cursor: pointer;
        touch-action: manipulation;
      }
      .chart-highlight-track {
        display: block; position: relative; width: 34px; height: 20px;
        border: 1px solid var(--panel-border); border-radius: 999px;
        background: var(--panel-bg, #f3f0e8);
      }
      .chart-highlight-thumb {
        position: absolute; left: 2px; top: 2px; width: 14px; height: 14px;
        display: grid; place-items: center; border-radius: 50%;
        background: ${PALETTE.halo}; color: #202020; font: 500 9px/1 system-ui;
        transition: transform 100ms ease-out;
      }
      .chart-highlight-switch[aria-checked="true"] .chart-highlight-thumb { transform: translateX(14px); }
      .chart-highlight-switch:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
      @media (prefers-reduced-motion: reduce) { .chart-highlight-thumb { transition: none; } }
      .shared-study-choices { display: flex; gap: 5px; flex-wrap: wrap; }
      .shared-study-choices button { min-height: 32px; padding: 5px 8px; border: 1px solid var(--panel-border); border-radius: 6px; background: transparent; color: var(--panel-ink); font: 11px/16px var(--sans); }
      .shared-study-choices button[aria-pressed='true'] { border-color: #89654a; background: #efe5da; color: #68472f; box-shadow: inset 0 0 0 1px #89654a; }
      .shared-study-choices button:focus-visible { outline: 1px dashed #68472f; outline-offset: 2px; }
      .summary-title:has(.summary-comparison:not([hidden])) .shared-chart-send { display: none; }
      .app-shell[data-page-state='loading'] :is(.shared-chart-study, .shared-chart-send) { visibility: hidden; pointer-events: none; }
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
      const highlightSwitch = document.createElement('button');
      highlightSwitch.type = 'button';
      highlightSwitch.className = 'chart-highlight-switch';
      highlightSwitch.setAttribute('role', 'switch');
      highlightSwitch.setAttribute('aria-label', 'Подсветка 1 / 2');
      highlightSwitch.innerHTML = '<span class="chart-highlight-track" aria-hidden="true"><span class="chart-highlight-thumb"></span></span>';
      options.append(highlightSwitch);
      const highlightKey = 'forma.chart-highlight.v1';
      try { chartHighlight.set(sessionStorage.getItem(highlightKey)); } catch {}
      const showHighlight = () => {
        const outline = chartHighlight.current === 'outline';
        highlightSwitch.setAttribute('aria-checked', String(outline));
        highlightSwitch.querySelector('.chart-highlight-thumb')!.textContent = outline ? '2' : '1';
      };
      showHighlight();
      chartHighlight.subscribe(() => {
        showHighlight();
        try { sessionStorage.setItem(highlightKey, chartHighlight.current); } catch {}
      });
      highlightSwitch.addEventListener('click', () => chartHighlight.set(chartHighlight.current === 'outline' ? 'glow' : 'outline'));
      const copySetting = document.createElement('div'); copySetting.className = 'shared-copy-setting';
      let copyOutcome = 'success';
      const copyChoices = document.createElement('div');
      copyChoices.className = 'stand-connection-options shared-copy-options';
      copyChoices.setAttribute('role', 'group'); copyChoices.setAttribute('aria-label', 'Результат копирования');
      for (const [value, label] of [['success', 'Успешное копирование'], ['error', 'Ошибка копирования']]) {
        const button = document.createElement('button');
        button.type = 'button'; button.textContent = label;
        button.setAttribute('aria-pressed', String(value === copyOutcome));
        button.addEventListener('click', () => {
          copyOutcome = value;
          for (const choice of copyChoices.querySelectorAll('button')) choice.setAttribute('aria-pressed', String(choice === button));
        });
        copyChoices.append(button);
      }
      copySetting.append(copyChoices); options.append(copySetting);
      palettes.prepend(options);
      const surface = createActionNotice(document.querySelector<HTMLElement>('.app-shell')!);
      const study = createSharedChartStudy(render);
      const group = groups[0];
      const messages = createSharedChartMessages(surface, {
        add:group.querySelector<HTMLElement>('.shared-chart-add')!,
        copy:document.querySelector<HTMLElement>('.shared-chart-send')!,
        boundary:group.closest<HTMLElement>('.chart-summary') || undefined,
        getState:()=>study.state,copyOutcome:()=>copyOutcome,
        cancel:()=>study.cancel(),dismiss:()=>study.dismiss(),
        returnAddFocus:()=>addFocusTarget(group),
      });
      document.querySelectorAll<HTMLButtonElement>('.shared-chart-send').forEach(button => {
        button.addEventListener('click', messages.copy);
      });

      function addFocusTarget(group: HTMLElement) {
        const add = group.querySelector<HTMLButtonElement>('.shared-chart-add')!;
        const target = add.disabled ? group.querySelector<HTMLElement>('.shared-chart-add-wrap')! : add;
        return target;
      }

      function render(state: StudyState, action?: 'add') {
        options.querySelectorAll<HTMLElement>('[data-kind]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.kind === state.kind)));
        for (const group of groups) {
          group.hidden = state.kind === 'saved';
          const add = group.querySelector<HTMLButtonElement>('.shared-chart-add')!;
          const availability = actionAvailability({ connection: state.connection, requiresConnection: true, pending: state.pending });
          add.disabled = availability.disabled;
          const wrap = group.querySelector<HTMLElement>('.shared-chart-add-wrap')!;
          const unavailable = Boolean(availability.reason);
          wrap.dataset.unavailable = String(unavailable);
          wrap.querySelector<HTMLElement>('.visually-hidden')!.hidden = !unavailable;
          wrap.title = availability.reason;
          add.title = unavailable ? '' : 'Добавить карту';
          if (unavailable) {
            wrap.tabIndex = 0; wrap.setAttribute('role', 'group'); wrap.setAttribute('aria-label', 'Добавить карту');
            wrap.setAttribute('aria-describedby', wrap.querySelector('.visually-hidden')!.id);

          } else {
            wrap.removeAttribute('tabindex'); wrap.removeAttribute('role'); wrap.removeAttribute('aria-label'); wrap.removeAttribute('aria-describedby');

          }
          const hintId = wrap.querySelector('.visually-hidden')!.id;
          const descriptions = new Set((add.getAttribute('aria-describedby') || '').split(/\s+/).filter(Boolean));
          descriptions.delete(hintId); if (unavailable) descriptions.add(hintId);
          if (descriptions.size) add.setAttribute('aria-describedby',[...descriptions].join(' '));
          else add.removeAttribute('aria-describedby');
          add.setAttribute('aria-busy', String(availability.busy));
        }
        messages.render(state,action);
      }
      options.addEventListener('click', event => {
        const button = (event.target as Element).closest<HTMLButtonElement>('button');
        if (button?.dataset.kind) { messages.close(); study.setKind(button.dataset.kind as CardKind); }
      });
      groups.forEach(group => group.querySelector('.shared-chart-add')!.addEventListener('click', () => study.add()));
      document.addEventListener('click', event => {
        const target = event.target as Element;
        // Stand switches remain usable to rehearse recovery of a pending action.
        if (target.closest('.summary-chart-actions, #controlColorPreviews') || surface.contains(target)) return;
        if (study.state.pending) study.cancel();
        else if (study.state.notice) study.dismiss();
        messages.close();
        const focused = document.activeElement as HTMLElement | null;
        if (focused?.matches('.shared-chart-add-wrap')) focused.blur();
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
        messages.close(); study.setKind(transit ? 'temporary' : 'saved');
      }).observe(transitButton, { attributes: true, attributeFilter: ['aria-pressed'] });
      const title = document.getElementById('chartTitle');
      if (title) {
        let previousTitle = title.textContent;
        new MutationObserver(() => {
          if (title.textContent === previousTitle) return;
          previousTitle = title.textContent;
          messages.close(); study.setKind(isTransit() ? 'temporary' : 'saved');
        }).observe(title, { childList: true, characterData: true, subtree: true });
      }
    }
  }
}
