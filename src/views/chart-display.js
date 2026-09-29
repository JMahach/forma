import { formatDateInput } from './date-input.js';

export const canManageChart = chart => chart && chart.id !== 'current-transit' && chart.source !== 'transit';
export const chartTitle = chart => chart.id === 'current-transit' || chart.source === 'transit' ? 'Транзит' : chart.name;
let transitFormatters;
const transitSubtitle = value => {
  if (typeof value !== 'string' || !value.trim()) return '';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  // Both the date and clock describe the displayed calculation, including a
  // paused minute. Never substitute the wall clock for a missing chart moment.
  // Read the current local calendar first. UTC formatters only print those
  // fields: they keep no stale device timezone after an in-page zone change.
  const local = new Date(0);
  local.setUTCFullYear(date.getFullYear(), date.getMonth(), date.getDate());
  local.setUTCHours(date.getHours(), date.getMinutes(), date.getSeconds(), date.getMilliseconds());
  transitFormatters ??= [
    new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }),
    new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' }),
  ];
  return transitFormatters.map(formatter => formatter.format(local)).join(' · ');
};
export const chartSubtitle = chart => chart.id === 'current-transit' || chart.source === 'transit' ? transitSubtitle(chart.utc)
  : [chart.birthDate ? formatDateInput(chart.birthDate) : '', chart.birthTime, chart.birthPlace].filter(Boolean).join(' · ');
