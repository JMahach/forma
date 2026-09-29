import { createChartDayExplorer } from '../state/natal-day.js';
import { formatDateInput } from './date-input.js';
import { attachDayRange } from './day-range.js';

function savedClock(chart) {
  const offset = /^UTC([+−-])(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(chart?.utcOffset || '');
  const utc = Date.parse(chart?.utc);
  if (!offset || !Number.isFinite(utc)) return chart?.birthTime || '';
  const seconds = (Number(offset[2]) * 3600 + Number(offset[3]) * 60 + Number(offset[4] || 0)) * (offset[1] === '+' ? 1 : -1);
  const clock = new Date(utc + seconds * 1000).toISOString().slice(11, 19);
  return clock.endsWith(':00') && (chart.birthTime || '').length <= 5 ? clock.slice(0, 5) : clock;
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
    dayRange.updateReference({ value: state.referenceIndex,
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
