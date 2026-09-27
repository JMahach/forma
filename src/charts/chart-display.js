import { formatDateInput } from './date-input.js';

export const canManageChart = chart => chart && chart.id !== 'current-transit' && chart.source !== 'transit';
export const chartTitle = chart => chart.id === 'current-transit' || chart.source === 'transit' ? 'Транзит' : chart.name;
export const localMoment = value => {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', timeZoneName: 'short' }).format(date) : '';
};
const transitSubtitle = value => {
  if (typeof value !== 'string' || !value.trim()) return '';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  // Both the date and clock describe the displayed calculation, including a
  // paused minute. Never substitute the wall clock for a missing chart moment.
  return [
    new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' }).format(date),
    new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit' }).format(date),
  ].join(' · ');
};
export const chartSubtitle = chart => chart.id === 'current-transit' || chart.source === 'transit' ? transitSubtitle(chart.utc)
  : [chart.birthDate ? formatDateInput(chart.birthDate) : '', chart.birthTime, chart.birthPlace].filter(Boolean).join(' · ');
