import { formatTimelineMinute } from '../transit/day-timeline.js';
import { attachDayRange } from './day-range.js';

export function attachTransitControls({ panel, range, date, time, status, nowButton, marker = null, onScrub, onNow }) {
  const dayRange = attachDayRange({ range, marker, onScrub, onReference: onNow });
  nowButton.addEventListener('click', () => onNow());
  function update(state) {
    panel.hidden = !state.wanted;
    panel.setAttribute('aria-busy', String(state.status === 'loading'));
    panel.dataset.live = String(state.live);
    panel.dataset.status = state.status;
    range.disabled = state.status !== 'ready';
    nowButton.disabled = state.status === 'loading';
    nowButton.setAttribute('aria-pressed', String(state.live));
    nowButton.textContent = state.status === 'error' ? 'Повторить' : 'Сейчас';
    nowButton.title = state.status === 'error' ? 'Повторить загрузку текущего дня' : 'Вернуться к текущему времени';
    status.textContent = state.status === 'loading' ? 'Загружаем день…' : state.status === 'error' ? 'День не загрузился' : '';
    if (state.timeline) {
      range.min = '0'; range.max = String(state.timeline.minutes - 1); range.step = '1';
      range.value = String(state.index);
    }
    dayRange.updateReference({ value: state.referenceIndex,
      visible: state.wanted && state.status === 'ready' && Boolean(state.timeline),
      label: 'Вернуться к текущему времени', active: state.live });
    if (!state.timeline) return;
    const label = formatTimelineMinute(state.timeline, state.index);
    date.textContent = label.date;
    time.textContent = `${label.time} · ${label.offset}`;
    time.dateTime = label.utc;
    time.title = state.timeline.timeZone;
    range.setAttribute('aria-valuetext', `${label.date}, ${label.time}, ${label.offset}`);
  }
  return { update };
}
