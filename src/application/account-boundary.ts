import {assign,fromPromise,sendParent,setup} from 'xstate';
import type {AccountAccess,AccountBoundaryRequest,AccountBoundaryWork,AccountEvent,AccountPort} from './ports.ts';

interface Context {
  access: AccountAccess|null|undefined;
  lastAccess: AccountAccess|null;
  request: AccountBoundaryRequest|null;
  work: AccountBoundaryWork|null;
}
const accessKey=(access:AccountAccess|null|undefined)=>JSON.stringify(access);

function ownLogout(context:Context,event:AccountEvent) {
  return event.type==='LogoutObserved'
    && (!context.lastAccess || event.ids.includes(context.lastAccess.sessionId))
    && !context.request?.logoutIds?.every(id=>event.ids.includes(id));
}

export function createAccountBoundaryMachine(port:AccountPort,runtimeId:string) {
  let generation=0;
  return setup({
    types:{context:{} as Context,events:{} as AccountEvent},
    actors:{finish:fromPromise(({input}:{input:AccountBoundaryWork})=>input.ready)},
    guards:{
      changed:({context,event})=>event.type==='SessionChanged' && accessKey(event.access)!==accessKey(context.access),
      ownLogout:({context,event})=>ownLogout(context,event),
    },
    actions:{
      begin:assign(({context,event})=>{
        const access=event.type==='SessionChanged'?event.access:null;
        const request:AccountBoundaryRequest={runtimeId,generation:++generation,access,previous:context.lastAccess,
          logoutIds:event.type==='LogoutObserved'?event.ids:null};
        return {access,lastAccess:access??context.lastAccess,request,work:port.begin(request)};
      }),
      retry:assign({work:({context})=>({...context.work!,ready:context.work!.retry()})}),
      settled:({context})=>context.work!.settled(),
      release:assign({work:null}),
    },
  }).createMachine({
    initial:'unconnected',context:{access:undefined,lastAccess:null,request:null,work:null},
    on:{
      SessionChanged:{guard:'changed',target:'.preparing',actions:['begin',sendParent({type:'AccountBoundaryStarted'})]},
      LogoutObserved:{guard:'ownLogout',target:'.preparing',actions:['begin',sendParent({type:'AccountBoundaryStarted'})]},
    },
    states:{
      unconnected:{},
      preparing:{invoke:{src:'finish',input:({context})=>context.work!,
        onDone:{target:'ready',actions:['settled','release']},onError:'failed'}},
      ready:{},
      failed:{on:{RetryAccountBoundary:{target:'preparing',actions:'retry'}}},
    },
  });
}
