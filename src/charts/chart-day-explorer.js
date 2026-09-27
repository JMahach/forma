import { createChartDayClient } from '../transit/chart-day-client.js';
import { chartAtMinute, chartDayMinute, chartDayIndexAt } from '../transit/chart-day-packet.js';
import { formatDateInput } from './date-input.js';
import { attachDayRange } from './day-range.js';

export const canExploreChartDay = chart => Boolean(chart?.source === 'calculated'
  && chart.id !== 'current-transit' && /^\d{4}-\d{2}-\d{2}$/.test(chart.birthDate || '')
  && String(chart.cityId ?? chart.city?.id ?? '').length > 0 && Number.isFinite(Date.parse(chart.utc)));

function savedClock(chart) {
  const offset = /^UTC([+−-])(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(chart?.utcOffset || '');
  const utc = Date.parse(chart?.utc);
  if (!offset || !Number.isFinite(utc)) return chart?.birthTime || '';
  const seconds = (Number(offset[2]) * 3600 + Number(offset[3]) * 60 + Number(offset[4] || 0)) * (offset[1] === '+' ? 1 : -1);
  const clock = new Date(utc + seconds * 1000).toISOString().slice(11, 19);
  return clock.endsWith(':00') && (chart.birthTime || '').length <= 5 ? clock.slice(0, 5) : clock;
}

// The saved chart is the source of truth. A selected minute is a temporary view
// and does not navigate, persist, clear graph selections or move the camera.
export function createChartDayExplorer({
  dayClient = createChartDayClient(), onStateChange = () => {}, onRender = () => {},
} = {}) {
  let original = null, current = null, day = null, index = 0;
  let opened = false, status = 'idle', error = '', exactOriginal = true, sequence = 0, active = null;
  const state = () => ({ original, current, day, index, opened, status, error, exactOriginal, available: canExploreChartDay(original) });
  const notify = () => onStateChange(state());
  const cancel = () => { sequence += 1; active?.controller.abort(); active = null; };

  async function load() {
    if (!opened || !canExploreChartDay(original)) return false;
    if (active) return active.promise;
    const requestSequence = ++sequence, chart = original, controller = new AbortController();
    status = 'loading'; error = ''; notify();
    const promise = (async () => {
      try {
        const result = await dayClient.getDay(chart, { signal: controller.signal });
        if (requestSequence !== sequence || !opened || chart !== original) return false;
        day = result; index = chartDayIndexAt(day, chart.utc); status = 'ready';
        return true;
      } catch (failure) {
        if (requestSequence !== sequence || controller.signal.aborted) return false;
        status = 'error'; error = failure.message || 'Не удалось загрузить день рождения.';
        return false;
      } finally {
        if (requestSequence === sequence) { active = null; notify(); }
      }
    })();
    active = { controller, promise };
    return promise;
  }

  function reset() {
    if (!original) return;
    const changed = current !== original;
    current = original; exactOriginal = true;
    if (day) index = chartDayIndexAt(day, original.utc);
    notify();
    if (changed) onRender();
  }

  function close() {
    if (!opened) return;
    cancel(); opened = false; status = day ? 'ready' : 'idle'; error = '';
    reset();
  }

  return {
    get current() { return opened ? current : null; },
    get state() { return state(); },
    select(chart) {
      if (chart === original) return;
      cancel(); original = chart; current = chart; day = null; index = 0;
      opened = false; status = 'idle'; error = ''; exactOriginal = true; notify();
    },
    async open() {
      if (!canExploreChartDay(original)) return false;
      opened = true; notify();
      return day ? true : load();
    },
    close,
    toggle() { if (opened) close(); else return this.open(); },
    retry: load,
    reset,
    scrub(value) {
      if (!opened || status !== 'ready' || !day || !Number.isFinite(value)) return;
      const minute = chartDayMinute(day, Math.min(day.samples - 1, Math.max(0, Math.trunc(value))));
      if (!exactOriginal && index === minute.index) return;
      index = minute.index; current = chartAtMinute(day, index, original); exactOriginal = false;
      notify(); onRender();
    },
  };
}

export function attachChartDayExplorer({ toggle, panel, range, date, time, status, resetButton, marker = null, ...options }) {
  function update(state) {
    toggle.hidden = !state.available;
    toggle.setAttribute('aria-expanded', String(state.opened));
    toggle.setAttribute('aria-pressed', String(state.opened));
    toggle.title = state.opened ? 'Закрыть просмотр дня рождения' : 'Посмотреть день рождения по минутам';
    panel.hidden = !state.opened;
    panel.setAttribute('aria-busy', String(state.status === 'loading'));
    panel.dataset.original = String(state.exactOriginal);
    panel.dataset.status = state.status;
    range.disabled = state.status !== 'ready';
    resetButton.disabled = state.status === 'loading' || state.exactOriginal && state.status !== 'error';
    resetButton.textContent = state.status === 'error' ? 'Повторить' : 'К рождению';
    resetButton.title = state.status === 'error' ? 'Повторить загрузку дня рождения' : 'Вернуться к сохранённому времени рождения';
    resetButton.setAttribute('aria-pressed', String(state.exactOriginal));
    status.textContent = state.status === 'loading' ? 'Рассчитываем день…' : state.status === 'error' ? state.error : '';
    const chart = state.current;
    date.textContent = chart?.birthDate ? formatDateInput(chart.birthDate) : '';
    if (state.day) {
      range.min = '0'; range.max = String(state.day.samples - 1); range.step = '1'; range.value = String(state.index);
    } else { range.min = '0'; range.max = '1439'; range.value = '0'; }
    // Saved UTC identifies the original fold, independently of the preview.
    dayRange.updateReference({ value: state.day && Number.isFinite(Date.parse(state.original?.utc))
      ? chartDayIndexAt(state.day, state.original.utc) : null,
      visible: state.opened && state.status === 'ready' && Boolean(state.day),
      label: 'Вернуться к сохранённому времени рождения', active: state.exactOriginal });
    const offset = chart?.utcOffset || '';
    const clock = state.exactOriginal ? savedClock(chart) : chart?.birthTime || '';
    const zone = chart?.timezone || state.day?.timezone || '';
    const utcOffset = offset && /^[-+]/.test(offset) ? `UTC${offset}` : offset;
    time.textContent = [clock, utcOffset].filter(Boolean).join(' · ');
    time.dateTime = chart?.utc || '';
    time.title = [zone, state.exactOriginal ? 'Сохранённое время рождения' : 'Просмотр другой минуты'].filter(Boolean).join(' · ');
    time.setAttribute('aria-label', [clock, utcOffset, zone].filter(Boolean).join(', '));
    range.setAttribute('aria-valuetext', [date.textContent, clock, utcOffset, zone, state.exactOriginal ? 'сохранённое время рождения' : ''].filter(Boolean).join(', '));
    options.onStateChange?.(state);
  }
  const explorer = createChartDayExplorer({ ...options, onStateChange: update });
  const dayRange = attachDayRange({ range, marker, onScrub: value => explorer.scrub(value), onReference: () => explorer.reset() });
  toggle.addEventListener('click', () => explorer.toggle());
  resetButton.addEventListener('click', () => explorer.state.status === 'error' ? explorer.retry() : explorer.reset());
  update(explorer.state);
  return explorer;
}
