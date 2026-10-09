import { capturePlanetTarget, updatePlanetTarget } from './activation-targets.js';
import { createOverlayActivationPainter } from './overlay-activation-columns.js';
import { isChartOverlay, primaryChart } from '../domain/chart-composition.js';
import { describeActivationColumns, renderActivationColumn, renderActivationRow, fixingMark, fixingPath, alignPersonalityHeading, renderPlanetFilterControl, planetFilterMark } from './activation-columns.js';
import { setAttribute, setAttributes, svgNodes } from './svg-patches.js';
import { ACTIVATION_COLUMN_LAYOUT, activationHeadingX } from './geometry/activation-layout.js';

const text = (node, value) => { if (node.textContent !== String(value)) node.textContent = String(value); };
const elementFrom = (parent, markup) => svgNodes(parent, markup).find(node => node.nodeType === 1);
const activationValues = entries => Array.isArray(entries) ? entries.map(entry => [entry?.planet, entry?.gate, entry?.line]) : null;

// Snapshot only facts used by column models, including the filtered contributors
// to line fixings and the full records retained for unchecked rows. Exact
// longitudes continue through the separate mandala, Variable and detail owners.
function columnInput(chart, state, options) {
  if (!options.showActivations) return 'hidden';
  chart = primaryChart(chart);
  if (chart.source === 'manual') return 'manual';
  const filter = chart.planetFilter;
  return JSON.stringify([chart.source,
    activationValues(chart.activations?.design), activationValues(chart.activations?.personality),
    filter ? [filter.perPlanetControls === true, filter.selectedPlanets, filter.selectedDesignPlanets,
      activationValues(filter.activations), activationValues(filter.designActivations)] : null,
    [...state.relatedGates], [...state.committedGates], [...state.previewGates],
    state.visualSelections.map(value => [value.type, value.id]),
    state.committedSelections.map(value => [value.type, value.id]), options.activationFilter]);
}

function captureRow(row) {
  const planet = row.querySelector('.bg-planet');
  const gate = row.querySelector('[data-type="gate"]');
  const value = gate.querySelector('text');
  return { row, planet, gate, value, line: value.querySelector('tspan'),
    planetTarget: capturePlanetTarget(planet), gateRect: gate.querySelector('rect'),
    fixing: row.querySelector('.line-fixing'), filter: row.querySelector('.activation-planet-filter'), previous: null };
}
function captureColumn(node) {
  const rows = new Map([...node.querySelectorAll('.activation-row')].map(row => {
    const entry = captureRow(row); return [entry.gate.dataset.activation, entry];
  }));
  return { node, rows, heading: node.querySelector('.activation-heading'), rule: node.querySelector('.activation-header-rule'),
    content: node.querySelector('.activation-block-content'), filter: node.querySelector(`.activation-planet-filter[data-id="${node.dataset.source === 'design' ? 'design:' : ''}all"]`), label: null };
}

function updatePlanetFilter(control, checked, name) {
  setAttribute(control, 'aria-checked', checked);
  setAttribute(control, 'aria-label', name);
  text(control.querySelector('title'), name);
  setAttributes(control.querySelector('.activation-planet-filter-mark'), { d: planetFilterMark(checked), opacity: checked === false ? 0 : 1 });
}

