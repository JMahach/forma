import test from 'node:test';
import assert from 'node:assert/strict';
import { attachChartLink } from '../src/views/chart-link.ts';
import { createActionNotice } from '../src/ui/feedback.ts';
import { dateDom, type DateNode } from './helpers/date-dom.ts';
const html = (node: DateNode) => node as unknown as HTMLElement;
const first = 'https://forma.example.test/chart/1234567890';
function harness(writeText?: (text: string) => Promise<void>) {
  const document = dateDom(), create = document.createElement;
  document.createElement = tag => {
    const node = create(tag) as DateNode & HTMLElement;
    node.querySelectorAll = () => node.all(child => child.tagName === 'button') as never;
    node.removeAttribute = name => node.setAttribute(name, '');
    node.getBoundingClientRect = () => ({left: 0, top: 0, right: 248, bottom: 88, width: 248, height: 88}) as DOMRect;
    return node as never;
  };
  const root = document.body, button = document.createElement('button'), other = document.createElement('button');
  button.getBoundingClientRect = () => ({left: 150, right: 182, top: 180, bottom: 212, width: 32, height: 32});
  root.append(button, other);
  const notice = createActionNotice(html(root));
  const link = attachChartLink({button: button as unknown as HTMLButtonElement, root: html(root), boundary: html(root), notice,
    ...(writeText ? {writeText} : {})});
  const panel = () => root.children.find(child => child.className.includes('action-notice'))!;
  return {document, root, button, other, notice, link, panel, message: () => panel().children[0]?.textContent,
    click: () => button.dispatch('click') as Promise<void>};
}
function deferred() {
  let resolve!: () => void, reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => {resolve = yes; reject = no;});
  return {promise, resolve, reject};
}
test('successful clipboard acknowledgement produces the accepted compact toast above for exactly two seconds', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  const task = deferred(), writes: string[] = [];
  const h = harness(text => {writes.push(text); return task.promise;});
  assert.equal(h.button.hidden, true); await h.click(); assert.deepEqual(writes, []);
  h.link.update(first); const clicked = h.click();
  assert.deepEqual(writes, [first]); assert.equal(h.panel().hidden, true, 'no success before clipboard acknowledgement');
  task.resolve(); await clicked;
  assert.equal(h.message(), 'Ссылка скопирована'); assert.equal(h.panel().dataset.tone, 'success');
  assert.equal(h.panel().dataset.compact, 'true'); assert.equal(h.panel().dataset.side, 'top');
  assert.equal(h.panel().all(node => node.tagName === 'button').length, 0);
  t.mock.timers.tick(1999); assert.equal(h.panel().hidden, false);
  t.mock.timers.tick(1); assert.equal(h.panel().hidden, true);
});
for (const kind of ['rejected', 'throws', 'unavailable'] as const) test(`clipboard ${kind} uses the same short failure notice without buttons`, async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  const h = harness(kind === 'unavailable' ? undefined : () => {
    if (kind === 'throws') throw Error('denied');
    return Promise.reject(Error('denied'));
  });
  h.link.update(first); await h.click();
  assert.equal(h.message(), 'Не удалось скопировать ссылку');
  assert.equal(h.panel().dataset.tone, 'error'); assert.equal(h.panel().dataset.compact, 'true');
  assert.equal(h.panel().dataset.side, 'top'); assert.equal(h.panel().all(node => node.tagName === 'button').length, 0);
  t.mock.timers.tick(2000); assert.equal(h.panel().hidden, true);
});
for (const boundary of ['another-card', 'away-and-back', 'message', 'pointer-action', 'keyboard-action', 'escape'] as const)
  test(`late clipboard success cannot cross ${boundary}`, async () => {
    const task = deferred(), h = harness(() => task.promise);
    h.link.update(first); const clicked = h.click();
    if (boundary === 'another-card') h.link.update('https://forma.example.test/chart/9876543210');
    if (boundary === 'away-and-back') {h.link.update(null); h.link.update(first);}
    if (boundary === 'message') h.notice.show(html(h.other), {message: 'Новое сообщение'});
    if (boundary === 'pointer-action') h.root.dispatch('pointerdown', {target: h.other});
    if (boundary === 'keyboard-action') h.root.dispatch('keydown', {target: h.other, key: 'Enter'});
    if (boundary === 'escape') h.root.dispatch('keydown', {target: h.button, key: 'Escape'});
    task.resolve(); await clicked;
    if (boundary === 'message') assert.equal(h.message(), 'Новое сообщение');
    else assert.equal(h.panel().hidden, true);
  });
test('a repeated copy owns its own result and an older rejection cannot replace it', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  const old = deferred(); let calls = 0;
  const h = harness(() => ++calls === 1 ? old.promise : Promise.resolve()); h.link.update(first);
  const previous = h.click(); await h.click();
  assert.equal(h.message(), 'Ссылка скопирована');
  old.reject(Error('late denial')); await previous;
  assert.equal(h.message(), 'Ссылка скопирована');
});
