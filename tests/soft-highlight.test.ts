import test from 'node:test';
import assert from 'node:assert/strict';
import { svgDocument, SVG_NS } from './helpers/svg-dom.ts';
import { softHighlightOpacity } from '../src/scene/soft-highlight.ts';

test('interrupting a halo fade starts from its current visible opacity and releases the finished animation', () => {
  const document = svgDocument();
  const node = document.createElementNS(SVG_NS, 'path');
  node.setAttribute('opacity', '0');
  let visible = '0', cancelled = 0;
  const calls: { frames: Keyframe[]; options: KeyframeAnimationOptions; animation: Animation }[] = [];
  Object.assign(document, { defaultView: { matchMedia: () => ({ matches: false }), getComputedStyle: () => ({ opacity: visible }) } });
  node.animate = (frames, options) => {
    const animation = { cancel() { cancelled++; }, onfinish: null } as unknown as Animation;
    calls.push({ frames: frames as Keyframe[], options: options as KeyframeAnimationOptions, animation });
    return animation;
  };
  softHighlightOpacity(node, 1);
  assert.equal(node.getAttribute('opacity'), '1', 'semantic paint updates immediately');
  assert.equal(calls.length, 1, 'a visible transition starts');
  assert.deepEqual(calls[0].frames, [{ opacity: '0' }, { opacity: '1' }]);
  assert.equal(calls[0].options.duration, 92);
  assert.equal(calls[0].options.delay ?? 0, 0, 'the longer fade adds no interaction delay');
  visible = '0.4';
  softHighlightOpacity(node, 0);
  assert.equal(cancelled, 1);
  assert.deepEqual(calls[1].frames, [{ opacity: '0.4' }, { opacity: '0' }]);
  assert.equal(calls[1].options.duration, 69);
  calls[1].animation.onfinish!({} as AnimationPlaybackEvent);
  assert.equal(cancelled, 2);
});

test('reduced motion updates a halo immediately without starting animation', () => {
  const document = svgDocument(), node = document.createElementNS(SVG_NS, 'path');
  node.setAttribute('opacity', '0');
  Object.assign(document, { defaultView: { matchMedia: () => ({ matches: true }) } });
  node.animate = () => { throw new Error('reduced motion cannot animate'); };
  softHighlightOpacity(node, 1);
  assert.equal(node.getAttribute('opacity'), '1');
});


test('an exiting ordinary half is reclaimed on rapid re-entry and removed only after its final exit', async () => {
  const { softHighlightFragment } = await import('../src/scene/soft-highlight.ts');
  const document = svgDocument(), parent = document.createElementNS(SVG_NS, 'g'), before = document.createElementNS(SVG_NS, 'path');
  parent.appendChild(before);
  const animations: Animation[] = [];
  const durations: number[] = [];
  Object.assign(document, { defaultView: { matchMedia: () => ({ matches: false }), getComputedStyle: () => ({ opacity: '0.4' }) } });
  const create = document.createElementNS.bind(document);
  document.createElementNS = (ns, tag) => { const node = create(ns, tag); node.animate = (_frames, options) => { durations.push((options as KeyframeAnimationOptions).duration as number); const animation = { cancel() {}, onfinish: null } as unknown as Animation; animations.push(animation); return animation; }; return node; };
  parent.animate = () => ({} as Animation);
  const patch = softHighlightFragment(parent, before, [], '');
  const markup = '<g data-highlight-gate="1"><path d="M0 0L1 1"/></g>';
  patch(markup);
  const half = parent.querySelector('[data-highlight-gate="1"]');
  patch('');
  assert.equal(parent.querySelector('[data-highlight-gate="1"]'), half, 'exiting half remains painted');
  const exit = animations.at(-1)!;
  patch(markup);
  assert.equal(parent.querySelector('[data-highlight-gate="1"]'), half, 're-entry reclaims the existing contour');
  exit.onfinish?.({} as AnimationPlaybackEvent);
  assert.equal(parent.querySelector('[data-highlight-gate="1"]'), half, 'old finish cannot remove reclaimed paint');
  patch('');
  animations.at(-1)!.onfinish?.({} as AnimationPlaybackEvent);
  assert.equal(parent.querySelector('[data-highlight-gate="1"]'), null);
  assert.deepEqual(durations, [92, 69, 92, 69], 'half enter, exit and interrupted re-entry use the same 15% longer timing');
});

test('switching motion preference settles active half paint and preserves one owner through both modes', async () => {
  const { softHighlightFragment } = await import('../src/scene/soft-highlight.ts');
  const document = svgDocument(), parent = document.createElementNS(SVG_NS, 'g'), before = document.createElementNS(SVG_NS, 'path');
  parent.appendChild(before);
  let reduced = false, active = 0;
  Object.assign(document, { defaultView: { matchMedia: () => ({ matches: reduced }), getComputedStyle: () => ({ opacity: '0.4' }) } });
  const create = document.createElementNS.bind(document);
  document.createElementNS = (ns, tag) => { const node = create(ns, tag); node.animate = () => { active++; let cancelled = false; return { cancel() { if (!cancelled) { active--; cancelled = true; } }, onfinish: null } as unknown as Animation; }; return node; };
  parent.animate = () => ({} as Animation);
  const patch = softHighlightFragment(parent, before, [], '');
  const markup = '<g data-highlight-gate="1"><path d="M0 0L1 1"/></g>';
  patch(markup);
  reduced = true;
  patch(markup);
  assert.equal(active, 0, 'reduced motion cancels the entering effect immediately');
  assert.equal(parent.querySelectorAll('[data-highlight-gate="1"]').length, 1);
  patch('');
  assert.equal(parent.querySelectorAll('[data-highlight-gate="1"]').length, 0);
  reduced = false;
  patch(markup);
  assert.equal(parent.querySelectorAll('[data-highlight-gate="1"]').length, 1);
  assert.equal(active, 1, 'returning to motion creates one current effect');
});

test('a live reduced-motion change settles contour effects immediately and its listener is disposed', async () => {
  const { observeSoftHighlightMotion } = await import('../src/scene/soft-highlight.ts');
  const document = svgDocument(), root = document.createElementNS(SVG_NS, 'svg');
  const contours = ['bg-center-highlight', 'bg-gate-highlight', 'bg-gate-glow'].map(className => {
    const node = document.createElementNS(SVG_NS, className.startsWith('bg-gate') ? 'circle' : 'path');
    node.setAttribute('class', className); root.appendChild(node); return node;
  });
  const outgoing = document.createElementNS(SVG_NS, 'path'); outgoing.setAttribute('data-soft-highlight-outgoing', 'paint'); root.appendChild(outgoing);
  let listener: (() => void) | undefined;
  const active = new Set(contours);
  const media = { matches: false, addEventListener(_type:string, handler:()=>void) { listener = handler; }, removeEventListener(_type:string, handler:()=>void) { assert.equal(handler, listener); listener = undefined; } };
  Object.assign(document, { defaultView: { matchMedia: () => media } });
  root.getAnimations = () => contours.map(node => ({ effect: { target: node }, cancel() { active.delete(node); } })) as unknown as Animation[];
  const dispose = observeSoftHighlightMotion(root);
  media.matches = true; listener?.();
  assert.equal(active.size, 0, 'media event settles gate bloom and crisp core together without another render');
  assert.equal(root.querySelector('[data-soft-highlight-outgoing]'), null);
  dispose();
  assert.equal(listener, undefined);
});
