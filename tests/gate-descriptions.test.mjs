import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { GATES } from '../src/reference/catalog.js';
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

test('startup gate references retain all names and topology without loading their articles', () => {
  assert.equal(GATES.length, 64);
  assert.equal(digest(GATES.map(({id,name}) => [id,name])), 'a0c0c31906e995722a0b04fa2391b350091a03d72d210161051f993543ac1100');
  assert.ok(GATES.every(gate => !Object.hasOwn(gate, 'summary')));
});

test('all 64 lazy descriptions preserve every original reference character', async () => {
  const { GATE_DESCRIPTIONS } = await import('../src/reference/gate-descriptions.js');
  assert.equal(Object.keys(GATE_DESCRIPTIONS).length, 64);
  assert.equal(digest(GATES.map(({id}) => [id,GATE_DESCRIPTIONS[id]])), '6bb8e25cffd12382b116ba8af0499a9cb339e81697a612753539186236d250e3');
  assert.equal(Object.isFrozen(GATE_DESCRIPTIONS), true);
});
