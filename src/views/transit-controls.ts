import type { LiveTransitState } from '../state/live-transit.ts';
interface TransitControlsOptions { panel: HTMLElement; range: HTMLInputElement; status: HTMLElement; retryButton: HTMLButtonElement; hourMarks?: HTMLElement | null; marker?: HTMLButtonElement | null; onScrub: (value: number) => void; onNow: () => void }
export type TransitControls = ReturnType<typeof attachTransitControls>;

import { formatTimelineMinute, timelineMinute } from '../domain/day-timeline.ts';
import { attachTimelineRange, isReferenceMoment } from './timeline-range.ts';
import { attachTimelineMarks } from './timeline-marks.ts';
import { setText } from '../ui/html.ts';

export function attachTransitControls({ panel, range, status, retryButton, hourMarks = null, marker = null, onScrub, onNow }: TransitControlsOptions) {
  const dayRange = attachTimelineRange({ range, marker, onScrub, onReference: onNow });
  const timelineMarks = attachTimelineMarks(hourMarks);
  let coveredByLifetime = false, latestState: LiveTransitState | null = null;
  retryButton.addEventListener('click', () => { if (latestState?.status === 'error') return onNow(); });
  function update(state: LiveTransitState) {
    latestState = state;
    if (coveredByLifetime || !state.wanted) {
      if (!panel.hidden) {
        panel.hidden = true;
        dayRange.updateReference({ visible: false, label: 'Вернуться к текущему времени' });
      }
      return;
    }
    panel.hidden = false;
    panel.setAttribute('aria-busy', String(state.status === 'loading'));
    panel.dataset.live = String(state.live);
    panel.dataset.status = state.status;
    range.disabled = state.status !== 'ready';
    retryButton.hidden = state.status !== 'error';
    retryButton.disabled = state.status === 'loading';
    setText(retryButton, 'Повторить');
    setText(status, state.status === 'loading' ? 'Загружаем день…' : state.status === 'error' ? 'День не загрузился' : '');
    timelineMarks.day(state.timeline, state.timeline?.minutes, (day, index) => formatTimelineMinute(day, index).time);
    if (state.timeline) {
      range.min = '0'; range.max = String(state.timeline.minutes - 1); range.step = '1';
      range.value = String(state.index);
    }
    const referenceUtc = state.timeline && Number.isFinite(state.referenceIndex)
      ? timelineMinute(state.timeline, state.referenceIndex!).utc : null;
    dayRange.updateReference({ value: state.referenceIndex,
      visible: state.status === 'ready' && Boolean(state.timeline),
      label: 'Вернуться к текущему времени', title: 'Текущий момент', active: isReferenceMoment(state.current?.utc, referenceUtc) });
    if (!state.timeline) return;
    const label = formatTimelineMinute(state.timeline, state.index);
    range.setAttribute('aria-valuetext', `${label.date}, ${label.time}, ${label.offset}`);
  }
  return { update,
    setCoveredByLifetime(value: boolean) {
      if (coveredByLifetime === Boolean(value)) return;
      coveredByLifetime = Boolean(value);
      if (latestState) update(latestState);
      else if (coveredByLifetime) panel.hidden = true;
    },
  };
}
