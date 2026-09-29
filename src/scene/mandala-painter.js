import { renderCrossPreview } from './mandala.js';
import { MANDALA_PALETTE as PALETTE, MANDALA_OPACITY, mandalaGateSets, mandalaSectorPaint, mandalaPlanetEntries, mandalaPlanetPaint } from './mandala-paint-rules.js';
import { MANDALA_SECTORS, MANDALA_GEOMETRY, MANDALA_CENTER, mandalaPoint, mandalaPointString } from './geometry/mandala-geometry.js';
import { MANDALA_PLANET_LAYOUT, layoutMandalaPlanets } from './geometry/mandala-planets.js';
import { setAttribute as attr } from './svg-patches.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
function element(document, tag, attributes) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, String(value));
  return node;
}

// Only these small, renderer-owned sibling lists are reconciled. Unchanged
// nodes are not moved: this preserves focus and avoids needless DOM mutations.
function children(parent, desired) {
  let cursor = parent.firstElementChild;
  for (const node of desired) {
    if (node === cursor) cursor = cursor.nextElementSibling;
    else parent.insertBefore(node, cursor);
  }
  while (cursor) {
    const next = cursor.nextElementSibling;
    parent.removeChild(cursor);
    cursor = next;
  }
}

function markerRecord(node) {
  return { node, ray: node.querySelector('.mandala-planet-ray'), endpoint: node.querySelector('.mandala-planet-endpoint'),
    leader: node.querySelector('.mandala-planet-leader') };
}

function crossRecord(node) {
  const positions = [...node.querySelectorAll('.mandala-cross-position')].map(mark => ({
    mark, ray: mark.querySelector('.mandala-cross-preview-ray'), circle: mark.querySelector('circle'),
  }));
  return {
    node, positions, cursor: node.querySelector('.mandala-cross-cursor'),
    key: positions.map(({ mark }) => ['data-source', 'data-cross-planet', 'data-cross-gate']
      .map(name => mark.getAttribute(name)).join(':')).join('|'),
  };
}

/**
 * Paint an existing renderMandala scaffold synchronously for every input.
 * root is the stable viewport/container, or the .bodygraph-mandala itself.
 * Replacing the wheel is detected automatically. Call reset() if a caller
 * rebuilds children inside the same wheel element. A missing scaffold returns
 * false and is never constructed here. No chart or selection state is owned.
 */
