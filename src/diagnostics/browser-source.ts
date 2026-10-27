import type { ClientReportMetadata } from '../../shared/client-report-contract.ts';

type BrowserMetadata=Pick<ClientReportMetadata,'browser'|'os'|'device'>;
export type BrowserSource=Pick<EventTarget,'addEventListener'|'removeEventListener'>;
export type BrowserNavigator=Pick<Navigator,'userAgent'>;

/** Keep only the agreed coarse fields. Never retain the raw UA, model or entropy hints. */
export function browserMetadata(navigator:BrowserNavigator):BrowserMetadata {
 try {
  const ua=navigator.userAgent;
  if(typeof ua!=='string')return {};
  const result:BrowserMetadata={};
  const candidates:readonly [NonNullable<BrowserMetadata['browser']>['name'],RegExp][]=[
   ['edge',/(?:Edg|Edge|EdgA|EdgiOS)\/([\d.]+)/],['opera',/(?:OPR|OPiOS)\/([\d.]+)/],
   ['samsung_internet',/SamsungBrowser\/([\d.]+)/],['firefox',/(?:Firefox|FxiOS)\/([\d.]+)/],
   ['chromium',/Chromium\/([\d.]+)/],['chrome',/(?:Chrome|CriOS)\/([\d.]+)/],
   ['safari',/Version\/([\d.]+).*Safari\//],
  ];
  for(const [name,pattern] of candidates){const match=pattern.exec(ua);if(match){
   const version=match[1]!;result.browser={name,...(version.length<=32 && /^\d+(?:\.\d+){0,3}$/.test(version)?{version}:{})};break;
  }}
  if(/iPhone|iPad|iPod/.test(ua))result.os='ios';
  else if(/Android/.test(ua))result.os='android';
  else if(/CrOS/.test(ua))result.os='chromeos';
  else if(/Windows NT/.test(ua))result.os='windows';
  else if(/Macintosh|Mac OS X/.test(ua))result.os='macos';
  else if(/Linux/.test(ua))result.os='linux';
  if(/iPad|Tablet/.test(ua) || result.os==='android' && !/Mobile/.test(ua))result.device='tablet';
  else if(/iPhone|iPod|Mobile/.test(ua))result.device='phone';
  else if(['windows','macos','linux','chromeos'].includes(result.os??''))result.device='desktop';
  return result;
 }catch{return {};}
}

/** The journal owns these subscriptions; resource URLs and raw error text never cross its port. */
export function attachBrowserSource(target:BrowserSource,report:(error:unknown,stage:'render'|'wait')=>void) {
 const error:EventListener=event=>{try{if('error' in event)report(event.error,'render');}catch{}};
 const rejection:EventListener=event=>{try{if('reason' in event)report(event.reason,'wait');}catch{}};
 const detach=()=>{try{target.removeEventListener('error',error);target.removeEventListener('unhandledrejection',rejection);}catch{}};
 try{target.addEventListener('error',error);target.addEventListener('unhandledrejection',rejection);}catch{detach();}
 return detach;
}
