import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { GATES } from '../src/reference/catalog.ts';
const digest = (value: (string|number)[][]) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

test('startup gate references retain all names and topology without loading their articles', () => {
  assert.equal(GATES.length, 64);
  assert.equal(digest(GATES.map(({id,name}) => [id,name])), 'a0c0c31906e995722a0b04fa2391b350091a03d72d210161051f993543ac1100');
  assert.ok(GATES.every(gate => !Object.hasOwn(gate, 'summary')));
});
