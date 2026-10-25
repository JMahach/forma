import test from 'node:test';
import assert from 'node:assert/strict';
import { createGateLabelRenderer } from '../src/scene/gate-label.ts';
import { svgDocument, SVG_NS } from './helpers/svg-dom.ts';

test('gate numbers center their ink despite asymmetric side bearings and descenders', () => {
  const examples = [
    { id: 1, left: -1.5, right: 4.5, ascent: 7.2, descent: 0, x: -3, y: 3.6 },
    { id: 8, left: -.2, right: 5.8, ascent: 7.4, descent: .2, x: -3, y: 3.6 },
    { id: 64, left: -.5, right: 11.5, ascent: 7.4, descent: .2, x: -6, y: 3.6 },
  ];
  for (const e of examples) {
    const render = createGateLabelRenderer({ font: '', textAlign: '', textBaseline: '', measureText: () => ({
      actualBoundingBoxLeft: e.left, actualBoundingBoxRight: e.right,
      actualBoundingBoxAscent: e.ascent, actualBoundingBoxDescent: e.descent,
    }) });
    const root = svgDocument().createElementNS(SVG_NS, 'svg');
    root.innerHTML = render(e.id, '#ffffff');
    const text = root.querySelector('text')!;
    assert.equal(Number(text.getAttribute('x')), e.x);
    assert.equal(Number(text.getAttribute('y')), e.y);
    assert.equal(text.getAttribute('text-anchor'), 'start');
    assert.equal(text.textContent, String(e.id));
  }
});

test('server-side figures have a finite centered fallback without a canvas', () => {
  const root = svgDocument().createElementNS(SVG_NS, 'svg');
  root.innerHTML = createGateLabelRenderer(null)(64, '#171513');
  const text = root.querySelector('text')!;
  assert.equal(text.getAttribute('text-anchor'), 'middle');
  assert.equal(text.getAttribute('x'), '0');
  assert.ok(Number.isFinite(Number(text.getAttribute('y'))));
  assert.equal(text.textContent, '64');
});