export function createMandalaPainter(root) {
  let cache = null;
  const reset = () => { cache = null; };

  function capture(wheel) {
    const field = wheel.querySelector('.mandala-field');
    const edge = wheel.querySelector('.mandala-engraving-edge');
    const labels = wheel.querySelector('.mandala-planet-labels');
    const gates = new Map([...wheel.querySelectorAll('.mandala-gate')]
      .map(node => [Number(node.getAttribute('data-mandala-gate')), node]));
    if (!field || !edge || !labels || MANDALA_SECTORS.some(({ gate }) => !gates.has(gate))) return null;
    const fans = new Map([...field.querySelectorAll('.mandala-fan')]
      .map(node => [`${node.getAttribute('data-mandala-gate')}:${node.getAttribute('data-mandala-source')}`, node]));
    const focus = new Map([...field.querySelectorAll('.mandala-focus-sector')]
      .map(node => [Number(node.getAttribute('data-mandala-gate')), node]));
    const sectors = MANDALA_SECTORS.map(geometry => {
      const node = gates.get(geometry.gate);
      return {
        geometry, node,
        fills: new Map([...node.querySelectorAll('.mandala-source')].map(group => [group.getAttribute('data-mandala-source'),
          { node: group, path: group.querySelector('.mandala-sector-fill') }])),
        highlight: node.querySelector('.mandala-gate-highlight'), separator: node.querySelector('.mandala-separator'),
        number: node.querySelector('.mandala-number'), hit: node.querySelector('.mandala-gate-hit'),
      };
    });
    if (sectors.some(sector => !sector.highlight || !sector.separator || !sector.number)) return null;
    return {
      wheel, field, edge, labels, sectors, fans, focus, sectorKey: null, sectorFieldNodes: [],
      symbols: new Map([...labels.querySelectorAll('.mandala-planet-symbol')].map(node =>
        [`${node.getAttribute('data-source')}:${node.getAttribute('data-mandala-planet')}`, node])),
      markers: new Map([...field.querySelectorAll('.mandala-planet-marker')].map(node =>
        [`${node.getAttribute('data-source')}:${node.getAttribute('data-mandala-planet')}`, markerRecord(node)])),
      pinned: [...wheel.querySelectorAll('.mandala-cross-pinned')].map(crossRecord),
      preview: wheel.querySelector('.mandala-cross-preview') ? crossRecord(wheel.querySelector('.mandala-cross-preview')) : null,
    };
  }

  function updateCross(previous, cross, pinned, document) {
    // Share validation and the uncommon structural template with the string
    // renderer. This is at most a four-mark overlay, never the complete wheel.
    const markup = renderCrossPreview(cross, { pinned });
    if (!markup) return null;
    const key = cross.positions.map(position => `${position.source}:${position.planet}:${position.gate}`).join('|');
    let record = previous;
    if (!record || record.key !== key || record.positions.length !== 4 || !record.cursor
      || !record.node.contains(record.cursor)
      || record.positions.some(({ mark, ray, circle }) => !ray || !circle
        || !record.node.contains(mark) || !mark.contains(ray) || !mark.contains(circle))) {
      const fragment = document.createElementNS(SVG_NS, 'g');
      fragment.innerHTML = markup;
      record = crossRecord(fragment.firstElementChild);
    }
    // Read actual attributes, not last markup: the independent fast preview
    // painter may have moved these nodes since the preceding ordinary update.
    cross.positions.forEach((position, index) => {
      const { mark, ray, circle } = record.positions[index];
      const [x, y] = mandalaPoint(position.longitude, MANDALA_GEOMETRY.innerRadius);
      attr(mark, 'data-longitude', position.longitude);
      attr(ray, 'd', `M ${MANDALA_CENTER} L ${x} ${y}`);
      attr(circle, 'cx', x); attr(circle, 'cy', y);
    });
    const cursorIndex = cross.positions.findIndex(position => position.source === (cross.source || 'personality') && position.planet === 'sun');
    const cursor = cross.positions[cursorIndex];
    attr(record.cursor, 'd', `M ${mandalaPointString(cursor.longitude, MANDALA_GEOMETRY.outerRadius - 3)} L ${mandalaPointString(cursor.longitude, MANDALA_GEOMETRY.outerRadius + 6)}`);
    attr(record.cursor, 'stroke', record.positions[cursorIndex].ray.getAttribute('stroke'));
    attr(record.node, 'data-cross-type', cross.type);
    return record;
  }

  function update(chart = {}, { interactive = true, selectedGates = new Set(), relatedGates = selectedGates,
    pinnedCrosses = [], previewCross = null } = {}) {
    const wheel = root.matches?.('.bodygraph-mandala') ? root : root.querySelector('.bodygraph-mandala');
    if (!wheel) { reset(); return false; }
    if (cache?.wheel !== wheel) cache = capture(wheel);
    if (!cache) return false;
    const document = wheel.ownerDocument;
    const gates = mandalaGateSets(chart);
    // Sectors depend on gates and selection, not on exact planet longitudes.
    // Snapshot values so reused, mutable chart arrays and option sets stay valid.
    const sectorKey = JSON.stringify([Boolean(interactive), [...gates.design], [...gates.personality],
      [...selectedGates], [...relatedGates]]);
    const refreshSectors = sectorKey !== cache.sectorKey;
    const fieldNodes = refreshSectors ? [] : [...cache.sectorFieldNodes];
    const nextFans = refreshSectors ? new Map() : cache.fans;
    const nextFocus = refreshSectors ? new Map() : cache.focus;
    attr(wheel, 'aria-hidden', interactive ? null : 'true');
    attr(wheel, 'pointer-events', interactive ? null : 'none');
    attr(wheel, 'focusable', interactive ? null : 'false');

    if (refreshSectors) for (const sector of cache.sectors) {
      const { geometry, node, highlight, separator, number } = sector;
      const { gate, ring, fan } = geometry;
      const paint = mandalaSectorPaint(geometry, gates, selectedGates, relatedGates);
      const { state, related } = paint;
      const fillNodes = [], nextFills = new Map();
      paint.sources.forEach(({ source, color, ring: sourceRing, fan: sourceFan }) => {
        const key = `${gate}:${source}`;
        const field = cache.fans.get(key) || element(document, 'path', {
          class: 'mandala-fan', 'data-mandala-gate': gate, 'data-mandala-source': source,
          fill: color, 'fill-opacity': MANDALA_OPACITY.fan,
        });
        attr(field, 'd', sourceFan);
        fieldNodes.push(field); nextFans.set(key, field);
        let fill = sector.fills.get(source);
        if (!fill) {
          const group = element(document, 'g', { class: 'mandala-source', 'data-mandala-source': source,
            fill: color, 'pointer-events': 'none' });
          const path = element(document, 'path', { class: 'mandala-sector-fill', 'fill-opacity': MANDALA_OPACITY.sector });
          group.appendChild(path); fill = { node: group, path };
        }
        attr(fill.path, 'd', sourceRing);
        fillNodes.push(fill.node); nextFills.set(source, fill);
      });
      if (related) {
        const field = cache.focus.get(gate) || element(document, 'path', {
          class: 'mandala-focus-sector', 'data-mandala-gate': gate, d: fan,
          fill: PALETTE.highlight, 'fill-opacity': MANDALA_OPACITY.focus,
        });
        fieldNodes.push(field); nextFocus.set(gate, field);
      }
      attr(node, 'class', `mandala-gate${interactive ? ' bg-interactive' : ''}`);
      attr(node, 'data-mandala-state', state); attr(node, 'data-related', related);
      for (const [name, value] of Object.entries({ 'data-type': 'gate', 'data-id': gate,
        role: 'button', tabindex: '0', 'aria-label': `Ворота ${gate}`, 'aria-pressed': paint.pressed })) {
        attr(node, name, interactive ? value : null);
      }
      attr(highlight, 'opacity', related ? '1' : '0');
      attr(number, 'fill', paint.color); attr(number, 'font-weight', paint.textWeight);
      if (interactive && !sector.hit) sector.hit = element(document, 'path', {
        class: 'mandala-gate-hit', d: ring, fill: 'transparent', 'pointer-events': 'all',
      });
      children(node, [...fillNodes, highlight, separator, number, ...(interactive ? [sector.hit] : [])]);
      if (!interactive) sector.hit = null;
      sector.fills = nextFills;
    }
    cache.fans = nextFans; cache.focus = nextFocus;
    if (refreshSectors) {
      cache.sectorKey = sectorKey;
      cache.sectorFieldNodes = [...fieldNodes];
    }

    // Rays, leaders and collision-aware labels still receive every exact input.
    const markers = new Map(), symbols = new Map(), labelNodes = [];
    for (const { source, planet, longitude, x: labelX, y: labelY, labelLongitude, leaderPath } of layoutMandalaPlanets(mandalaPlanetEntries(chart))) {
      const key = `${source}:${planet}`;
      const paint = mandalaPlanetPaint(source, planet);
      let record = cache.markers.get(key);
      if (!record) {
        const node = element(document, 'g', { class: 'mandala-planet-marker', 'data-mandala-planet': planet, 'data-source': source });
        const ray = element(document, 'path', { class: paint.rayClass,
          fill: 'none', stroke: paint.color, 'stroke-opacity': paint.rayOpacity, 'stroke-width': paint.rayWidth });
        const endpoint = element(document, 'circle', { class: 'mandala-planet-endpoint', r: paint.radius,
          fill: paint.color, 'fill-opacity': paint.endpointOpacity });
        const leader = element(document, 'path', { class: 'mandala-planet-leader', fill: 'none',
          stroke: paint.color, 'stroke-opacity': paint.leaderOpacity, 'stroke-width': paint.leaderWidth });
        node.appendChild(ray); node.appendChild(endpoint); node.appendChild(leader); record = { node, ray, endpoint, leader };
      }
      const [x, y] = mandalaPoint(longitude, MANDALA_GEOMETRY.innerRadius);
      attr(record.node, 'data-longitude', longitude);
      attr(record.ray, 'd', `M ${MANDALA_CENTER} L ${x} ${y}`);
      attr(record.endpoint, 'cx', x); attr(record.endpoint, 'cy', y);
      attr(record.leader, 'd', leaderPath);
      fieldNodes.push(record.node); markers.set(key, record);

      let symbol = cache.symbols.get(key);
      if (!symbol) {
        symbol = element(document, 'text', { class: 'mandala-planet-symbol', 'data-mandala-planet': planet, 'data-source': source,
          fill: paint.color, 'font-size': MANDALA_PLANET_LAYOUT.fontSize, 'text-anchor': 'middle', 'dominant-baseline': 'central',
          stroke: paint.symbolOutline, 'stroke-width': paint.symbolOutlineWidth, 'stroke-linejoin': 'round', 'paint-order': 'stroke' });
        symbol.textContent = paint.symbol;
      }
      attr(symbol, 'data-longitude', longitude); attr(symbol, 'data-label-longitude', labelLongitude);
      attr(symbol, 'x', labelX); attr(symbol, 'y', labelY);
      labelNodes.push(symbol); symbols.set(key, symbol);
    }
    children(cache.field, fieldNodes);
    children(cache.labels, labelNodes);
    cache.markers = markers;
    cache.symbols = symbols;

    const previous = [...cache.pinned, ...(cache.preview ? [cache.preview] : [])];
    const pinned = [];
    pinnedCrosses.forEach(cross => {
      const record = updateCross(cache.pinned[pinned.length], cross, true, document);
      if (record) pinned.push(record);
    });
    // Preserve the string renderer's raw source comparison, including undefined.
    const overlap = pinnedCrosses.some(cross => cross.longitude === previewCross?.longitude && cross.source === previewCross?.source);
    const preview = overlap ? null : updateCross(cache.preview, previewCross, false, document);
    const overlays = [...pinned, ...(preview ? [preview] : [])];
    const retained = new Set(overlays.map(record => record.node));
    for (const record of previous) if (!retained.has(record.node) && record.node.parentNode === wheel) wheel.removeChild(record.node);
    let anchor = cache.edge;
    for (let index = overlays.length - 1; index >= 0; index--) {
      const node = overlays[index].node;
      if (node.parentNode !== wheel || node.nextElementSibling !== anchor) wheel.insertBefore(node, anchor);
      anchor = node;
    }
    cache.pinned = pinned; cache.preview = preview;
    return true;
  }

  return { update, reset };
}
