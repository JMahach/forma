// One palette menu on source and release pages; only the drawing preference persists.
import { PALETTE } from '../ui/chart-palette.ts';
import { chartHighlight } from '../state/chart-highlight.ts';

if (typeof document !== 'undefined') {
  const footer = document.querySelector<HTMLElement>('.sidebar-footer');
  if (footer) {
    const storageKey = 'forma.control-colors.v1', highlightKey = 'forma.chart-highlight.v1';
    let expanded = false;
    try { expanded = Boolean(JSON.parse(sessionStorage.getItem(storageKey) || 'null')?.expanded); } catch {}
    // Legacy simulation fields are deliberately ignored, including URL parameters.
    try { chartHighlight.set(sessionStorage.getItem(highlightKey)); } catch {}
    const style = document.createElement('style');
    style.textContent = `
      .control-color-previews { display: flex; flex-wrap: wrap; gap: 8px; flex: 0 0 100%; margin: 4px 0 8px; }
      .shared-chart-study-options { position: relative; flex: 0 0 100%; min-width: 0; min-height: 32px; }
      .shared-chart-study-options > .chart-highlight-switch {
        position: absolute; right: 0; top: 0; width: 44px; height: 32px;
        display: grid; place-items: center; padding: 0; border: 0;
        border-radius: 6px; background: transparent; cursor: pointer;
        touch-action: manipulation;
      }
      .chart-highlight-track {
        display: block; position: relative; width: 34px; height: 20px;
        border: 1px solid var(--panel-border); border-radius: 999px;
        background: var(--panel-bg, #f3f0e8);
      }
      .chart-highlight-thumb {
        position: absolute; left: 2px; top: 2px; width: 14px; height: 14px;
        display: grid; place-items: center; border-radius: 50%;
        background: ${PALETTE.halo}; color: #202020; font: 500 9px/1 system-ui;
        transition: transform 100ms ease-out;
      }
      .chart-highlight-switch[aria-checked="true"] .chart-highlight-thumb { transform: translateX(14px); }
      .chart-highlight-switch:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
      @media (prefers-reduced-motion: reduce) { .chart-highlight-thumb { transition: none; } }
    `;
    document.head.append(style);
    const group = document.createElement('div');
    group.className = 'control-color-previews'; group.id = 'controlColorPreviews'; group.hidden = !expanded;
    const options = document.createElement('div'); options.className = 'shared-chart-study-options';
    const highlightSwitch = document.createElement('button');
    highlightSwitch.type = 'button'; highlightSwitch.className = 'chart-highlight-switch';
    highlightSwitch.setAttribute('role', 'switch'); highlightSwitch.setAttribute('aria-label', 'Подсветка 1 / 2');
    highlightSwitch.innerHTML = '<span class="chart-highlight-track" aria-hidden="true"><span class="chart-highlight-thumb"></span></span>';
    const showHighlight = () => {
      const outline = chartHighlight.current === 'outline';
      highlightSwitch.setAttribute('aria-checked', String(outline));
      highlightSwitch.querySelector('.chart-highlight-thumb')!.textContent = outline ? '2' : '1';
    };
    showHighlight();
    chartHighlight.subscribe(() => {
      showHighlight();
      try { sessionStorage.setItem(highlightKey, chartHighlight.current); } catch {}
    });
    highlightSwitch.addEventListener('click', () => chartHighlight.set(chartHighlight.current === 'outline' ? 'glow' : 'outline'));
    options.append(highlightSwitch); group.append(options);
    const toggle = document.createElement('button');
    toggle.type = 'button'; toggle.id = 'toggleControlColors'; toggle.className = 'sidebar-tool'; toggle.textContent = 'Палитры';
    toggle.setAttribute('aria-controls', group.id);
    function remember() {
      toggle.setAttribute('aria-expanded', String(!group.hidden)); toggle.setAttribute('aria-pressed', String(!group.hidden));
      try { sessionStorage.setItem(storageKey, JSON.stringify({expanded: !group.hidden})); } catch {}
    }
    toggle.addEventListener('click', () => { group.hidden = !group.hidden; remember(); });
    footer.prepend(group); footer.insertBefore(toggle, footer.querySelector('#randomChartButton'));
    remember();
  }
}
