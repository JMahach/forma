import test from 'node:test';
import assert from 'node:assert/strict';
import { activationHoverBounds, activationSpringProgress, attachActivationHover } from '../src/scene/activation-hover.ts';
import { ACTIVATION_HIGHLIGHT_OPACITY, PALETTE } from '../src/ui/chart-palette.ts';
import { svgDocument, SVG_NS } from './helpers/svg-dom.ts';

const identity = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };

test('activation rectangles cancel camera and column transforms without changing target dimensions', () => {
  const block = { a: 3, b: 0, c: 0, d: 3, e: -400, f: 700 };
  const target = { ...block, e: block.e + 3 * 28, f: block.f + 3 * 150 };
  assert.deepEqual(activationHoverBounds({ x: -4, y: -20, width: 68, height: 40 }, target, block),
    { x: 24, y: 130, width: 68, height: 40 });
  assert.equal(activationHoverBounds({ x: 0, y: 0, width: 68, height: 40 }, target, { ...block, a: 0 }), null);
  assert.equal(activationHoverBounds({ x: 0, y: 0, width: NaN, height: 40 }, target, block), null);
});

function fixture() {
  const document = svgDocument(), root = document.createElementNS(SVG_NS, 'svg');
  const listeners = new Map<string, Set<EventListener>>();
  const events = (surface: string) => ({
    addEventListener(type: string, handler: EventListener) {
      const key = `${surface}:${type}`; if (!listeners.has(key)) listeners.set(key, new Set());
      listeners.get(key)!.add(handler);
    },
    removeEventListener(type: string, handler: EventListener) { listeners.get(`${surface}:${type}`)?.delete(handler); },
  });
  const media = { matches: false, ...events('media') };
  const animations: { frames: Keyframe[]; options: KeyframeAnimationOptions; animation: Animation; cancelled: boolean }[] = [];
  let visibleStyle: Partial<CSSStyleDeclaration> | null = null;
  Object.assign(root, events('svg'));
  Object.assign(document, { ...events('document'), hidden: false, defaultView: {
    ...events('window'), matchMedia: () => media,
    getComputedStyle: (node: SVGElement) => ({ transform: node.style.transform, width: node.getAttribute('width'),
      height: node.getAttribute('height'), opacity: node.getAttribute('opacity'), ...visibleStyle }),
  } });
  const create = document.createElementNS.bind(document);
  document.createElementNS = (namespace, tag) => {
    const node = create(namespace, tag);
    Object.assign(node, { style: { transform: '', transformOrigin: '' },
      closest(selector: string) {
        let current: typeof node | null = node;
        while (current) { if (current.matches(selector)) return current; current = current.parentElement as typeof node | null; }
        return null;
      },
    });
    node.animate = (frames, options) => {
      const item = { frames: frames as Keyframe[], options: options as KeyframeAnimationOptions,
        animation: null as unknown as Animation, cancelled: false };
      item.animation = { cancel() { item.cancelled = true; }, onfinish: null } as unknown as Animation;
      animations.push(item); return item.animation;
    };
    return node;
  };
  function column(x: number) {
    const block = document.createElementNS(SVG_NS, 'g'); block.setAttribute('class', 'activation-block-content');
    block.getCTM = () => ({ ...identity, e: x }) as DOMMatrix;
    const panel = document.createElementNS(SVG_NS, 'rect'); panel.setAttribute('class', 'activation-panel');
    block.appendChild(panel); root.appendChild(block);
    const targets = [0, 1, 2].map(index => {
      const row = document.createElementNS(SVG_NS, 'g'); row.setAttribute('class', 'activation-row'); block.appendChild(row);
      const target = document.createElementNS(SVG_NS, 'g'); target.setAttribute('class', 'bg-activation'); row.appendChild(target);
      target.setAttribute('aria-pressed', index === 2 ? 'true' : 'false');
      const rect = document.createElementNS(SVG_NS, 'rect');
      for (const [name, value] of Object.entries({ x: '0', y: '-24', width: index === 0 ? '32' : '68', height: '48', rx: '10' })) rect.setAttribute(name, value);
      rect.getCTM = () => ({ ...identity, e: x + (index ? 32 : 0), f: 120 + index * 48 }) as DOMMatrix;
      target.appendChild(rect);
      const text = document.createElementNS(SVG_NS, 'text'); text.textContent = '34.4'; target.appendChild(text);
      return target;
    });
    return { block, panel, targets };
  }
  const left = column(-32), right = column(584);
  const send = (surface: string, type: string, values: Record<string, unknown> = {}) => {
    const event = { target: root, pointerType: 'mouse', buttons: 0, ...values } as unknown as Event;
    for (const handler of [...listeners.get(`${surface}:${type}`) || []]) handler(event);
  };
  const controller = attachActivationHover(root as unknown as SVGSVGElement);
  const move = (target: typeof left.targets[number], values: Record<string, unknown> = {}) => send('svg', 'pointermove', { target, ...values });
  return { root, document, media, animations, listeners, controller, left, right, send, move,
    visible(value: Partial<CSSStyleDeclaration> | null) { visibleStyle = value; },
    highlight: () => root.querySelector('.activation-fluid-highlight')!,
  };
}

