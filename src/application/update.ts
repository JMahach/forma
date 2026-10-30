export interface UpdatePort {
  restored():boolean;
  ready():boolean;
  selection():string;
  sources:{readonly temporaryId:string|null;readonly publicId:string|null;hasOwn(id:string):boolean;canRestore(id:string):boolean|Promise<boolean>};
  checkpoint():boolean;
}
interface UpdateRuntime {ready():boolean;changed():void;idle?():Promise<void>|void}
interface Preparation {control:AbortController;unlink():void}
function durableSelection(port:UpdatePort,id:string) {
  return id==='current-transit' || id===port.sources.temporaryId
    || !port.sources.hasOwn(id) && id===port.sources.publicId || port.sources.canRestore(id);
}
function cancellable(work:Promise<boolean>,signal:AbortSignal) {
  return new Promise<boolean>(resolve=>{
    const done=(value:boolean)=>{signal.removeEventListener('abort',cancel);resolve(value);};
    const cancel=()=>done(false);
    if(signal.aborted){resolve(false);return;}
    signal.addEventListener('abort',cancel,{once:true});work.then(done,()=>done(false));
  });
}

/** One permission to leave this runtime. Its caller owns the cancellation deadline. */
export function createUpdatePreparation(port:UpdatePort,runtime:UpdateRuntime) {
  let current:Preparation|null=null;
  function release(preparation:Preparation) {
    preparation.unlink();
    const owned=current===preparation;if(owned)current=null;
    preparation.control.abort();if(owned)runtime.changed();
  }
  function prepare(signal?:AbortSignal):boolean|Promise<boolean> {
    if(signal?.aborted || !runtime.ready())return false;
    const previous=current;
    const preparation:Preparation={control:new AbortController(),unlink:()=>signal?.removeEventListener('abort',cancel)};
    const cancel=()=>release(preparation);
    current=preparation;if(previous)release(previous);signal?.addEventListener('abort',cancel,{once:true});runtime.changed();
    const valid=()=>current===preparation && !preparation.control.signal.aborted && runtime.ready();
    const selected=port.selection();
    const checkpoint=()=>valid() && selected===port.selection() && port.checkpoint();
    const finish=(ready:boolean)=>{const accepted=ready && valid();if(!accepted || !signal)release(preparation);return accepted;};
    const commit=():boolean|Promise<boolean>=>{
      if(!valid() || selected!==port.selection())return false;
      const durable=durableSelection(port,selected);
      return typeof durable==='boolean'?durable && checkpoint():durable.then(value=>value && checkpoint());
    };
    try {
      const idle=runtime.idle?.(),result=idle?idle.then(commit):commit();
      return typeof result==='boolean'?finish(result):cancellable(result,preparation.control.signal).then(finish);
    }catch{release(preparation);return false;}
  }
  return {prepare,get active(){return current!==null;},stop(){if(current)release(current);}};
}
