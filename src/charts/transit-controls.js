import { formatTimelineMinute } from '../transit/day-timeline.js';

export function attachTransitControls({ panel, range, date, time, status, nowButton, onScrub, onNow }) {
  range.addEventListener('input', () => onScrub(Number(range.value)));
  nowButton.addEventListener('click', () => onNow());
  function update(state) {
    panel.hidden = !state.wanted;
    panel.setAttribute('aria-busy', String(state.status === 'loading'));
    panel.dataset.live = String(state.live);
    range.disabled = state.status !== 'ready';
    nowButton.disabled = state.status === 'loading';
    nowButton.setAttribute('aria-pressed', String(state.live));
    nowButton.title = state.status === 'error' ? 'Повторить загрузку текущего дня' : 'Вернуться к текущему времени';
    status.textContent = state.status === 'loading' ? 'Загружаем день…' : state.status === 'error' ? 'День не загрузился' : '';
    if (!state.timeline) return;
    range.min = '0'; range.max = String(state.timeline.minutes - 1); range.step = '1';
    range.value = String(state.index);
    const label = formatTimelineMinute(state.timeline, state.index);
    date.textContent = label.date;
    time.textContent = `${label.time} · ${label.offset}`;
    time.dateTime = label.utc;
    time.title = state.timeline.timeZone;
    range.setAttribute('aria-valuetext', `${label.date}, ${label.time}, ${label.offset}`);
  }
  return { update };
}