test('SmoothUI fast spring follows Motion critical damping and settles without overshoot', () => {
  assert.equal(activationSpringProgress(0), 0);
  assert.ok(Math.abs(activationSpringProgress(.25) - .6710675192857651) < 1e-12);
  assert.ok(Math.abs(activationSpringProgress(.5) - .9444771835619268) < 1e-12);
  const samples = Array.from({ length: 81 }, (_, i) => activationSpringProgress(i / 80));
  assert.ok(samples.every((value, i) => value >= 0 && value <= 1 && (!i || value >= samples[i - 1])));
  assert.equal(samples.at(-1), 1);
});

test('one rounded highlight fades in, springs between real boxes and retargets from its drawn state', () => {
  const h = fixture(); h.move(h.left.targets[0]);
  const highlight = h.highlight();
  assert.equal(highlight.getAttribute('fill'), PALETTE.halo);
  assert.equal(highlight.getAttribute('fill-opacity'), String(ACTIVATION_HIGHLIGHT_OPACITY));
  assert.equal(highlight.getAttribute('pointer-events'), 'none');
  assert.equal(highlight.getAttribute('rx'), '10'); assert.equal(highlight.getAttribute('ry'), '10');
  assert.equal(highlight.getAttribute('width'), '32'); assert.equal(highlight.getAttribute('height'), '48');
  assert.equal(highlight.style.transform, 'translate(0px, 96px)');
  assert.equal(h.left.block.children[0], h.left.panel); assert.equal(h.left.block.children[1], highlight);
  assert.deepEqual(h.animations[0].frames, [{ opacity: 0 }, { opacity: 1 }], 'first entry fades at its target with no travel');
  assert.equal(h.animations[0].options.duration, 80);
  h.move(h.left.targets[1]);
  assert.equal(h.highlight(), highlight);
  assert.equal(h.left.targets[0].getAttribute('data-fluid-active'), null);
  assert.equal(h.left.targets[1].getAttribute('data-fluid-active'), 'true');
  assert.equal(h.animations.length, 2);
  assert.equal(h.animations[1].options.duration, 80);
  assert.equal(h.animations[1].options.easing, 'linear', 'keyframes already contain the source spring curve');
  assert.equal(h.animations[1].frames.length, 21);
  assert.equal(highlight.getAttribute('rx'), '10', 'width changes never scale or stretch the corner radius');
  assert.equal(highlight.getAttribute('width'), '68');
  const halfway = h.animations[1].frames[10];
  assert.ok(Math.abs(Number.parseFloat(String(halfway.width)) - (32 + 36 * activationSpringProgress(.5))) < 1e-12);
  // A browser may serialize the authored translate differently; same-cell
  // pointer events must not cancel/restart the live spring or entry fade.
  highlight.style.transform = 'matrix(1, 0, 0, 1, 32, 144)';
  h.move(h.left.targets[1]); h.move(h.left.targets[1]);
  assert.equal(h.animations.length, 2); assert.equal(h.animations[1].cancelled, false);
  h.visible({ transform: 'matrix(1, 0, 0, 1, 16, 125)', width: '50px', height: '48px' });
  h.move(h.left.targets[2]);
  assert.equal(h.animations[1].cancelled, true);
  assert.deepEqual(h.animations[2].frames[0], { offset: 0, transform: 'translate(16px, 125px)', width: '50px', height: '48px' });
  assert.equal(h.left.targets[2].getAttribute('aria-pressed'), 'true', 'hover never changes selection');
  h.visible(null); h.move(h.right.targets[0]);
  assert.equal(h.animations[2].cancelled, true);
  assert.equal(h.animations.length, 4);
  assert.deepEqual(h.animations[3].frames, [{ opacity: 0 }, { opacity: 1 }], 'cross-column entry fades without crossing the drawing');
  assert.equal(highlight.parentElement, h.right.block);
  assert.equal(h.root.querySelectorAll('.activation-fluid-highlight').length, 1);
  h.controller.dispose();
});

