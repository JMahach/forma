import { createResourceScope } from '../runtime/resource-scope.ts';
import { normalizeLifetimeDraft, type SavedLifetimeDraft } from '../domain/input-draft.ts';
import { captureTextSelection, restoreTextSelection, watchTextSelection } from './input-selection.ts';
import { UI_MESSAGES, failureMessage } from '../ui/messages.ts';
import type { ChartRecord } from '../../shared/chart-types.ts';
import type { MomentTimeline, MomentTimelineState, MomentTimelineBounds, MomentState } from '../state/moment-timeline.ts';
import type { LiveTransitState } from '../state/live-transit.ts';
import type { StudioLayout } from '../ui/layout/studio-controller.ts';
import type { TimelineRangeOptions } from './timeline-range.ts';
import type { DatePicker } from './date-picker.ts';
interface VisibleWindow extends MomentTimelineBounds { calendar?: boolean; timeZone?: string }
interface DateSubmission { from: string | null; to: string | null; fromText: string; toText: string; allowOpenEnd: boolean; allowOpenStart: boolean }
interface LifetimeControlsOptions {
  onDraftChange?: () => void;
  explorer: MomentTimeline; panel: HTMLElement; range: HTMLInputElement; fromDate: HTMLInputElement; toDate: HTMLInputElement; status: HTMLElement;
  fromError?: HTMLElement | null; toError?: HTMLElement | null; hourMarks?: HTMLElement | null;
  fromCalendar?: HTMLButtonElement | null; toCalendar?: HTMLButtonElement | null; marker?: HTMLButtonElement | null;
  viewportLayout: Pick<StudioLayout, 'readViewport' | 'subscribeViewport'>;
  getDayState?: () => LiveTransitState | null; getMomentState?: () => MomentState | null | undefined; getPersonalRecord?: () => Partial<ChartRecord> | null;
  onDayScrub?: (value: number) => void; onDayNow?: () => void; onLifetimeNow?: () => boolean; beforeScrub?: (utc: number) => boolean | void;
  formatEndpoints?: (state: MomentTimelineState) => [string, string] | null; onMomentInput?: () => void; resolveTap?: TimelineRangeOptions['resolveTap'];
}
export type LifetimeControls = ReturnType<typeof attachLifetimeControls>;

import { bindNumericInput, datePartAt, formatDateInput, normalizeDate } from './date-input.ts';
import { attachTimelineRange, isReferenceMoment } from './timeline-range.ts';
import { attachTimelineMarks } from './timeline-marks.ts';
import { attachDatePicker } from './date-picker.ts';
import { formatTimelineMinute, localDateAt, timelineMinute } from '../domain/day-timeline.ts';
import { setText } from '../ui/html.ts';

function clock(utc: number | string | null | undefined, timeZone: string | null | undefined = null) {
  const value = typeof utc === 'number' ? utc : Date.parse(utc!);
  if (!Number.isFinite(value)) return null;
  const iso = new Date(value).toISOString();
  if (timeZone) {
    const local = formatTimelineMinute({ startUtc: value, minutes: 1, timeZone }, 0);
    return { date: formatDateInput(localDateAt(value, timeZone)), time: local.time, zone: local.offset, utc: iso };
  }
  const time = value % 60000 === 0 ? iso.slice(11, 16) : iso.slice(11, 23).replace(/\.000$/, '');
  return { date: formatDateInput(iso.slice(0, 10)), time, zone: 'UTC', utc: iso };
}

