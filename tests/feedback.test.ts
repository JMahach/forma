import test from 'node:test';
import assert from 'node:assert/strict';
import { createToast } from '../src/ui/toast.ts';
import { createFeedback } from '../src/ui/feedback.ts';
class Element {
  classList = { add() {}, remove() {} };
  id = ''; hidden = false; textContent = ''; className = ''; type = ''; disabled = false;
  dataset: Record<string,string> = {}; children: Element[] = [];
  attributes = new Map<string,string>(); handlers = new Map<string,()=>void>();
  ownerDocument = { createElement: () => new Element() };
  setAttribute(key:string,value:string) { this.attributes.set(key,value); }
  getAttribute(key:string) { return this.attributes.get(key) ?? null; }
  removeAttribute(key:string) { this.attributes.delete(key); }
  append(...nodes:Element[]) { this.children.push(...nodes); }
  replaceChildren(...nodes:Element[]) { this.children = nodes; this.textContent = ''; }
  addEventListener(type:string,handler:()=>void) { this.handlers.set(type,handler); }
  click() { this.handlers.get('click')?.(); }
}
const html = (element:Element) => element as unknown as HTMLElement;
test('field feedback preserves the existing hint, replaces errors, and clears its own invalid state', () => {
  const container=new Element(),field=new Element(); field.setAttribute('aria-describedby','email-hint');
  const feedback=createFeedback(html(container),{kind:'field',field:html(field)});
  feedback.show({message:'Проверьте адрес почты',tone:'error'});
  assert.equal(field.getAttribute('aria-invalid'),'true');
  assert.equal(field.getAttribute('aria-describedby'),`email-hint ${container.id}`);
  feedback.show({message:'Введите адрес почты',tone:'error'});
  assert.equal(container.children.length,1); assert.equal(container.children[0].textContent,'Введите адрес почты');
  feedback.clear(); assert.equal(container.hidden,true); assert.equal(field.getAttribute('aria-describedby'),'email-hint');
  assert.equal(field.getAttribute('aria-invalid'),null);
});
test('replacement and disposal invalidate the old action and do not create duplicate buttons', () => {
  const container=new Element(); let retries=0;
  const feedback=createFeedback(html(container),{kind:'action'});
  const data={message:'Нет соединения',actions:[{label:'Повторить',run:()=>retries++}]};
  feedback.show(data); const old=container.children[1].children[0];
  feedback.show(data); old.click(); assert.equal(retries,0);
  const current=container.children[1].children[0]; current.click(); assert.equal(retries,1);
  feedback.destroy(); current.click(); feedback.show(data); assert.equal(retries,1); assert.equal(container.hidden,true);
});
test('a waiting message exposes busy state then clears it with the result', () => {
  const container=new Element(),feedback=createFeedback(html(container),{kind:'tool'});
  feedback.show({message:'Готовим карту…',busy:true}); assert.equal(container.getAttribute('aria-busy'),'true');
  feedback.show({message:'Нет соединения',tone:'error'}); assert.equal(container.getAttribute('aria-busy'),'false');
  assert.equal(container.dataset.tone,'error'); assert.equal(container.getAttribute('aria-live'),'polite');
});

test('an unresolved application error remains until explicitly dismissed', t => {
 t.mock.timers.enable({apis:['setTimeout']});
 const container=new Element(), toast=createToast(html(container)); toast('Не удалось сохранить вид карты');
 t.mock.timers.tick(10000);
 assert.equal(container.hidden,false); assert.equal(container.children[0]?.textContent,'Не удалось сохранить вид карты');
 container.children[1].children[0].click(); assert.equal(container.hidden,true);
});