// Numeric and planet targets keep their identity when gates, lines, selection or
// fixing change. Structural changes affect only the relevant source/planet row.
export function createActivationPainter(root, rendered = null) {
  const drawing = root.querySelector('.bodygraph-drawing');
  const cycleColumns = createOverlayActivationPainter(drawing, rendered);
  let group = [...drawing.querySelectorAll('.activation-columns')].find(node => !node.classList.contains('cycle-activation-columns')) || null, headingKey = null;
  let previousInput = null;
  const columns = new Map([...drawing.querySelectorAll('.activation-column')].filter(node => !node.dataset.cycleOrigin).map(node => [node.dataset.source, captureColumn(node)]));
  if (rendered && !isChartOverlay(rendered.chart)) {
    previousInput = columnInput(rendered.chart, rendered.state, rendered.options);
    if (group) {
      for (const column of columns.values()) column.label = column.heading.textContent;
      const personality = columns.get('personality'), sun = personality?.rows.get('personality-sun');
      headingKey = `${personality?.label || ''}:${sun?.value.textContent || '.'}`;
      // Static markup already contains these rows; only real DOM measurement
      // remains on mount. Adopting its input avoids a second model build.
      alignPersonalityHeading(root);
    }
  }

  function updateRow(entry, row) {
    const key = JSON.stringify([row.gate, row.line, row.selected, row.pressed, row.fixing, row.planetTarget.selected, row.planetTarget.pressed, row.label, row.hasPlanetControl, row.planetEnabled]);
    if (key === entry.previous) return;
    entry.previous = key;
    if (row.hasPlanetControl) {
      if (!entry.filter) {
        entry.filter = elementFrom(entry.row, renderPlanetFilterControl(row.filterId, row.planetAria, row.planetEnabled));
        entry.row.insertBefore(entry.filter, entry.planet);
      }
      updatePlanetFilter(entry.filter, row.planetEnabled, row.planetAria);
    } else if (entry.filter) { entry.filter.remove(); entry.filter = null; }
    updatePlanetTarget(entry.planetTarget, row.planetTarget);
    setAttributes(entry.gate, { 'data-id': row.gate, 'data-selected': row.selected, 'aria-label': row.gateAria, 'aria-pressed': row.pressed,
      opacity: row.planetEnabled ? null : '.22' });
    setAttribute(entry.gateRect, 'fill', row.selected ? '#eaf0f8' : 'transparent');
    if (entry.value.firstChild.nodeValue !== String(row.gate)) entry.value.firstChild.nodeValue = String(row.gate);
    text(entry.line, `.${row.line}`);
    if (row.fixingLabel) {
      if (!entry.fixing) {
        entry.fixing = elementFrom(entry.row, fixingMark(row.fixing));
        entry.row.appendChild(entry.fixing);
      } else {
        setAttribute(entry.fixing, 'data-fixing', row.fixing);
        setAttribute(entry.fixing.querySelector('path'), 'd', fixingPath(row.fixing));
      }
    } else if (entry.fixing) { entry.fixing.remove(); entry.fixing = null; }
  }

  return {
    update(chart, state, options = {}) {
      if (isChartOverlay(chart)) {
        group?.remove(); group = null; columns.clear(); previousInput = null; headingKey = null;
        cycleColumns.update(chart, state, options.showActivations, options);
        return;
      }
      cycleColumns.clear();
      const input = columnInput(chart, state, options);
      if (input === previousInput) return;
      const models = options.showActivations ? describeActivationColumns(chart, state.relatedGates, state.committedSelection, {
        pressedGates: state.committedGates, pressedSelection: state.committedSelection,
        selections: state.visualSelections, pressedSelections: state.committedSelections,
        activationFilter: options.activationFilter, previewGates: state.previewGates,
      }) : [];
      const sources = new Set(models.map(column => column.source));
      for (const [source, column] of columns) if (!sources.has(source)) { column.node.remove(); columns.delete(source); }
      if (!models.length) { group?.remove(); group = null; headingKey = null; previousInput = input; return; }
      if (!group) {
        group = drawing.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'g');
        group.setAttribute('class', 'activation-columns'); drawing.insertBefore(group, drawing.firstChild);
      }
      for (const model of models) {
        let column = columns.get(model.source);
        if (!column) {
          const node = elementFrom(group, renderActivationColumn(model));
          group.insertBefore(node, model.source === 'design' ? group.firstChild : null);
          column = captureColumn(node); columns.set(model.source, column);
        }
        if (column.label !== model.label) {
          text(column.heading, model.label);
          setAttributes(column.heading, { x: activationHeadingX(model.source), 'text-anchor': null });
          setAttribute(column.rule, 'd', `M ${activationHeadingX(model.source)} ${ACTIVATION_COLUMN_LAYOUT.ruleY} h ${model.headingWidth}`);
          column.label = model.label;
        }
        if (model.hasMasterControl) {
          if (!column.filter) {
            column.filter = elementFrom(column.content, renderPlanetFilterControl(model.filterId, `${model.label}, все планеты`, model.allPlanetsChecked, `translate(${model.x} ${ACTIVATION_COLUMN_LAYOUT.headingY - 6})`));
            column.content.insertBefore(column.filter, column.content.querySelector('.activation-row'));
          }
          updatePlanetFilter(column.filter, model.allPlanetsChecked, `${model.label}, все планеты`);
        } else if (column.filter) { column.filter.remove(); column.filter = null; }
        const ids = new Set(model.rows.map(row => row.id));
        for (const [id, row] of column.rows) if (!ids.has(id)) { row.row.remove(); column.rows.delete(id); }
        let next = null;
        for (const row of [...model.rows].reverse()) {
          let entry = column.rows.get(row.id);
          if (!entry) {
            const node = elementFrom(column.content, renderActivationRow(row));
            entry = captureRow(node); column.rows.set(row.id, entry);
            column.content.insertBefore(node, next);
          } else if (entry.row.nextElementSibling !== next) column.content.insertBefore(entry.row, next);
          updateRow(entry, row); next = entry.row;
        }
      }
      const personality = models.find(column => column.source === 'personality');
      const sun = personality?.rows.find(row => row.planet === 'sun');
      const nextHeadingKey = `${personality?.label || ''}:${sun?.gate || ''}.${sun?.line || ''}`;
      if (headingKey !== nextHeadingKey) { alignPersonalityHeading(root); headingKey = nextHeadingKey; }
      previousInput = input;
    },
  };
}
