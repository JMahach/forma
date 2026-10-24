import test from 'node:test';
import assert from 'node:assert/strict';
import { renderKnowledgeCenterFigure } from '../src/views/knowledge-center-figure.ts';
import { KNOWLEDGE_ENTRIES } from '../src/reference/knowledge-content.ts';
import { CENTERS, GATES, CHANNELS } from '../src/scene/geometry/chart-geometry.ts';
import { channelHalves, INTEGRATION_ARMS, pointString, roundedCenter, STEM_PATH } from '../src/scene/geometry/drawing-geometry.ts';
import { CHANNEL_WIDTH } from '../src/scene/geometry/drawing-presentation.ts';
import { PALETTE } from '../src/ui/chart-palette.ts';
import { SVG_NS, svgDocument } from './helpers/svg-dom.ts';

const centerEntries = KNOWLEDGE_ENTRIES.filter(entry => entry.kind === 'center');
const nativeId = (key: string | number) => ({ ego: 'heart', 'solar-plexus': 'solar' }[String(key)] ?? String(key));
function figure(entry: typeof KNOWLEDGE_ENTRIES[number], selected?: number | null) {
  const root = svgDocument().createElementNS(SVG_NS, 'div');
  root.innerHTML = renderKnowledgeCenterFigure(entry, selected);
  return root;
}

test('all nine native center silhouettes keep their own color, gate anchors and accessible gate targets', () => {
  assert.equal(centerEntries.length, 9);
  const seen: number[] = [];
  for (const entry of centerEntries) {
    const root = figure(entry), center = CENTERS.find(center => center.id === nativeId(entry.key))!;
    const shape = root.querySelector('.knowledge-center-outline');
    assert.ok(shape, entry.id);
    assert.equal(shape.getAttribute('d'), roundedCenter(center.points));
    assert.equal(shape.getAttribute('fill'), PALETTE[center.id as keyof typeof PALETTE]);
    assert.equal(shape.getAttribute('stroke-width'), '1.25');
    const gates = GATES.filter(gate => gate.center === center.id);
    assert.equal(root.querySelectorAll('.knowledge-center-gate').length, gates.length);
    for (const gate of gates) {
      const node = root.querySelector(`.knowledge-center-gate[data-gate-id="${gate.id}"]`)!;
      assert.ok(node, `${entry.id}: ${gate.id}`);
      seen.push(gate.id);
      assert.equal(node.getAttribute('transform'), `translate(${gate.x} ${gate.y})`);
      assert.equal(node.dataset.entryId, `gate.${gate.id}`);
      assert.equal(node.getAttribute('role'), 'button');
      assert.equal(node.getAttribute('tabindex'), '0');
      assert.match(node.getAttribute('aria-label')!, new RegExp(`Ворота ${gate.id}:`));
      assert.equal(node.querySelector('.knowledge-center-hit')?.getAttribute('r'), '12.5');
      assert.equal(node.querySelector('.knowledge-center-disc')?.getAttribute('r'), '9.5');
      assert.equal(node.querySelector('.knowledge-center-disc')?.getAttribute('fill'), 'transparent');
      assert.equal(node.querySelector('.knowledge-center-disc')?.getAttribute('stroke'), 'none');
      assert.equal(node.querySelector('text')?.textContent, String(gate.id));
      assert.equal(node.querySelector('text')?.getAttribute('font-size'), '9.9');
    }
  }
  assert.deepEqual(seen.sort((a, b) => a - b), Array.from({ length: 64 }, (_, index) => index + 1));
});

