import test from 'node:test';
import assert from 'node:assert/strict';
import {attachAccountView} from '../src/views/account.ts';
import {createAccountFlow} from '../src/state/account-flow.ts';
import {dateDom} from './helpers/date-dom.ts';

function fixture(step: 'email'|'code' = 'email') {
  const document=dateDom(), create=document.createElement.bind(document);
  let field=create('input'), changes=0;
  document.createElement=(tag:string) => {
    const node=create(tag);
    Object.assign(node,{removeAttribute(){},querySelector(selector:string) {
      if (selector === '#accountEmail, #accountCode' || selector === '#accountEmail') return field;
      return null;
    }});
    if (tag === 'div') {
      const action=create('div'), feedback=create('div');
      Object.assign(action,{removeAttribute(){}});Object.assign(feedback,{removeAttribute(){}});
      let html='';
      Object.defineProperty(node,'innerHTML',{get:()=>html,set(value:string) {
        html=value;field=create('input');Object.assign(field,{removeAttribute(){}});
        field.id=value.includes('id="accountEmail"')?'accountEmail':'accountCode';
        field.value=/name="(?:email|code)"[^>]*value="([^"]*)"/.exec(value)?.[1] ?? '';
        field.disabled=/<input[^>]* disabled/.test(value);node.replaceChildren(field);
      }});
      Object.assign(node,{querySelector(selector:string) {
        if(selector==='#accountActionFeedback')return action;
        if(selector==='#accountFieldFeedback')return feedback;
        if(selector==='#accountEmail, #accountCode')return field;
        if(selector==='#accountEmail')return field.id==='accountEmail'?field:null;
        return null;
      }});
    }
    return node;
  };
  const page=create('section');
  const flow=createAccountFlow({connection:()=> 'online',saved:{email:'draft@',attemptEmail:'',attemptId:null,step,verificationPending:false},request:async()=>({})});
  const view=attachAccountView({page:page as unknown as HTMLElement,flow,offline:()=>false,onInputChange:()=>changes++});
  return {document,page,flow,view,get field(){return field;},get changes(){return changes;},close(){view.destroy();flow.destroy();}};
}

test('email typing resumes at its backward selection and caret-only edits notify the existing snapshot owner',()=>{
  const h=fixture(), focus={start:1,end:4,direction:'backward'};
  assert.equal(h.view.restoreInputFocus(focus),true);
  assert.deepEqual(h.view.inputFocus,focus);assert.equal(h.field.value,'draft@');
  const before=h.changes;h.field.setSelectionRange(2,2);h.document.dispatch('selectionchange');
  assert.ok(h.changes>before);assert.equal(h.view.inputFocus?.start,2);
  h.page.hidden=true;assert.equal(h.view.inputFocus,null);assert.equal(h.view.restoreInputFocus(focus),false);
  h.close();assert.equal(h.document.listenerCount('selectionchange'),0);
});

test('the secret code is excluded from input restoration and closing login clears the remembered field',()=>{
  const h=fixture('code');h.field.focus();h.field.value='123456';h.flow.input('code','123456');
  assert.equal(h.view.inputFocus,null);assert.equal(h.view.restoreInputFocus({start:1,end:4,direction:'none'}),false);
  assert.equal(JSON.stringify(h.flow.snapshot).includes('123456'),false);
  h.flow.close();assert.equal(h.flow.snapshot,null);assert.equal(h.view.inputFocus,null);h.close();
});