test('the fluid highlight follows dimmed target opacity and re-enabling the same cell does not restart its motion', () => {
  const h = fixture(), planet = h.left.targets[0], value = h.left.targets[1];
  planet.setAttribute('opacity', '.35'); value.setAttribute('opacity', '.22');
  h.move(planet);
  assert.equal(Number(h.highlight().getAttribute('opacity')), .35);
  h.move(value);
  assert.equal(Number(h.highlight().getAttribute('opacity')), .22);
  assert.equal(h.highlight().getAttribute('fill'), PALETTE.halo, 'dimming preserves the chosen blue hue');
  assert.equal(h.animations.length, 2);
  value.setAttribute('opacity', '1'); h.move(value);
  assert.equal(h.highlight().getAttribute('opacity'), '1', 'same-target geometry deduplication cannot retain stale dimming');
  assert.equal(h.animations.length, 2);
  assert.equal(h.animations[1].cancelled, false, 'an opacity-only update leaves the current movement uninterrupted');
  value.setAttribute('opacity', '.22'); h.move(value);
  assert.equal(Number(h.highlight().getAttribute('opacity')), .22);
  value.removeAttribute('opacity'); h.move(value);
  assert.equal(h.highlight().getAttribute('opacity'), '1', 'targets without an opacity attribute are fully visible');
  h.controller.dispose();
});

test('pointer, keyboard and page interruptions clear decorative state; disposal releases listeners and node', () => {
  const h = fixture();
  for (const [surface, type, detail] of [
    ['svg', 'pointerleave', {}], ['svg', 'pointerdown', {}], ['svg', 'pointercancel', {}],
    ['svg', 'wheel', {}], ['svg', 'focusin', {}], ['svg', 'keydown', { key: 'Escape' }], ['window', 'blur', {}],
  ] as const) {
    h.move(h.left.targets[0]); h.send(surface, type, detail);
    assert.equal(h.left.targets[0].getAttribute('data-fluid-active'), null, type);
    assert.equal(h.highlight().getAttribute('opacity'), '0', type);
  }
  for (const detail of [{ pointerType: 'touch' }, { buttons: 1 }]) {
    h.move(h.left.targets[0]); h.move(h.left.targets[1], detail);
    assert.equal(h.highlight().getAttribute('opacity'), '0');
  }
  h.move(h.left.targets[0]); h.root.classList.add('is-dragging'); h.move(h.left.targets[1]);
  assert.equal(h.highlight().getAttribute('opacity'), '0'); h.root.classList.remove('is-dragging');
  h.move(h.left.targets[0]); Object.assign(h.document, { hidden: true }); h.send('document', 'visibilitychange');
  assert.equal(h.highlight().getAttribute('opacity'), '0');
  h.controller.dispose(); h.controller.dispose();
  assert.equal(h.root.querySelector('.activation-fluid-highlight'), null);
  assert.ok([...h.listeners.values()].every(handlers => handlers.size === 0));
});

test('exit uses the source 60ms fade and repeated clears do not restart it', () => {
  const h = fixture(); h.move(h.left.targets[0]);
  h.visible({ opacity: '0.4' }); h.send('svg', 'pointerleave');
  assert.equal(h.animations[0].cancelled, true);
  assert.deepEqual(h.animations[1].frames, [{ opacity: .4 }, { opacity: 0 }]);
  assert.equal(h.animations[1].options.duration, 60);
  h.controller.clear(); assert.equal(h.animations.length, 2);
  assert.equal(h.left.targets[0].getAttribute('data-fluid-active'), null);
  h.controller.dispose(); assert.ok(h.animations.every(item => item.cancelled));
});

