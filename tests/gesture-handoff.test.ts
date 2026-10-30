import test from 'node:test';
import assert from 'node:assert/strict';
import { attachGestures } from '../src/scene/gestures.ts';
import { createCamera, type CameraPosition } from '../src/scene/camera.ts';

function harness({ drawing = null, ...options } = {}) {
  const listeners = new Map(), captures = new Set(), queued = new Map(), paints: CameraPosition[] = [], changes: CameraPosition[] = [], selections = [];
  let nextPaint = 0;
  const surface = {
    closest: () => null,
    addEventListener(type, handler) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(handler);
    },
    setPointerCapture: (id: unknown) => captures.add(id), hasPointerCapture: (id: unknown) => captures.has(id),
    releasePointerCapture: (id: unknown) => captures.delete(id),
    classList: { toggle() {} },
  };
  const measureFit = () => ({ area: { x: 0, y: 0, width: 640, height: 820 }, min: .1 });
  const camera = createCamera({ measureFit, onChange() {} });
  camera.reset(); camera.zoomAt({ x: 320, y: 410 }, 1.5);
  const controls = attachGestures(drawing || surface, {
    camera, cameraView: { surface, point: event => ({ x: event.clientX, y: event.clientY }), measureFit, paint: view => paints.push(view) },
    onChange: view => changes.push(view), onSelect: selection => selections.push(selection),
    requestPaint: callback => { queued.set(++nextPaint, callback); return nextPaint; }, cancelPaint: id => queued.delete(id),
    ...options,
  });
  return {
    camera, controls, surface, listeners, captures, queued, paints, changes, selections,
    send(type: string, extra = {}) {
      for (const handler of listeners.get(type) || []) handler({ type, pointerId: 1, pointerType: 'touch', button: 0,
        target: surface, clientX: 320, clientY: 410, preventDefault() {}, ...extra });
    },
    tick() { const pending = [...queued.values()]; queued.clear(); for (const callback of pending) callback(); },
  };
}

const gate = (id: string) => ({ dataset: { type: 'gate' as const, id }, closest() { return this; } });

test('gesture handoff retains the live camera and applies each wheel event once', () => {
  const h = harness(), nextChanges: unknown[] = [], before = h.camera.getView(), home = h.camera.getFittedView();
  const maximum = h.camera.maximumScale(), previousChanges = h.changes.length;
  h.controls.setHandlers({ onChange: view => nextChanges.push(view) });
  assert.deepEqual(h.controls.getView(), before);
  assert.deepEqual(h.controls.getFittedView(), home);
  assert.equal(h.controls.maximumScale(), maximum);
  assert.deepEqual(nextChanges, [before], 'the incoming view receives the unchanged pose');
  assert.equal('setHandlers' in h.camera, false, 'the camera retains only camera responsibilities');
  h.send('wheel', { deltaY: -20 }); h.tick();
  assert.ok(Math.abs(h.camera.getView().k - before.k * Math.exp(.06)) < 1e-9);
  assert.equal(nextChanges.length, 2);
  assert.equal(h.changes.length, previousChanges);
  assert.equal(h.listeners.get('wheel').length, 1);
  h.controls.reset();
  assert.deepEqual(h.camera.getView(), home, 'the facade still controls the original camera');
});

test('handoff cancels a press from the outgoing screen and uses the new selection handlers', () => {
  const h = harness(), oldGate = gate('41'), newGate = gate('29'), selected: unknown[] = [];
  let background = 0;
  h.send('pointerdown', { target: oldGate });
  assert.equal(h.captures.size, 1);
  h.controls.setHandlers({
    onSelect: value => selected.push(value), onBackgroundTap: () => background++,
    resolvePointerTarget: event => event.newTarget || null,
    resolveSelection: target => ({ type: 'new-gate' as const, id: target.dataset.id }),
  });
  assert.equal(h.captures.size, 0);
  h.send('pointerup', { target: oldGate });
  assert.deepEqual(h.selections, []); assert.deepEqual(selected, []); assert.equal(background, 0);
  h.send('pointerdown', { target: oldGate, newTarget: newGate });
  h.send('pointerup');
  assert.deepEqual(selected, [{ type: 'new-gate' as const, id: '29', pointerType: 'touch' }]);
  h.send('pointerdown', { target: oldGate }); h.send('pointerup');
  assert.equal(background, 1);
  h.controls.setHandlers({ resolveSelection: () => ({ type: 'keyboard-gate' as const, id: '63' }) });
  h.send('keydown', { target: newGate, key: 'Enter' });
  assert.deepEqual(selected.at(-1), { type: 'keyboard-gate' as const, id: '63' });
});

