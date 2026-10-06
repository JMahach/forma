import { OVERLAY_SOURCES, OVERLAY_PALETTE, overlayOriginLabel } from '../domain/chart-overlay.js';
import { isChartOverlay } from '../domain/chart-composition.js';
import { PLANETS } from '../domain/planets.js';
import { activationRowY, overlayActivationColumnLayout } from './geometry/activation-layout.js';
import { setAttribute, setAttributes, svgNodes } from './svg-patches.js';
import { escapeHtml as esc } from '../ui/html.js';

const valid = entry => entry && Number.isInteger(entry.gate) && entry.gate >= 1 && entry.gate <= 64
  && Number.isInteger(entry.line) && entry.line >= 1 && entry.line <= 6;
const sourceAt = (origin, source) => OVERLAY_SOURCES.find(item => item.origin === origin && item.source === source);

// Content, source selection and paint share one model in both rendering paths.
function describeOverlayActivationColumns(chart, selected = new Set(), pressed = selected, { activationFilter = null, previewGates = new Set(), showMandala = false } = {}) {
  if (!isChartOverlay(chart)) return [];
  const filteredGroups = activationFilter?.groups || (activationFilter ? [activationFilter] : []);
  const unfilteredGates = new Set(activationFilter?.unfilteredGates || []);
  return [['natal', chart.primary], ['cycle', chart.secondary]].map(([origin, owner], index) => {
    const side = index ? 'personality' : 'design';
    const label = overlayOriginLabel(chart, origin);
    const records = Object.fromEntries(['design', 'personality'].map(source => {
      const entries = new Map();
      for (const entry of owner?.source === 'manual' ? [] : owner?.activations?.[source] || []) if (!entries.has(entry?.planet)) entries.set(entry?.planet, entry);
      return [source, entries];
    }));
    const sources = ['design', 'personality'].filter(source => [...records[source].values()].some(valid));
    const single = sources.length === 1;
    const geometry = overlayActivationColumnLayout(side, { single, showMandala, label });
    const rows = PLANETS.map(([planet, symbol, name], rowIndex) => ({ planet, symbol, name, x: geometry.x, y: activationRowY(rowIndex),
      values: sources.flatMap((source, sourceIndex) => {
        const entry = records[source].get(planet);
        if (!valid(entry)) return [];
        const provenance = sourceAt(origin, source);
        // The overlay summary describes birth facts. Its line groups select
        // natal rows only; ordinary gate selection and hover still span both maps.
        const matchesFilter = !activationFilter || unfilteredGates.has(entry.gate)
          || origin === 'natal' && filteredGroups.some(group => entry.line === group.line
            && (group.source === 'all' || group.source === source)
            && (!group.gates || group.gates.includes(entry.gate)));
        return [{ ...provenance, ...geometry.values[sourceIndex], color: OVERLAY_PALETTE[origin], id: `${provenance.id}-${planet}`, planet, gate: entry.gate, line: entry.line,
          selected: selected.has(entry.gate) && matchesFilter || previewGates.has(entry.gate),
          pressed: pressed.has(entry.gate) && matchesFilter,
          label: `${label}, ${source === 'design' ? 'Дизайн' : 'Личность'}, ${name}: ворота ${entry.gate}, линия ${entry.line}` }];
      }),
    }));
    return { ...geometry, origin, side, label, rows };
  });
}

function valueMarkup(value) {
  return `<g class="bg-activation cycle-activation-value" data-type="gate" data-id="${value.gate}" data-activation="${value.id}" data-cycle-source="${value.origin}-${value.source}" data-selected="${value.selected}" tabindex="0" role="button" aria-label="${esc(value.label)}" aria-pressed="${value.pressed}" fill="${value.color}" transform="translate(${value.x} 0)">
    <title>${esc(value.label)}</title><rect x="${value.rectX}" y="${value.hitY}" width="${value.hitWidth}" height="${value.hitHeight}" rx="${value.hitRadius}" fill="${value.selected ? '#eaf0f8' : 'transparent'}"/>
    <text x="${value.textX}" y="0" dominant-baseline="central" font-size="${value.fontSize}" font-weight="500" pointer-events="none">${value.gate}<tspan font-weight="400" opacity=".7">.${value.line}</tspan></text>
  </g>`;
}

