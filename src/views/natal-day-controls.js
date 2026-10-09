import { createNatalDayExplorer } from '../state/natal-day.js';
import { formatDateInput } from './date-input.js';
import { attachTimelineRange, isReferenceMoment } from './timeline-range.js';
import { attachTimelineMarks } from './timeline-marks.js';
import { natalDayMinute } from '../domain/natal-day.js';
import { setText } from '../ui/html.js';
import { savedBirthTime } from './chart-display.js';

export function attachNatalDayExplorer({ toggle, panel, range, status, retryButton, hourMarks = null, marker = null, onMomentInput = () => {}, ...options }) {
  const timelineMarks = attachTimelineMarks(hourMarks);
  function update(state) {
    toggle.hidden = !state.available;
    toggle.setAttribute('aria-expanded', String(state.opened));
    toggle.setAttribute('aria-pressed', String(state.opened));
    toggle.title = 'Шкала дня';
    panel.hidden = !state.opened;
    panel.setAttribute('aria-busy', String(state.status === 'loading'));
    panel.dataset.original = String(state.exactOriginal);
    panel.dataset.status = state.status;
    timelineMarks.day(state.opened ? state.day : null, state.day?.samples, (day, index) => natalDayMinute(day, index).birthTime);
    range.disabled = state.status !== 'ready';
    retryButton.hidden = state.status !== 'error';
    retryButton.disabled = state.status === 'loading';
    setText(retryButton, 'Повторить');
    retryButton.title = 'Повторить загрузку дня рождения';
    setText(status, state.status === 'loading' ? 'Рассчитываем день…' : state.status === 'error' ? state.error : '');
    const chart = state.current;
    const date = chart?.birthDate ? formatDateInput(chart.birthDate) : '';
    if (state.day) {
      range.min = '0'; range.max = String(state.day.samples - 1); range.step = '1'; range.value = String(state.index);
    } else { range.min = '0'; range.max = '1439'; range.value = '0'; }
    // Saved UTC identifies the original fold, independently of the preview.
    dayRange.updateReference({ value: state.referenceIndex,
      visible: state.opened && state.status === 'ready' && Boolean(state.day),
      label: 'Вернуться к сохранённому времени рождения', title: 'Сохраненное время карты', active: isReferenceMoment(state.current?.utc, state.original?.utc) });
    const offset = chart?.utcOffset || '';
    const clock = state.exactOriginal ? savedBirthTime(chart) : chart?.birthTime || '';
    const zone = chart?.timezone || state.day?.timezone || '';
    const utcOffset = offset && /^[-+]/.test(offset) ? `UTC${offset}` : offset;
    range.setAttribute('aria-valuetext', [date, clock, utcOffset, zone, state.exactOriginal ? 'сохранённое время рождения' : ''].filter(Boolean).join(', '));
    options.onStateChange?.(state);
  }
  const explorer = createNatalDayExplorer({ ...options, onStateChange: update });
  const reset = () => { onMomentInput(); return explorer.reset(); };
  const dayRange = attachTimelineRange({ range, marker,
    onScrub: value => { onMomentInput(); return explorer.scrub(value); }, onReference: reset });
  retryButton.addEventListener('click', () => { if (explorer.state.status === 'error') return explorer.retry(); });
  update(explorer.state);
  return explorer;
}