test('handoff flushes the final outgoing gesture and discards stale paints and Safari updates', () => {
  const h = harness(), incoming: unknown[] = [];
  h.send('gesturestart', { scale: 1 }); h.send('gesturechange', { scale: 1.2 });
  const before = h.camera.getView(), stalePaint = [...h.queued.values()][0];
  h.controls.setHandlers({ onChange: view => incoming.push(view) });
  assert.equal(h.queued.size, 0);
  assert.deepEqual(h.changes.at(-1), before, 'the outgoing owner can persist its last gesture');
  assert.deepEqual(incoming, [before]);
  h.send('gesturechange', { scale: 2 });
  assert.deepEqual(h.camera.getView(), before, 'an old Safari lifecycle cannot change the new screen');
  h.send('wheel', { deltaY: -20 });
  const paints = h.paints.length;
  stalePaint();
  assert.equal(h.paints.length, paints);
  assert.equal(h.queued.size, 1);
  h.tick();
  assert.deepEqual(incoming.at(-1), h.camera.getView());
});

test('loading can attach camera gestures before selection and change handlers exist', () => {
  const h = harness({ onSelect: undefined, onChange: undefined });
  h.send('wheel', { deltaY: -20 }); h.tick();
  h.send('pointerdown', { target: gate('41') }); h.send('pointerup');
  const selected: { id: unknown; }[] = [];
  h.controls.setHandlers({ onSelect: value => selected.push(value) });
  h.send('pointerdown', { target: gate('29') }); h.send('pointerup');
  assert.equal(selected[0].id, '29');
});


test('loading and ready surfaces ignore removed zoom keys and keep Home and focus', () => {
  const keyboard = new Map(); let drawingFocus = 0, surfaceFocus = 0;
  const drawing = { inert: true, closest: () => null, classList: { toggle() {} },
    addEventListener: (type, handler) => keyboard.set(type, handler), focus: () => drawingFocus++ };
  const h = harness({ drawing }); h.surface.focus = () => surfaceFocus++;
  const before = h.controls.getView();
  h.send('keydown', { key: '+' });
  assert.deepEqual(h.controls.getView(), before);
  h.send('keydown', { key: '-' });
  assert.ok(Math.abs(h.controls.getView().k - before.k) < 1e-9);
  h.send('pointerdown'); h.send('pointerup');
  assert.equal(surfaceFocus, 1); assert.equal(drawingFocus, 0);
  drawing.inert = false;
  h.send('pointerdown'); h.send('pointerup');
  assert.equal(surfaceFocus, 1); assert.equal(drawingFocus, 1);
  const event = { type: 'keydown' as const, target: drawing, key: '+', preventDefault() {} };
  keyboard.get('keydown')(event);
  h.send('keydown', event); // The SVG event bubbles through the stationary surface.
  assert.deepEqual(h.controls.getView(), before, 'neither the drawing nor its outer surface handles removed zoom keys');
  h.controls.zoomAt({ x: 320, y: 410 }, 1.25);
  h.send('keydown', { key: '0' });
  assert.deepEqual(h.controls.getView(), h.controls.getFittedView());
});

// The lifecycle fixture counts real AbortSignal-driven event registrations;
// numeric movement still uses the production camera and its current owner.
import {dateDom} from './helpers/date-dom.ts';
import {attachCameraControls} from '../src/views/camera-controls.ts';
import {attachMandalaMode} from '../src/scene/modes/mandala.ts';

