import { createActionNotice, type ActionNoticeHandle } from '../../../src/ui/feedback.ts';
import { UI_MESSAGES } from '../../../src/ui/messages.ts';

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