export function renderOverlayActivationColumns(chart, selected, pressed, options) {
  return columnsMarkup(describeOverlayActivationColumns(chart, selected, pressed, options));
}

function columnsMarkup(columns) {
  if (!columns.length) return '';
  return `<g class="activation-columns cycle-activation-columns">${columns.map(column => `<g class="activation-column" data-source="${column.side}" data-cycle-origin="${column.origin}" data-cycle-layout="${column.layout}" font-family="Inter, -apple-system, BlinkMacSystemFont, sans-serif" style="font-variant-numeric: tabular-nums">
    <g class="activation-block-content" transform="${column.transform}">
      <svg class="activation-heading-viewport" x="${column.headingX}" y="${column.headingTop}" width="${column.headingWidth}" height="${column.headingHeight}" viewBox="${column.headingX} ${column.headingTop} ${column.headingWidth} ${column.headingHeight}" overflow="hidden" aria-label="${esc(column.label)}"><title>${esc(column.label)}</title><text class="activation-heading" x="${column.headingX}" y="${column.headingY}" fill="${OVERLAY_PALETTE[column.origin]}" font-size="${column.headingSize}" font-weight="500">${esc(column.label)}</text></svg>
      <path class="activation-header-rule" d="M ${column.headingX} ${column.ruleY} h ${column.headingWidth}" stroke="#8e897e" stroke-opacity=".25" stroke-width="1" fill="none"/>
      <g class="cycle-source-headings"${column.single ? ' display="none"' : ''}>
        <text x="${column.captionX[0]}" y="${column.captionY}" text-anchor="middle" fill="${OVERLAY_PALETTE[column.origin]}" font-size="${column.captionSize}">Дизайн</text>
        <text x="${column.captionX[1]}" y="${column.captionY}" text-anchor="middle" fill="${OVERLAY_PALETTE[column.origin]}" font-size="${column.captionSize}">Личность</text>
      </g>
      ${column.rows.map(row => `<g class="cycle-activation-row" data-cycle-planet="${row.planet}" transform="translate(${row.x} ${row.y})"><text class="planet-symbol" x="${column.glyphX}" y="0" fill="${OVERLAY_PALETTE[column.origin]}" text-anchor="middle" dominant-baseline="central" font-size="${column.glyphSize}" pointer-events="none">${row.symbol}</text>${row.values.map(valueMarkup).join('')}</g>`).join('')}
    </g>
  </g>`).join('')}</g>`;
}

// Exact longitude still updates the wheel and popover, but cannot change the
// rows. Snapshot column inputs so mutable caller arrays remain observable.
function columnInput(chart, state, options) {
  return JSON.stringify([chart.kind, overlayOriginLabel(chart, 'natal'), Boolean(options.showMandala),
    ...[chart.primary, chart.secondary].map(owner => ['design', 'personality'].map(source =>
      (owner?.source === 'manual' ? [] : owner?.activations?.[source] || []).map(entry => [entry?.planet, entry?.gate, entry?.line]))),
    [...state.relatedGates], [...state.committedGates], [...state.previewGates], options.activationFilter]);
}