test('committed exit and interaction interruption hide immediately without stacking two translucent fills', () => {
  const h = fixture();
  for (const [target, type] of [[h.left.targets[2], 'pointerleave'], [h.left.targets[0], 'pointerdown'],
    [h.left.targets[0], 'focusin'], [h.left.targets[0], 'clear']] as const) {
    h.move(target); const before = h.animations.length;
    if (type === 'clear') h.controller.clear(); else h.send('svg', type);
    assert.equal(h.highlight().getAttribute('opacity'), '0', type);
    assert.equal(target.getAttribute('data-fluid-active'), null, type);
    assert.equal(h.animations.length, before, 'no exit animation can overlap the restored selected fill');
    assert.equal(h.animations.at(-1)!.cancelled, true);
  }
  h.controller.dispose();
});

test('reduced-motion changes settle both movement and fades immediately', () => {
  const h = fixture(); h.move(h.left.targets[0]); h.move(h.left.targets[1]);
  assert.equal(h.animations.length, 2);
  h.media.matches = true; h.send('media', 'change');
  assert.ok(h.animations.every(item => item.cancelled));
  assert.equal(h.highlight().getAttribute('opacity'), '1');
  h.move(h.left.targets[2]); h.controller.clear(); h.move(h.right.targets[0]);
  assert.equal(h.animations.length, 2, 'position, entry and exit are immediate with reduced motion');
  assert.equal(h.highlight().getAttribute('opacity'), '1');
  h.media.matches = false; h.send('media', 'change'); h.move(h.right.targets[1]);
  assert.equal(h.animations.length, 3);
  h.controller.dispose(); assert.equal(h.animations[2].cancelled, true);
});


test('same-cell moves skip matrix reads while opacity and relative geometry stay current', () => {
  const h = fixture(), target = h.left.targets[1], rect = target.querySelector('rect')!;
  const targetMatrix = rect.getCTM.bind(rect), blockMatrix = h.left.block.getCTM.bind(h.left.block);
  let reads = 0;
  rect.getCTM = () => { reads++; return targetMatrix(); };
  h.left.block.getCTM = () => { reads++; return blockMatrix(); };
  h.move(target); reads = 0;
  for (let i = 0; i < 100; i++) h.move(target);
  assert.equal(reads, 0);
  target.setAttribute('opacity', '.22'); h.move(target);
  assert.equal(Number(h.highlight().getAttribute('opacity')), .22);
  assert.equal(reads, 0, 'opacity has no geometry dependency');
  rect.setAttribute('width', '76'); h.move(target);
  assert.equal(h.highlight().getAttribute('width'), '76');
  assert.equal(reads, 2, 'changed hit dimensions invalidate the current geometry');
  target.parentElement!.setAttribute('transform', 'translate(32 180)');
  rect.getCTM = () => { reads++; return { ...identity, e: 0, f: 180 } as DOMMatrix; };
  h.move(target);
  assert.equal(h.highlight().style.transform, 'translate(32px, 156px)');
  assert.equal(reads, 4, 'changed row position is measured');
  h.controller.clear(); h.move(target);
  assert.equal(reads, 6, 'camera/column owners clearing hover invalidate its geometry');
  h.controller.dispose();
});


test('camera and shared column transforms cannot stale local hover geometry', () => {
  const h = fixture(), target = h.left.targets[1], rect = target.querySelector('rect')!;
  h.move(target);
  let reads = 0;
  h.left.block.getCTM = () => { reads++; return { ...identity, a: 2, d: 2, e: 200, f: 300 } as DOMMatrix; };
  rect.getCTM = () => { reads++; return { ...identity, a: 2, d: 2, e: 264, f: 636 } as DOMMatrix; };
  h.left.block.setAttribute('transform', 'scale(2)');
  h.root.setAttribute('style', 'transform:matrix(2,0,0,2,200,300)');
  h.move(target);
  assert.equal(reads, 0, 'shared camera/column movement cancels before measuring');
  assert.equal(h.highlight().style.transform, 'translate(32px, 144px)');
  rect.setAttribute('width', '76'); h.move(target);
  assert.equal(reads, 2);
  assert.equal(h.highlight().style.transform, 'translate(32px, 144px)');
  assert.equal(h.highlight().getAttribute('width'), '76');
  h.controller.dispose();
});