test('ordinary exits use the native background and only their own half for active paint', () => {
  for (const entry of centerEntries) {
    const root = figure(entry);
    for (const gate of GATES.filter(gate => gate.center === nativeId(entry.key))) {
      if (INTEGRATION_ARMS.some(arm => arm.gate === gate.id)) continue;
      const channel = CHANNELS.find(channel => channel.gates.includes(gate.id))!;
      const branch = root.querySelector(`.knowledge-center-branch[data-gate-id="${gate.id}"]`)!;
      assert.ok(branch, `exit ${gate.id}`);
      assert.equal(branch.querySelector('.knowledge-center-channel-outline')?.getAttribute('d'), channel.path);
      assert.equal(branch.querySelector('.knowledge-center-channel-outline')?.getAttribute('stroke-width'), String(CHANNEL_WIDTH.outline));
      assert.equal(branch.querySelector('.knowledge-center-channel')?.getAttribute('d'), channel.path);
      assert.equal(branch.querySelector('.knowledge-center-channel')?.getAttribute('stroke'), PALETTE.paper);
      const active = branch.querySelector('.knowledge-center-channel-active');
      assert.equal(active?.getAttribute('d'), pointString(channelHalves.get(channel.id)![channel.gates.indexOf(gate.id)]));
      assert.equal(active?.getAttribute('stroke'), PALETTE.ink);
      assert.notEqual(active?.getAttribute('d'), channel.path, `gate ${gate.id} must not paint the foreign end`);
    }
  }
});

test('integration uses one shared native arm per gate, without inventing three exits or painting the shared stem', () => {
  for (const arm of INTEGRATION_ARMS) {
    const gate = GATES.find(gate => gate.id === arm.gate)!;
    const entry = centerEntries.find(entry => nativeId(entry.key) === gate.center)!;
    const root = figure(entry, gate.id);
    const branches = root.querySelectorAll(`.knowledge-center-branch[data-gate-id="${gate.id}"]`);
    assert.equal(branches.length, 1, `single shared branch for ${gate.id}`);
    for (const name of ['knowledge-center-channel-outline', 'knowledge-center-channel', 'knowledge-center-channel-active']) {
      const path = branches[0].querySelector(`.${name}`)?.getAttribute('d');
      assert.equal(path, arm.path);
      assert.notEqual(path, STEM_PATH);
    }
  }
  const g = figure(centerEntries.find(entry => entry.id === 'center.g')!);
  assert.equal(g.querySelectorAll('.knowledge-center-branch').length, 8, 'G has eight ports, including just one arm at gate 10');
});

test('selection exposes consistent gate and branch attributes without selecting a foreign gate', () => {
  const entry = centerEntries.find(entry => entry.id === 'center.g')!;
  for (const selected of [null, 1, 10, 8]) {
    const root = figure(entry, selected);
    const expected = selected === 1 || selected === 10 ? [String(selected)] : [];
    for (const name of ['knowledge-center-gate', 'knowledge-center-branch']) {
      assert.deepEqual(root.querySelectorAll(`.${name}[data-selected="true"]`).map(node => node.dataset.gateId), expected);
      for (const node of root.querySelectorAll(`.${name}`)) assert.ok(['true', 'false'].includes(node.dataset.selected!));
    }
  }
});

test('local viewBoxes crop native exits around the center and retain a small instruction without a new card', () => {
  for (const entry of centerEntries) {
    const root = figure(entry), svg = root.querySelector('svg')!;
    assert.equal(svg.getAttribute('overflow'), 'hidden');
    const [x, y, width, height] = svg.getAttribute('viewBox')!.split(' ').map(Number);
    const center = CENTERS.find(center => center.id === nativeId(entry.key))!;
    const vertices = center.points.split(' ').map(pair => pair.split(',').map(Number));
    const left = Math.min(...vertices.map(point => point[0])), top = Math.min(...vertices.map(point => point[1]));
    const right = Math.max(...vertices.map(point => point[0])), bottom = Math.max(...vertices.map(point => point[1]));
    for (const margin of [left - x, top - y, x + width - right, y + height - bottom]) {
      assert.ok(margin >= 30 && margin <= 50, `${entry.id}: margin ${margin}`);
    }
    assert.equal(root.querySelector('figcaption')?.textContent, 'Выберите ворота, чтобы увидеть связи');
  }
  assert.equal(renderKnowledgeCenterFigure(KNOWLEDGE_ENTRIES.find(entry => entry.id === 'gate.1')!), '');
});