export function createOverlayActivationPainter(drawing, rendered = null) {
  let group = drawing.querySelector('.cycle-activation-columns');
  let values = new Map(), columns = new Map(), previousInput = null;
  const captureValue = node => ({ node, title: node.querySelector('title'), rect: node.querySelector('rect'),
    text: node.querySelector('text'), line: node.querySelector('tspan'), previous: null });
  function capture() {
    values = new Map([...group.querySelectorAll('.cycle-activation-value')].map(node => [node.dataset.activation, captureValue(node)]));
    columns = new Map([...group.querySelectorAll('[data-cycle-origin]')].map(node => [node.dataset.cycleOrigin, {
      node, heading: node.querySelector('.activation-heading'), headingViewport: node.querySelector('.activation-heading-viewport'),
      headingTitle: node.querySelector('.activation-heading-viewport title'), rule: node.querySelector('.activation-header-rule'),
      sourceHeadings: node.querySelector('.cycle-source-headings'), captions: [...node.querySelectorAll('.cycle-source-headings text')], layout: node.dataset.cycleLayout,
      rows: new Map([...node.querySelectorAll('[data-cycle-planet]')].map(row => [row.dataset.cyclePlanet, { node: row, glyph: row.querySelector('.planet-symbol') }])),
    }]));
  }
  function clear() { group?.remove(); group = null; values.clear(); columns.clear(); previousInput = null; }
  if (group) {
    capture();
    if (isChartOverlay(rendered?.chart) && rendered.options?.showActivations) {
      previousInput = columnInput(rendered.chart, rendered.state, rendered.options);
    }
  }
  return {
    update(chart, state, visible, options = {}) {
      if (!isChartOverlay(chart) || !visible) { clear(); return; }
      const input = columnInput(chart, state, options);
      if (input === previousInput) return;
      const selectionOptions = { activationFilter: options.activationFilter, previewGates: state.previewGates, showMandala: options.showMandala };
      const models = describeOverlayActivationColumns(chart, state.relatedGates, state.committedGates, selectionOptions);
      if (!group) {
        group = svgNodes(drawing, columnsMarkup(models)).find(node => node.nodeType === 1);
        drawing.insertBefore(group, drawing.firstChild); capture(); previousInput = input; return;
      }
      const nextIds = new Set();
      for (const column of models) {
        const record = columns.get(column.origin);
        if (record.heading.textContent !== column.label) record.heading.textContent = column.label;
        if (record.headingTitle.textContent !== column.label) record.headingTitle.textContent = column.label;
        setAttributes(record.headingViewport, { x: column.headingX, width: column.headingWidth,
          viewBox: `${column.headingX} ${column.headingTop} ${column.headingWidth} ${column.headingHeight}`, 'aria-label': column.label });
        setAttribute(record.rule, 'd', `M ${column.headingX} ${column.ruleY} h ${column.headingWidth}`);
        if (record.layout !== column.layout) {
          setAttribute(record.node, 'data-cycle-layout', column.layout);
          setAttribute(record.heading, 'x', column.headingX);
          setAttribute(record.sourceHeadings, 'display', column.single ? 'none' : null);
          record.captions.forEach((caption, index) => setAttributes(caption, { x: column.captionX[index], 'font-size': column.captionSize }));
          for (const row of column.rows) {
            const target = record.rows.get(row.planet);
            setAttributes(target.glyph, { x: column.glyphX, 'font-size': column.glyphSize });
            setAttribute(target.node, 'transform', `translate(${row.x} ${row.y})`);
          }
          record.layout = column.layout;
        }
      }
      for (const column of models) for (const row of column.rows) for (const value of row.values) {
        nextIds.add(value.id);
        let record = values.get(value.id);
        if (!record) {
          const rowNode = columns.get(column.origin).rows.get(row.planet).node;
          const node = svgNodes(rowNode, valueMarkup(value)).find(node => node.nodeType === 1);
          const before = value.source === 'design' ? values.get(`${column.origin}-personality-${row.planet}`)?.node || null : null;
          rowNode.insertBefore(node, before);
          record = captureValue(node); values.set(value.id, record);
        }
        const key = JSON.stringify([value.gate, value.line, value.selected, value.pressed, value.label, column.layout]);
        if (key === record.previous) continue;
        record.previous = key;
        setAttributes(record.node, { 'data-id': value.gate, 'data-selected': value.selected,
          'aria-label': value.label, 'aria-pressed': value.pressed, transform: `translate(${value.x} 0)` });
        if (record.title.textContent !== value.label) record.title.textContent = value.label;
        setAttribute(record.rect, 'fill', value.selected ? '#eaf0f8' : 'transparent');
        setAttributes(record.rect, { x: value.rectX, width: value.hitWidth });
        setAttributes(record.text, { x: value.textX, 'font-size': value.fontSize });
        if (record.text.firstChild.nodeValue !== String(value.gate)) record.text.firstChild.nodeValue = String(value.gate);
        if (record.line.textContent !== `.${value.line}`) record.line.textContent = `.${value.line}`;
      }
      for (const [id, record] of values) if (!nextIds.has(id)) { record.node.remove(); values.delete(id); }
      previousInput = input;
    },
    clear,
  };
}
