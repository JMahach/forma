import type {IncomingMessage,ServerResponse} from 'node:http';
import {sendJSON} from './json.ts';

const methods=new Map<string,string>([
  ['/api/cities','GET'],['/api/calculate','POST'],['/api/account','GET'],['/api/auth/attempt','GET'],
  ...['email/start','email/resend','email/verify','confirm','cancel','logout','telegram/start','telegram/verify']
    .map(path=>['/api/auth/'+path,'POST'] as [string,string]),
  ['/api/charts','GET, POST'],['/api/charts/add','POST'],['/api/cycles/events','POST'],['/api/cycles/chart','POST'],
  ['/api/charts/catalog','GET'],['/api/charts/catalog/confirm','GET'],
  ['/api/chart/day','POST'],['/api/transit/day','GET, HEAD'],['/api/lifetime','GET'],['/api/lifetime/meta','GET'],['/api/diagnostics','POST'],
]);

function allowedMethods(path:string):string|undefined {
  const fixed=methods.get(path);
  if(fixed)return fixed;
  if(/^\/api\/(?:shared-charts\/[^/]+|charts\/operations\/[^/]+)$/.test(path))return 'GET';
  if(/^\/api\/charts\/[^/]+\/returns\/(?:events|chart|accept)$/.test(path))return 'POST';
  if(/^\/api\/charts\/[^/]+\/returns\/[^/]+\/package$/.test(path))return 'GET';
  if(/^\/api\/charts\/[^/]+\/day$/.test(path))return 'GET';
  if(/^\/api\/charts\/[^/]+$/.test(path))return 'GET, PATCH, DELETE';
}

/** Transport rejection happens before service availability, credentials or body consumption. */
export function rejectApiMethod(req:IncomingMessage,res:ServerResponse,path:string):boolean {
  if(path!=='/api' && !path.startsWith('/api/'))return false;
  const allow=allowedMethods(path);
  if(!allow){sendJSON(res,404,{error:'not_found'});return true;}
  if(allow.split(', ').includes(req.method??''))return false;
  sendJSON(res,405,{error:'method_not_allowed'},{Allow:allow});return true;
}
