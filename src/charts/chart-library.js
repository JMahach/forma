import { renderChartThumbnail } from './chart-thumbnail.js';
import { formatDateInput } from './date-input.js';
import { canManageChart } from './chart-display.js';
import { escapeHtml as esc } from '../ui/html.js';

const sourceNames = { calculated: 'Расчёт по данным рождения', manual: 'Ручные активации', transit: 'Транзит' };

export function renderChartLibrary({ chartList, libraryCount, nowButton }, charts, selectedId) {
  const personalCharts = charts.filter(canManageChart);
  libraryCount.textContent = personalCharts.length;
  nowButton.setAttribute('aria-pressed', String(selectedId === 'current-transit'));
  chartList.innerHTML = personalCharts.map(c => `<div class="chart-row has-actions" data-active="${c.id === selectedId}"><button class="chart-card" data-chart-id="${esc(c.id)}" data-active="${c.id === selectedId}" aria-pressed="${c.id === selectedId}"><img class="chart-avatar chart-thumbnail" src="${renderChartThumbnail(c)}" alt="" aria-hidden="true" width="44" height="68" decoding="async"><span class="chart-copy"><span class="chart-name">${esc(c.name)}</span><span class="chart-caption">${esc(c.birthDate ? [formatDateInput(c.birthDate), c.birthTime].filter(Boolean).join(' · ') : sourceNames[c.source] || 'Ручные активации')}</span></span></button><details class="chart-actions"><summary aria-label="Действия с картой «${esc(c.name)}»" title="Действия с картой"><span aria-hidden="true">⋯</span></summary><div class="chart-action-menu"><button data-chart-action="edit" data-action-chart-id="${esc(c.id)}">Редактировать</button><button class="danger-text" data-chart-action="delete" data-action-chart-id="${esc(c.id)}">Удалить</button></div></details></div>`).join('');
}

export function attachChartLibrary({ document, store, onSelect, onEdit, onNew, onUpdate = () => {}, beforeOpen = () => {}, toast }) {
  const $ = id => document.getElementById(id);
  let deletingId = null;
  function render() {
    renderChartLibrary({ chartList: $('chartList'), libraryCount: $('libraryCount'), nowButton: $('nowButton') }, store.charts, store.selectedId);
  }

  function openLibrary() {
    beforeOpen();
    render();
    $('library').inert = false;
    $('library').classList.add('open');
    $('libraryBackdrop').hidden = false;
    $('openLibrary').setAttribute('aria-expanded', 'true');
    $('nowButton').focus({ preventScroll: true });
  }
  function closeLibrary() {
    const restoreFocus = $('library').contains(document.activeElement);
    $('library').classList.remove('open');
    $('library').inert = true;
    $('libraryBackdrop').hidden = true;
    $('openLibrary').setAttribute('aria-expanded', 'false');
    if (restoreFocus) $('openLibrary').focus({ preventScroll: true });
  }

  document.addEventListener('click', e => {
    const action = e.target.closest('[data-chart-action]');
    if (action) {
      const c = store.charts.find(item => item.id === action.dataset.actionChartId);
      if (!canManageChart(c)) return;
      action.closest('details').open = false;
      if (action.dataset.chartAction === 'edit') onEdit(c.id);
      else openDeleteChart(c);
      return;
    }
    const button = e.target.closest('[data-chart-id]'); if (button) onSelect(button.dataset.chartId);
  });
  document.addEventListener('toggle', e => {
    if (!e.target.matches?.('.chart-actions[open]')) return;
    document.querySelectorAll('.chart-actions[open]').forEach(item => { if (item !== e.target) item.open = false; });
  }, true);
  document.addEventListener('pointerdown', e => document.querySelectorAll('.chart-actions[open]').forEach(item => { if (!item.contains(e.target)) item.open = false; }));
  $('newChartButton').addEventListener('click', () => onNew());
  function openDeleteChart(c) {
    if (!canManageChart(c)) return;
    deletingId = c.id;
    $('deleteChartName').textContent = `«${c.name}»`;
    $('deleteChartError').textContent = '';
    $('deleteChartDialog').showModal();
    $('cancelDeleteChart').focus();
  }
  $('cancelDeleteChart').addEventListener('click', () => $('deleteChartDialog').close());
  $('confirmDeleteChart').addEventListener('click', () => {
    try {
      store.remove(deletingId);
      $('deleteChartDialog').close();
      if (store.selectedId === deletingId) onSelect(store.charts.find(c => c.id !== 'current-transit')?.id || 'current-transit');
      else onUpdate();
      deletingId = null;
      toast('Карта удалена');
    } catch { $('deleteChartError').textContent = 'Не удалось удалить карту. Она осталась в библиотеке.'; }
  });

  $('openLibrary').addEventListener('click', openLibrary);
  $('libraryBackdrop').addEventListener('click', closeLibrary);
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape' || e.defaultPrevented) return;
    const menu = document.querySelector('.chart-actions[open]');
    if (menu) { menu.open = false; menu.querySelector('summary').focus(); e.preventDefault(); return; }
    closeLibrary();
  });

  return { open: openLibrary, close: closeLibrary, render };
}
