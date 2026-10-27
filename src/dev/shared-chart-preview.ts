import { createActionNotice, type ActionNoticeHandle } from '../ui/feedback.ts';
import { UI_MESSAGES } from '../ui/messages.ts';
import { PALETTE } from '../ui/chart-palette.ts';
import { chartHighlight } from '../state/chart-highlight.ts';
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

// Stand-only copy feedback and colour choices. The real add control and its
// state belong to app.ts; the stand never creates or simulates another add.
if (typeof location !== 'undefined' && isDevelopmentPort(location.port)) {
  const actions = document.querySelector<HTMLElement>('#summaryChartCaption .summary-chart-actions');
  if (actions) {
    const style = document.createElement('style');
    style.textContent = `
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
    `;
    document.head.append(style);
    const send=document.createElement('button');send.type='button';send.className='shared-chart-send';
    send.setAttribute('aria-label','Скопировать ссылку');send.title='Скопировать ссылку';
    send.innerHTML='<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="m10 13 4-4M8 16l-1 1a4 4 0 0 1-6-6l4-4a4 4 0 0 1 6 0m2 1 1-1a4 4 0 0 1 6 6l-4 4a4 4 0 0 1-6 0" transform="translate(1 0)" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    actions.prepend(send);
    const palettes = document.getElementById('controlColorPreviews');
    if (palettes) {
      const options = document.createElement('div');options.className = 'shared-chart-study-options';
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
      send.addEventListener('click',()=>{
        const error=copyOutcome==='error';
        surface.show(send,{message:error?UI_MESSAGES.linkCopyFailed:UI_MESSAGES.linkCopied,tone:error?'error':'success'},
          {boundary:send.closest<HTMLElement>('.chart-summary') || undefined,durationMs:2000,compact:true,placement:'above'});
      });
    }
  }
}
