export interface PageLifecycle {
 readonly active:boolean;
 subscribe(listener:(returned:boolean)=>void):()=>void;
}
interface Options {
 events:EventTarget;visibility:EventTarget&{hidden:boolean};
 online():boolean;subscribeConnection(listener:()=>void):()=>void;
}
/** One lifecycle source for automatic work; local UI restoration remains with its owner. */
export function createPageLifecycle({events,visibility,online,subscribeConnection}:Options):PageLifecycle & {readonly visible:boolean} {
 let suspended=false;
 const visible=()=>!suspended && !visibility.hidden;
 const active=()=>visible() && online();
 const listeners=new Set<(returned:boolean)=>void>();
 let release:(()=>void)|undefined;
 function listen(){
  const controller=new AbortController();
  let previous=active();
  const notify=(returned=false)=>{const next=active(),resumed=next && (returned || !previous);previous=next;
   for(const listener of listeners)listener(resumed);};
  const shown=()=>{suspended=false;notify(true);};
  const hidden=()=>{suspended=true;notify();};
  const visibilityChanged=()=>notify(!visibility.hidden);
  const bindings:[EventTarget,string,()=>void][]=[
   [events,'pageshow',shown],[events,'pagehide',hidden],[visibility,'freeze',hidden],
   [visibility,'resume',shown],[visibility,'visibilitychange',visibilityChanged],
  ];
  for(const [target,name,handler] of bindings)target.addEventListener(name,handler,{signal:controller.signal});
  const stop=subscribeConnection(()=>notify());
  return()=>{stop();controller.abort();};
 }
 return {
  get active(){return active();},
  get visible(){return visible();},
  subscribe(listener){
   listeners.add(listener);release??=listen();
   return()=>{listeners.delete(listener);if(!listeners.size){release?.();release=undefined;}};
  },
 };
}
