export interface PageLifecycle {
 readonly active:boolean;
 subscribe(listener:(returned:boolean)=>void):()=>void;
}
interface Options {
 events:EventTarget;visibility:EventTarget&{hidden:boolean};
 online():boolean;subscribeConnection(listener:()=>void):()=>void;
}
/** One lifecycle source for automatic work; local UI restoration remains with its owner. */
export function createPageLifecycle({events,visibility,online,subscribeConnection}:Options):PageLifecycle {
 let suspended=false;
 const active=()=>!suspended && !visibility.hidden && online();
 return {
  get active(){return active();},
  subscribe(listener){
   let previous=active();
   const notify=(returned=false)=>{const next=active();listener(next && (returned || !previous));previous=next;};
   const shown=()=>{suspended=false;notify(true);};
   const hidden=()=>{suspended=true;notify();};
   const visible=()=>notify(!visibility.hidden);
   const connected=()=>notify();
   const bindings:[EventTarget,string,()=>void][]=[
    [events,'pageshow',shown],[events,'pagehide',hidden],[visibility,'freeze',hidden],
    [visibility,'resume',shown],[visibility,'visibilitychange',visible],
   ];
   for(const [target,name,handler] of bindings)target.addEventListener(name,handler);
   const stop=subscribeConnection(connected);
   return()=>{stop();for(const [target,name,handler] of bindings)target.removeEventListener(name,handler);};
  },
 };
}