export function attachLifetimeControls({ explorer, panel, range, fromDate, toDate, status, fromError = null, toError = null,
  hourMarks = null, fromCalendar = null, toCalendar = null, marker = null, viewportLayout,
  getDayState = () => null, getMomentState = () => null, getPersonalRecord = () => null,
  onDayScrub = () => {}, onDayNow = () => {}, onLifetimeNow = () => false, beforeScrub = () => {},
  formatEndpoints = () => null, onMomentInput = () => {}, onDraftChange = () => {}, resolveTap }: LifetimeControlsOptions) {
  const scope=createResourceScope();
  const marks = panel.querySelectorAll('[data-lifetime-date]');
  const rangeLabel = panel.querySelectorAll('label[for="lifetimeTime"]')[0];
  const inputs = [fromDate, toDate], dirty = new Set<HTMLInputElement>();
  const dateErrors = new Map([[fromDate, fromError], [toDate, toError]]);
  let inputError = false, submitted: DateSubmission | null = null, wasOpened = false, waitingForMetadata = false;
  let momentClockShown = false;
  let visibleWindow: VisibleWindow | null = null;
  const calendars: DatePicker[] = [];
  const timelineMarks = attachTimelineMarks(hourMarks,scope.signal);
  function scrub(value: number) {
    if (!explorer.state.opened) return;
    onMomentInput();
    if (beforeScrub(value) === false) return;
    if (explorer.state.mode === 'transit-day') onDayScrub(value);
    else {
      explorer.scrub(value, visibleWindow);
      // A no-op request between available samples still restores the accepted
      // UTC position after the native input has moved its thumb.
      range.value = String(explorer.state.requestedUtc);
    }
  }
  const dayRange = attachTimelineRange({ range, marker, resolveTap, signal:scope.signal, onScrub: scrub,
    onInteractionChange: active => explorer.setInteracting(active),
    resolveEdge({ min, max, value }) {
      const state = explorer.state;
      if (range.disabled || state.mode !== 'range' || !state.metadata || value !== state.requestedUtc || value < min || value > max) return null;
      // Only the existing time owner knows the last available cached/grid point.
      const previous = explorer.adjacentUtc(-1), next = explorer.adjacentUtc(1);
      if (Number.isFinite(previous) && (previous === value || previous! < min)) return 'start';
      if (Number.isFinite(next) && (next === value || next! > max)) return 'end';
      return null;
    },
    onStep(direction) {
      if (explorer.state.mode === 'range') {
        onMomentInput();
        void explorer.step(direction, visibleWindow, beforeScrub);
        range.value = String(explorer.state.requestedUtc);
        return null;
      }
      const day = getDayState();
      return Math.max(0, Math.min((day?.timeline?.minutes ?? 1) - 1, (day?.index ?? 0) + direction));
    },
    onReference() {
      if (!explorer.state.opened) return;
      onMomentInput();
      if (explorer.state.mode === 'range' && onLifetimeNow() === true) return;
      const reference = explorer.state.mode === 'transit-day' ? getDayState()?.referenceIndex : explorer.state.referenceUtc;
      if (beforeScrub(reference!) === false) return;
      if (explorer.state.mode === 'transit-day') onDayNow();
      else explorer.goNow();
    },
  });

  function matchingPending(pending = submitted, edited: HTMLInputElement | null = null) {
    return pending && (edited === fromDate || pending.fromText === fromDate.value)
      && (edited === toDate || pending.toText === toDate.value) ? pending : null;
  }

  function updateDates(state: MomentTimelineState, preparingDate: string | false | null | undefined = null) {
    if (submitted && state.fromDate === submitted.from && state.toDate === submitted.to) {
      if (fromDate.value === submitted.fromText) dirty.delete(fromDate);
      if (toDate.value === submitted.toText) dirty.delete(toDate);
      submitted = null;
    }
    fromDate.placeholder = state.openStart && !preparingDate ? 'С начала' : 'ДД.ММ.ГГГГ';
    toDate.placeholder = state.openEnded && !preparingDate ? 'До конца' : 'ДД.ММ.ГГГГ';
    for (const [input, value] of [[fromDate, preparingDate || state.fromDate], [toDate, preparingDate || state.toDate]] as const) {
      // Keep active edits intact; blur restores rejected drafts from this state.
      if (!dirty.has(input) && panel.ownerDocument.activeElement !== input && value) {
        const open = input === fromDate ? state.openStart : state.openEnded;
        const formatted = open && !preparingDate ? '' : formatDateInput(value);
        if (input.value !== formatted) input.value = formatted;
      }
    }
    const endpoints = !preparingDate && state.opened && state.mode === 'range' ? formatEndpoints(state)
      ?? [formatDateInput(state.fromDate), formatDateInput(state.toDate)] : ['', ''];
    if (marks[0]) setText(marks[0], endpoints[0]);
    if (marks[1]) setText(marks[1], endpoints[1]);
  }

  function update(state: MomentTimelineState, momentState:MomentState|null|undefined = undefined) {
    if(scope.stopped)return;
    if(momentState===undefined)momentState=getMomentState();
    if (wasOpened && !state.opened) {
      calendars.forEach(calendar => calendar.close()); submitted = null; waitingForMetadata = false;
      inputs.forEach(restoreDate);
      inputs.find(input => input.ownerDocument.activeElement === input)?.blur();
    }
    wasOpened = state.opened;
    panel.hidden = !state.opened;
    const preparing = state.status === 'preparing';
    const transitDay = getDayState();
    const dayMode = state.mode === 'transit-day' || preparing && Boolean(transitDay);
    if (rangeLabel) setText(rangeLabel, dayMode ? 'Шкала дня: время транзита' : 'Шкала выбранных лет: время UTC');
    if (dayMode || !state.opened) momentState = null;
    momentClockShown = Boolean(momentState);
    const day = dayMode ? transitDay : null;
    const dayReady = day?.status === 'ready' && Boolean(day.timeline);
    // A ready chart cannot acknowledge a file that has not opened yet.
    const fileStatus = !state.metadata && ['loading', 'preparing', 'error'].includes(state.status);
    const requestStatus = fileStatus ? state.status : momentState ? momentState.status : dayMode && ['idle', 'loading', 'error'].includes(day?.status!) ? day!.status : state.status;
    const retryCount = (fileStatus ? state : momentState || (dayMode ? day : state))?.retryCount ?? 0;
    const displayStatus = requestStatus === 'error' && retryCount > 0 ? 'loading' : requestStatus;
    panel.dataset.status = displayStatus;
    panel.dataset.mode = state.mode;
    panel.setAttribute('aria-busy', String(displayStatus === 'loading' || preparing));
    range.disabled = preparing || (dayMode ? !dayReady : !state.metadata) || state.canScrub === false;
    for (const input of inputs) input.disabled = preparing || Boolean(state.offline && !state.metadata);
    if (fromCalendar) fromCalendar.disabled = !state.metadata;
    if (toCalendar) toCalendar.disabled = !state.metadata;
    const window = !dayMode && visibleWindow ? visibleWindow : state;
    range.min = dayMode ? '0' : String(window.minUtc ?? 0);
    range.max = String(dayMode ? Math.max(0, (day?.timeline?.minutes ?? 1) - 1) : window.maxUtc ?? 0);
    range.step = dayMode ? '1' : 'any';
    if (!state.opened) timelineMarks.clear();
    else if (dayMode) {
      timelineMarks.day(day?.timeline, day?.timeline?.minutes, (timeline, index) => formatTimelineMinute(timeline, index).time);
    } else {
      const natal = getPersonalRecord();
      if (natal && !visibleWindow?.calendar) timelineMarks.life(natal, Number(range.min), Number(range.max));
      else timelineMarks.calendar({ fromUtc: Number(range.min), toUtc: Number(range.max),
        timeZone: visibleWindow?.timeZone || 'UTC', labels: !natal });
    }
    const momentUtc = momentState?.current && state.metadata ? Math.max(state.minUtc!, Math.min(state.maxUtc!,
      Date.parse(momentState.current.utc!))) : null;
    const cursor = dayMode ? day?.index ?? 0 : momentUtc ?? state.requestedUtc ?? 0;
    const cursorVisible = dayMode || cursor >= Number(range.min) && cursor <= Number(range.max);
    range.setAttribute('data-cursor-visible', String(cursorVisible));
    range.value = String(cursor);
    // A pending file previews the existing transit; its saved range stays intact.
    const preparingDate = preparing && (day?.timeline?.date || day?.current?.localDate);
    updateDates(state, preparingDate);

    const shown = clock(dayMode ? day?.current?.utc || state.current?.utc : momentState ? momentState.current?.utc : state.current?.utc, dayMode ? day?.timeline?.timeZone : null);
    const requested = momentState ? shown : !dayMode && clock(state.requestedUtc);
    const reference = dayMode ? day?.referenceIndex : state.referenceUtc;
    const referenceUtc = dayMode ? day?.timeline && Number.isFinite(reference)
      ? timelineMinute(day.timeline, reference!).utc : null : reference;
    const displayedUtc = dayMode ? day?.current?.utc : momentState ? momentState.current?.utc : state.displayedUtc;
    dayRange.updateReference({ value: reference, visible: state.opened && !preparing && (!dayMode || dayReady) && Number.isFinite(reference)
      && reference! >= Number(range.min) && reference! <= Number(range.max),
      label: 'Вернуться к текущему времени',
      title: !dayMode && getPersonalRecord() ? 'Текущий транзит' : 'Текущий момент',
      active: isReferenceMoment(displayedUtc, referenceUtc) });
    const pending = displayStatus === 'loading';
    const unshown = !dayMode && !momentState && Boolean(state.metadata && state.requestedUtc !== state.displayedUtc && (pending || state.displayedUtc !== null));
    const dayLabel = dayMode && day?.timeline && formatTimelineMinute(day.timeline, day.index ?? 0);
    const selectedLabel = dayLabel ? `${dayLabel.date}, ${dayLabel.time}, ${dayLabel.offset}`
      : requested ? `${requested.date}, ${requested.time} UTC` : '';
    range.setAttribute('aria-valuetext', [selectedLabel, !cursorVisible ? 'на карте, вне выбранного периода' : '',
      pending ? 'загружается' : unshown ? 'не показано' : '',
      unshown && shown ? `на карте ${shown.date}, ${shown.time} ${shown.zone}` : ''].filter(Boolean).join('; '));
    // Temporary failures stay quiet at first; a rejected file needs repair.
    // The request owner decides whether to retry and owns the failure count.
    const reasonCode = (fileStatus ? state : momentState || state).errorCode;
    const connectionMessage = reasonCode ? failureMessage({code:reasonCode}, '') : '';
    setText(status, connectionMessage || (fileStatus && state.status === 'error' ? UI_MESSAGES.lifetimeUnavailable
      : preparing ? 'Создаём летопись'
      : state.opened && retryCount >= 3 && ['loading', 'error'].includes(displayStatus) ? UI_MESSAGES.momentLoading : ''));
    if (waitingForMetadata && state.metadata && state.opened) {
      const pending = submitted;
      waitingForMetadata = false;
      queueMicrotask(() => {
        if (explorer.state.opened && matchingPending(pending)) applyDates(true, pending!.allowOpenEnd, pending!.allowOpenStart);
      });
    }
  }

  function clearDateError(input: HTMLInputElement) {
    input.setAttribute('aria-invalid', 'false');
    const message = dateErrors.get(input);
    if (message) setText(message, '');
    inputError = inputs.some(field => field.getAttribute('aria-invalid') === 'true');
  }
  function clearInputError() {
    inputs.forEach(clearDateError);
  }
  function showDateError(input: HTMLInputElement, text: string) {
    inputError = true;
    input.setAttribute('aria-invalid', 'true');
    const message = dateErrors.get(input);
    if (message) setText(message, text);
  }
  function restoreDate(input: HTMLInputElement) {
    const state = explorer.state;
    const open = input === fromDate ? state.openStart : state.openEnded;
    input.value = open ? '' : formatDateInput(input === fromDate ? state.fromDate : state.toDate);
    dirty.delete(input);
    clearDateError(input);
  }
  function rejectDates() {
    submitted = null; waitingForMetadata = false;
    for (const input of inputs) {
      if (input.ownerDocument.activeElement !== input && (dirty.has(input) || input.getAttribute('aria-invalid') === 'true')) restoreDate(input);
    }
  }
  function resetCrossedEndpoint(input: HTMLInputElement) {
    if (inputs.some(field => field.value.replace(/\D/g, '').length !== 8)) return false;
    let start, end;
    try { start = normalizeDate(fromDate.value); end = normalizeDate(toDate.value); }
    catch { return false; }
    const { minDate, maxDate } = explorer.state;
    const edited = input === fromDate ? start : end;
    if (start <= end || minDate && edited < minDate || maxDate && edited > maxDate) return false;
    const opposite = input === fromDate ? toDate : fromDate;
    opposite.value = ''; dirty.add(opposite);
    waitingForMetadata = false; submitted = null; clearInputError();
    return true;
  }
  function applyDates(reportIncomplete = true, allowOpenEnd = explorer.state.openEnded, allowOpenStart = explorer.state.openStart) {
    if (scope.stopped || !explorer.state.opened) return;
    clearInputError();
    let incomplete = false;
    const { minDate, maxDate } = explorer.state;
    const [from, through] = inputs.map(input => {
      if ((input === fromDate ? allowOpenStart : allowOpenEnd) && !input.value.trim()) return null;
      const digits = input.value.replace(/\D/g, '').length;
      if (digits > 8) { showDateError(input, 'Дата некорректна'); return null; }
      // A draft is quiet until submit; every complete field owns its error.
      if (!reportIncomplete && digits < 8) {
        incomplete = true; return null;
      }
      let date;
      try { date = normalizeDate(input.value); }
      catch { showDateError(input, 'Дата некорректна'); return null; }
      if (minDate && date < minDate || maxDate && date > maxDate) showDateError(input, 'Вне диапазона');
      return date;
    });
    if (!incomplete && !inputError && through && from! > through) showDateError(toDate, 'Вне диапазона');
    if (incomplete || inputError) {
      if (inputError) {
        // A rejected period cannot leave an unapplied endpoint behind. Bounds
        // may arrive after editing, so restore inactive drafts as one range.
        // An unfinished endpoint is still being typed and does not reject it.
        rejectDates();
      }
      update(explorer.state); return;
    }
    submitted = { from: from ?? explorer.state.minDate, to: through ?? explorer.state.maxDate, fromText: fromDate.value, toText: toDate.value, allowOpenEnd, allowOpenStart };
    const result = explorer.setDateRange(from, through);
    if (result === false && !explorer.state.metadata) waitingForMetadata = true;
    update(explorer.state);
    Promise.resolve(result).catch(() => update(explorer.state));
  }

  function applyDateEdit(input: HTMLInputElement, reportIncomplete: boolean) {
    // Editing one date retains the pending meaning of its unchanged empty
    // neighbour. Loading still requires an exact match of both complete texts.
    const pending = matchingPending(submitted, input);
    submitted = pending;
    const reset = resetCrossedEndpoint(input);
    applyDates(reportIncomplete, input === fromDate && reset || pending?.allowOpenEnd || explorer.state.openEnded,
      input === toDate && reset || pending?.allowOpenStart || explorer.state.openStart);
  }

  for (const input of inputs) {
    let selectWholeOnClick = false, selectionTimer: ReturnType<typeof setTimeout> | undefined;
    scope.own(()=>clearTimeout(selectionTimer));
    function selectAfterClick(whole: boolean, clientX?: number) {
      clearTimeout(selectionTimer);
      // Let the browser finish placing its caret inside previously selected
      // text before choosing a component. A drag retains its native selection.
      selectionTimer = setTimeout(() => {
        if (scope.stopped || input.ownerDocument.activeElement !== input) return;
        if (whole) input.select();
        else if (input.selectionStart === input.selectionEnd) {
          const part = datePartAt(input, clientX);
          if (part) input.setSelectionRange(part.index, part.index + part[0].length);
        }
      }, 0);
    }
    input.addEventListener('pointerdown', event => {
      clearTimeout(selectionTimer);
      if (event.button !== 0) return;
      selectWholeOnClick = input.ownerDocument.activeElement !== input || event.pointerType === 'touch';
    }, {signal:scope.signal});
    input.addEventListener('focus', () => input.select(), {signal:scope.signal});
    input.addEventListener('click', event => {
      if (event.button !== undefined && event.button !== 0) return;
      selectAfterClick(selectWholeOnClick || event.detail >= 2 || event.detail === 0, event.clientX);
      selectWholeOnClick = false;
    }, {signal:scope.signal});
    input.addEventListener('dblclick', () => selectAfterClick(true), {signal:scope.signal});
    input.addEventListener('blur', () => {
      clearTimeout(selectionTimer);
      selectWholeOnClick = false;
      const pending = matchingPending();
      if (pending && !input.value.trim() && (input === fromDate ? pending.allowOpenStart : pending.allowOpenEnd)) return;
      if (input.value.replace(/\D/g, '').length >= 8 && input.getAttribute('aria-invalid') !== 'true' && (!dirty.has(input) || pending)) return;
      restoreDate(input);
      if (submitted) rejectDates();
    }, {signal:scope.signal});
    // A numeric paste can contain nine digits while still fitting maxlength=10.
    // Retain that invalid draft instead of silently committing its first eight.
    let rawInput = '';
    input.addEventListener('input', () => { clearTimeout(selectionTimer); rawInput = input.value; }, {signal:scope.signal});
    bindNumericInput(input, formatDateInput, scope.signal);
    input.addEventListener('input', () => {
      dirty.add(input); clearInputError(); waitingForMetadata = false;
      if (rawInput.replace(/\D/g, '').length > 8) {
        input.value = rawInput;
        input.setSelectionRange(rawInput.length, rawInput.length);
        applyDates(false);
        return;
      }
      applyDateEdit(input, false);
    }, {signal:scope.signal});
    input.addEventListener('keydown', event => {
      clearTimeout(selectionTimer);
      if (input === fromDate && event.key === 'Tab' && !event.shiftKey) {
        event.preventDefault(); toDate.focus(); return;
      }
      if (event.key !== 'Enter') return;
      event.preventDefault(); applyDateEdit(input, true);
    }, {signal:scope.signal});
  }
  toDate.addEventListener('change', () => applyDateEdit(toDate, true), {signal:scope.signal});
  function setVisibleWindow(value: VisibleWindow | null) {
    if(scope.stopped)return;
    const next = value && Number.isFinite(value.minUtc) && Number.isFinite(value.maxUtc) && value.minUtc <= value.maxUtc
      ? { minUtc: value.minUtc, maxUtc: value.maxUtc, calendar: Boolean(value.calendar), timeZone: value.timeZone || 'UTC' } : null;
    if (next?.minUtc === visibleWindow?.minUtc && next?.maxUtc === visibleWindow?.maxUtc
      && next?.calendar === visibleWindow?.calendar && next?.timeZone === visibleWindow?.timeZone) return;
    visibleWindow = next;
    update(explorer.state);
  }
  // Readiness and the real-clock marker can change without a new chart object.
  // The existing day controller remains the sole owner of its minute range.
  function refreshMoment() {
    if(scope.stopped)return;
    const state = explorer.state;
    const momentState = getMomentState();
    if (state.opened && (state.mode === 'transit-day' || state.status === 'preparing' || momentState || momentClockShown)) update(state, momentState);
  }
  for (const [input, button] of [[fromDate, fromCalendar], [toDate, toCalendar]] as const) {
    if (!button) continue;
    calendars.push(attachDatePicker({ input, button, viewportLayout, signal:scope.signal,
      getBounds: () => ({ min: explorer.state.minDate, max: explorer.state.maxDate }),
      onSelect(value) {
        onMomentInput();
        input.value = formatDateInput(value); dirty.add(input);
        waitingForMetadata = false; submitted = null;
        applyDateEdit(input, true);
      },
    }));
  }
  function snapshot(): SavedLifetimeDraft | null {
    if (scope.stopped || !explorer.state.opened) return null;
    const field=inputs.find(input=>input.ownerDocument.activeElement === input);
    const focus=captureTextSelection(field);
    return focus || dirty.size ? {fromDate:fromDate.value,toDate:toDate.value,
      focus:focus ? {field:field === fromDate ? 'fromDate' : 'toDate',...focus} : null} : null;
  }
  function restoreDraft(value: unknown, {restoreFocus = true} = {}) {
    if(scope.stopped)return false;
    const draft=normalizeLifetimeDraft(value);
    if (!draft || !explorer.state.opened || fromDate.disabled || toDate.disabled) return false;
    for (const [input,text] of [[fromDate,draft.fromDate],[toDate,draft.toDate]] as const) {
      if (input.value !== text) dirty.add(input);
      input.value=text;
    }
    clearInputError(); submitted=null; waitingForMetadata=false;
    const restored=!restoreFocus || !draft.focus || restoreTextSelection(draft.focus.field === 'fromDate' ? fromDate : toDate,draft.focus);
    onDraftChange();
    return restored;
  }
  scope.own(watchTextSelection(inputs,()=>{if(!scope.stopped)onDraftChange();}));
  update(explorer.state);
  return { dispose:scope.stop, update, refreshMoment, setVisibleWindow, refreshTargets: dayRange.refreshTargets, restoreDraft, get snapshot() { return snapshot(); } };
}
