import { formatDateInput } from './date-input.js';

export const canManageChart = chart => chart && chart.id !== 'current-transit' && chart.source !== 'transit';
export const chartTitle = chart => chart.id === 'current-transit' || chart.source === 'transit' ? 'Транзит' : chart.name;
export const localMoment = value => {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', timeZoneName: 'short' }).format(date) : '';
};
export const chartSubtitle = chart => chart.source === 'transit' ? localMoment(chart.utc)
  : [chart.birthDate ? formatDateInput(chart.birthDate) : '', chart.birthTime, chart.birthPlace].filter(Boolean).join(' · ');
