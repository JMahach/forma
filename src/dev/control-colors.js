// Temporary stand-only colour comparison. Only the chosen swatch is tab-local UI state.
import { PALETTE } from '../ui/chart-palette.js';

const STORAGE_KEY = 'forma.control-colors.v1';
if (location.port === '3636') {
  const palettes = {
    green: [
      // Light Ajna, warm sage, moss, exact Ajna, deeper Ajna.
      { accent: PALETTE.ajna, fill: '#e1eadc', ink: '#3f5b34', border: '#9eb58f', idle: '#49673d', edge: '#bdcdb5' },
      { accent: '#84956b', fill: '#e6eade', ink: '#4d5e40', border: '#a9b59c', idle: '#526247', edge: '#c4cbbb' },
      { accent: '#658651', fill: '#dce6d5', ink: '#3a532d', border: '#8ca078', idle: '#405c33', edge: '#b6c5ac' },
      { accent: PALETTE.ajna, fill: PALETTE.ajna, ink: '#20301a', border: '#648b53', idle: '#426338', edge: '#a8bf9a' },
      { accent: '#537448', fill: '#537448', ink: '#fffefd', border: '#48653f', idle: '#3f5b34', edge: '#a0b396' },
    ],
    brown: [
      { accent: PALETTE.throat, fill: '#efe5da', ink: '#68472f', border: '#c9ab8c', idle: '#735039', edge: '#d4c1ae' },
      { accent: '#9e8367', fill: '#ebe5de', ink: '#665342', border: '#b5a18d', idle: '#6b5644', edge: '#ccc0b2' },
      { accent: '#9c744f', fill: '#ddc7b0', ink: '#503820', border: '#b38c66', idle: '#6b4b32', edge: '#c5ad95' },
      { accent: PALETTE.throat, fill: PALETTE.throat, ink: '#302115', border: '#926942', idle: '#68472f', edge: '#bba185' },
      { accent: '#775234', fill: '#775234', ink: '#fffefd', border: '#67452c', idle: '#67452c', edge: '#b89a7d' },
    ],
    gold: [
      { accent: PALETTE.head, fill: '#f8f0cf', ink: '#6b581b', border: '#d7c58d', idle: '#78621f', edge: '#dfd3a8' },
      { accent: '#c7b575', fill: '#eee8d4', ink: '#61552e', border: '#c3b78e', idle: '#6d5f31', edge: '#d2c9ac' },
      { accent: '#d5b344', fill: '#ecd993', ink: '#574610', border: '#bc9b3d', idle: '#735b18', edge: '#cdbd85' },
      { accent: PALETTE.head, fill: PALETTE.head, ink: '#43350b', border: '#b89a29', idle: '#735b18', edge: '#cab371' },
      { accent: '#876d19', fill: '#876d19', ink: '#fffefd', border: '#715b12', idle: '#6d5714', edge: '#b8a46d' },
    ],
    graphite: [
      // Neutral black at 20%, 40%, 60%, 80% and 100% density over white.
      { accent: '#000000', fill: '#cccccc', ink: '#000000', border: '#999999', idle: '#000000', edge: '#bfbfbf' },
      { accent: '#000000', fill: '#999999', ink: '#000000', border: '#737373', idle: '#000000', edge: '#a6a6a6' },
      { accent: '#000000', fill: '#666666', ink: '#ffffff', border: '#4d4d4d', idle: '#000000', edge: '#8c8c8c' },
      { accent: '#000000', fill: '#333333', ink: '#ffffff', border: '#1a1a1a', idle: '#000000', edge: '#737373' },
      { accent: '#000000', fill: '#000000', ink: '#ffffff', border: '#000000', idle: '#000000', edge: '#595959' },
    ],
  };
  const labels = {
    green: 'Зелёные: следующий оттенок', brown: 'Коричневые: следующий оттенок',
    gold: 'Золотые: следующий оттенок', graphite: 'Графитовые: следующий оттенок',
  };
  const families = Object.keys(palettes);
  let selection = null;
  try {
    const saved = JSON.parse(sessionStorage.getItem(STORAGE_KEY));
    if (families.includes(saved?.family) && Number.isInteger(saved.index)
        && saved.index >= 0 && saved.index < palettes[saved.family].length) selection = saved;
  } catch {}
  let family = selection?.family || null;
  const indexes = Object.fromEntries(families.map(name => [name, 0]));
  if (family) indexes[family] = selection.index;
  const root = document.documentElement;
  const style = document.createElement('style');
  style.textContent = `
    :root[data-control-colors] :is(.topbar, .chart-tools, .studio .chart-view-tools) {
      --mode-accent: var(--preview-accent);
      --mode-selected: var(--preview-fill);
      --mode-selected-ink: var(--preview-ink);
      --mode-selected-border: var(--preview-border);
      --floating-control-border: var(--preview-edge);
      --floating-control-border-hover: var(--preview-idle);
      --control-focus: var(--preview-idle);
    }
    :root[data-control-colors] :is(.topbar, .chart-tools) :is(.icon-button, .mandala-switch):not([aria-pressed='true']):not([aria-checked='true']):not([aria-expanded='true']) {
      color: var(--preview-idle);
    }
    .control-color-previews {
      display: flex; gap: 6px;
      flex: 0 0 100%; margin: 4px 0 8px;
    }
    .control-color-preview {
      position: relative; display: inline-flex; align-items: center; justify-content: center; gap: 7px;
      flex: 1; min-width: 0; max-width: 62px; height: 32px; padding: 0; border: 1px solid var(--swatch-edge);
      border-radius: var(--floating-control-radius); background: var(--canvas-background);
      color: var(--swatch-idle); font-size: 12px; font-weight: 500;
      font-variant-numeric: tabular-nums; line-height: 1; touch-action: manipulation;
    }
    .control-color-preview::before { content: ''; position: absolute; inset: -6px 0; }
    .control-color-preview::after { content: ''; width: 8px; height: 8px; border-radius: 50%; background: var(--swatch-accent); order: -1; }
    .control-color-preview[aria-pressed='true'] { border-color: var(--swatch-idle); box-shadow: inset 0 0 0 1px var(--swatch-idle); }
    .control-color-preview:focus-visible { outline: 2px solid var(--swatch-idle); outline-offset: 3px; }
    @media (hover: hover) and (pointer: fine) {
      .control-color-preview:hover { border-color: var(--swatch-idle); }
    }
  `;
  document.head.append(style);
  const group = document.createElement('div');
  group.className = 'control-color-previews';
  group.id = 'controlColorPreviews';
  group.hidden = !family;
  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.id = 'toggleControlColors';
  toggle.className = 'sidebar-tool';
  toggle.textContent = 'Палитры';
  toggle.setAttribute('aria-controls', group.id);
  toggle.setAttribute('aria-expanded', String(!group.hidden));
  toggle.setAttribute('aria-pressed', String(!group.hidden));
  toggle.addEventListener('click', () => {
    group.hidden = !group.hidden;
    toggle.setAttribute('aria-expanded', String(!group.hidden));
    toggle.setAttribute('aria-pressed', String(!group.hidden));
  });
  const controls = families.map(name => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'control-color-preview';
    button.title = labels[name];
    button.setAttribute('aria-label', button.title);
    button.setAttribute('aria-describedby', `controlColorNumber-${name}`);
    const counter = document.createElement('span');
    counter.id = `controlColorNumber-${name}`;
    button.append(counter);
    group.append(button);
    button.addEventListener('click', () => {
      // First choose the family's last swatch; repeated taps cycle its five shades.
      if (family === name) indexes[name] = (indexes[name] + 1) % palettes[name].length;
      family = name;
      paint();
      try { sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ family, index: indexes[family] })); } catch {}
    });
    return { name, button, counter };
  });
  const footer = document.querySelector('.sidebar-footer');
  footer.prepend(group);
  footer.append(toggle);

  function paint() {
    if (family) {
      root.dataset.controlColors = String(indexes[family] + 1);
      for (const [role, value] of Object.entries(palettes[family][indexes[family]])) root.style.setProperty(`--preview-${role}`, value);
    }
    for (const { name, button, counter } of controls) {
      const swatch = palettes[name][indexes[name]];
      button.setAttribute('aria-pressed', String(family === name));
      for (const role of ['accent', 'idle', 'edge']) button.style.setProperty(`--swatch-${role}`, swatch[role]);
      counter.textContent = `${indexes[name] + 1}/${palettes[name].length}`;
    }
  }
  paint();
}
