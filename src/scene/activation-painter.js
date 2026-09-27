import { describeActivationColumns, renderActivationColumn, renderActivationRow, fixingMark, fixingPath, alignPersonalityHeading } from './activation-columns.js';
import { setAttribute, setAttributes, svgNodes } from './svg-patches.js';

const text = (node, value) => { if (node.textContent !== String(value)) node.textContent = String(value); };
const elementFrom = (parent, markup) => svgNodes(parent, markup).find(node => node.nodeType === 1);

function captureRow(row) {
  const planet = row.querySelector('[data-type="planet"]');
  const gate = row.querySelector('[data-type="gate"]');
  const value = gate.querySelector('text');
  return { row, planet, gate, value, line: value.querySelector('tspan'),
    planetTitle: planet.querySelector('title'), gateTitle: gate.querySelector('title'),
    planetRect: planet.querySelector('rect'), gateRect: gate.querySelector('rect'),
    fixing: row.querySelector('.line-fixing'), previous: null };
}
function captureColumn(node) {
  const rows = new Map([...node.querySelectorAll('.activation-row')].map(row => {
    const entry = captureRow(row); return [entry.planet.dataset.id, entry];
  }));
  return { node, rows, heading: node.querySelector('.activation-heading'), rule: node.querySelector('.activation-header-rule'),
    content: node.querySelector('.activation-block-content'), label: null };
}

// Numeric and planet targets keep their identity when gates, lines, selection or
// fixing change. Structural changes affect only the relevant source/planet row.
export function createActivationPainter(root) {
  const drawing = root.querySelector('.bodygraph-drawing');
  let group = drawing.querySelector('.activation-columns'), headingKey = null;
  const columns = new Map([...drawing.querySelectorAll('.activation-column')].map(node => [node.dataset.source, captureColumn(node)]));

  function updateRow(entry, row) {
    const key = JSON.stringify([row.gate, row.line, row.selected, row.pressed, row.fixing, row.planetSelected, row.planetPressed, row.label]);
    if (key === entry.previous) return;
    entry.previous = key;
    setAttributes(entry.planet, { 'aria-label': row.planetAria, 'aria-pressed': row.planetPressed });
    text(entry.planetTitle, row.planetTitle);
    setAttribute(entry.planetRect, 'fill', row.planetSelected ? '#eaf0f8' : 'transparent');
    setAttributes(entry.gate, { 'data-id': row.gate, 'data-selected': row.selected, 'aria-label': row.gateAria, 'aria-pressed': row.pressed });
    text(entry.gateTitle, row.gateTitle);
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
      const models = options.showActivations ? describeActivationColumns(chart, state.relatedGates, state.committedSelection, {
        pressedGates: state.committedGates, pressedSelection: state.committedSelection,
        selections: state.visualSelections, pressedSelections: state.committedSelections,
        activationFilter: options.activationFilter, previewGates: state.previewGates,
      }) : [];
      const sources = new Set(models.map(column => column.source));
      for (const [source, column] of columns) if (!sources.has(source)) { column.node.remove(); columns.delete(source); }
      if (!models.length) { group?.remove(); group = null; headingKey = null; return; }
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
          setAttributes(column.heading, { x: model.x - 2, 'text-anchor': null });
          setAttribute(column.rule, 'd', `M ${model.x - 2} 88 h ${model.headingWidth}`);
          column.label = model.label;
        }
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
    },
  };
}