test('thirty gesture lifetimes release capture and paint without moving the shared camera or stopping a live owner',async()=>{
 const doc=dateDom(),surface=doc.createElement('div'),svg=doc.createElement('svg'),home=doc.createElement('button'),modeButton=doc.createElement('button');
 const captures=new Set<number>(),queued=new Map<number,FrameRequestCallback>(),classes=new Set<string>();let nextPaint=0,paints=0,changes=0,selection=0,background=0,renders=0,motions=0,measurements=0;
 Object.assign(surface,{closest:()=>null,setPointerCapture:(id:number)=>captures.add(id),hasPointerCapture:(id:number)=>captures.has(id),releasePointerCapture(id:number){captures.delete(id);surface.dispatch('lostpointercapture',{pointerId:id});}});
 Object.assign(svg,{closest:()=>null,classList:{toggle(name:string,value:boolean){if(value)classes.add(name);else classes.delete(name);return value;}}});
 const measureFit=()=>{measurements++;return {area:{x:0,y:0,width:640,height:820},viewport:{x:0,y:0,width:640,height:820},min:.1,screenScale:1,zoomLimitScale:1};};
 const camera=createCamera({measureFit,onChange(){}});camera.reset();camera.zoomAt({x:320,y:410},1.5);
 const cameraView={surface:surface as unknown as HTMLElement,point:(event:Pick<MouseEvent,'clientX'|'clientY'>)=>({x:event.clientX,y:event.clientY}),measureFit,paint(){paints++;}};
 const send=(type:string,extra={})=>surface.dispatch(type,{type,pointerId:1,pointerType:'mouse',button:0,target:surface,clientX:320,clientY:410,preventDefault(){},...extra});
 let neighborEvents=0;surface.addEventListener('wheel',()=>neighborEvents++);
 const options={camera,cameraView,onChange:()=>changes++,onSelect:()=>selection++,onBackgroundTap:()=>background++,requestPaint(callback:FrameRequestCallback){const id=++nextPaint;queued.set(id,callback);return id;},cancelPaint:(id:number)=>{queued.delete(id);}};
 const stopped:ReturnType<typeof attachGestures>[]=[];
 for(let i=0;i<30;i++){
  camera.reset();camera.zoomAt({x:320,y:410},1.5);
  const controls=attachGestures(svg as unknown as SVGSVGElement,options);
  const binding=attachCameraControls({fitButton:home as unknown as HTMLButtonElement},controls);
  const mode=attachMandalaMode({button:modeButton as unknown as HTMLElement,canvas:svg as unknown as Element,gestures:controls,render:()=>renders++,motion:{setExpanded(){motions++;}} as never});
  assert.equal(surface.listenerCount()+svg.listenerCount()+home.listenerCount()+modeButton.listenerCount(),14);
  send('pointerdown');send('pointermove',{clientX:350});assert.equal(captures.size,1);assert.equal(queued.size,1);
  mode.setEnabled(true);mode.setEnabled(false);
  send('pointermove',{clientX:365});const late=[...queued.values()];assert.equal(late.length,1);
  const before={pose:camera.getView(),paints,changes,measurements,renders,motions,selection,background};
  await binding.dispose();await mode.dispose();await controls.dispose();
  assert.equal(surface.listenerCount()+svg.listenerCount()+home.listenerCount()+modeButton.listenerCount(),1);
  assert.equal(captures.size,0);assert.equal(queued.size,0);
  for(const callback of late)callback(0);
  controls.setHandlers({onChange:()=>assert.fail('retired callback')});controls.reset();controls.resize();controls.refreshFrame();controls.pan(30,10);controls.zoomAt({x:300,y:300},2);controls.setView({x:0,y:0,k:1});controls.restoreView(null);
  mode.setEnabled(true);mode.finishTransition(false);home.dispatch('click');modeButton.dispatch('click');send('pointerup');send('wheel',{deltaY:-10});
  assert.deepEqual({pose:camera.getView(),paints,changes,measurements,renders,motions,selection,background},before);
  stopped.push(controls);
 }
 assert.equal(neighborEvents,30);
 const live=attachGestures(svg as unknown as SVGSVGElement,options);const before=camera.getView();let liveChanges=0;
 // A separate current camera consumer must survive disposal of an older attachment.
 camera.setOnChange(()=>liveChanges++);const baseline=liveChanges;await live.dispose();
 for(const old of stopped)await old.dispose();
 camera.pan(5,0);assert.equal(liveChanges,baseline+1);assert.notDeepEqual(camera.getView(),before);
 const saved=camera.getView();const count=paints;camera.zoomAt({x:300,y:300},1.01);assert.equal(paints,count,'released camera callback never paints the retired surface');assert.notDeepEqual(camera.getView(),saved);
 let retire=false,incoming=0,closing:Promise<void>|undefined;
 const interrupted=attachGestures(svg as unknown as SVGSVGElement,{...options,onChange(){if(retire)closing=interrupted.dispose();}});
 send('wheel',{deltaY:-10});retire=true;interrupted.setHandlers({onChange(){incoming++;}});await closing;
 assert.equal(incoming,0,'an outgoing callback can retire the attachment during handoff');assert.equal(queued.size,0);assert.equal(surface.listenerCount()+svg.listenerCount(),1);
});
