import test from 'node:test';
import assert from 'node:assert/strict';
import { actionAvailability } from '../src/ui/action-state.ts';
test('offline disables only a new network action; ready and local actions remain usable', () => {
  assert.deepEqual(actionAvailability({connection:'offline',requiresConnection:true}), {disabled:true,busy:false,reason:'Нет соединения'});
  assert.equal(actionAvailability({connection:'offline',requiresConnection:true,hasReadyData:true}).disabled,false);
  assert.equal(actionAvailability({connection:'offline',requiresConnection:false}).disabled,false);
});
test('server silence allows an attempt but pending work cannot be submitted twice', () => {
  assert.equal(actionAvailability({connection:'server',requiresConnection:true}).disabled,false);
  assert.deepEqual(actionAvailability({connection:'server',requiresConnection:true,pending:true}),{disabled:true,busy:true,reason:''});
});
test('healthy connection never grants missing permissions or replaces the owner availability', () => {
  assert.equal(actionAvailability({connection:'online',requiresConnection:true,available:false}).disabled,true);
});
