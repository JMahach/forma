import test from 'node:test';
import assert from 'node:assert/strict';
import {Readable} from 'node:stream';
import type {IncomingMessage} from 'node:http';
import {createRequestHandler} from '../server/http/app.ts';
import {createCityCatalog} from '../server/services/cities.ts';
import {captureResponse} from './helpers/http-response.ts';

test('API method rejection precedes service access and advertises only supported methods',async()=>{
  let work=0;
  const forbidden=()=>{work++;throw Error('must reject before business work');};
  const handler=createRequestHandler({root:'/unused',cities:createCityCatalog([]),calculate:forbidden,
    accountHandler:forbidden,chartHandler:forbidden,publicFiles:forbidden});
  const routes=[
    ['/api/cities','GET'],['/api/calculate','POST'],['/api/account','GET'],['/api/auth/attempt','GET'],
    ...['email/start','email/resend','email/verify','confirm','cancel','logout','telegram/start','telegram/verify'].map(path=>['/api/auth/'+path,'POST']),
    ['/api/charts','GET, POST'],['/api/charts/add','POST'],['/api/charts/123','GET, PATCH, DELETE'],
    ['/api/charts/catalog','GET'],['/api/charts/catalog/confirm','GET'],['/api/charts/123/returns/saturn/package','GET'],
    ['/api/charts/operations/abcd','GET'],['/api/shared-charts/123','GET'],
    ...['events','chart','accept'].map(action=>['/api/charts/123/returns/'+action,'POST']),
    ['/api/cycles/events','POST'],['/api/cycles/chart','POST'],['/api/chart/day','POST'],
    ['/api/transit/day','GET, HEAD'],['/api/lifetime','GET'],['/api/lifetime/meta','GET'],['/api/diagnostics','POST'],
  ];
  for(const [url,allow] of routes) {
    for(const method of ['OPTIONS',...(allow!.includes('HEAD')?[]:['HEAD'])]) {
      const request=Object.assign(Readable.from([]),{url,method,headers:{host:'localhost'}}) as IncomingMessage;
      const response=captureResponse();await handler(request,response);
      assert.equal(response.status,405,url+' '+method);assert.equal(response.headers.Allow,allow,url);
      assert.equal(response.headers['Access-Control-Allow-Origin'],undefined);
    }
  }
  assert.equal(work,0,'wrong methods do not read accounts, calculate, write or reach static files');
});

test('unknown API paths are 404 even when their service is unavailable',async()=>{
  let work=0;
  const forbidden=()=>{work++;throw Error('unknown API must not reach services or static files');};
  for(const owners of [{},{accountHandler:forbidden,chartHandler:forbidden}]) {
    const handler=createRequestHandler({root:'/unused',cities:createCityCatalog([]),calculate:forbidden,publicFiles:forbidden,...owners});
    for(const url of ['/api/missing','/api/auth/missing','/api/charts/123/missing','/api/shared-charts/123/missing','/api/cycles/missing']) {
      for(const method of ['GET','POST','OPTIONS']) {
        const request=Object.assign(Readable.from([]),{url,method,headers:{host:'localhost'}}) as IncomingMessage;
        const response=captureResponse();await handler(request,response);
        assert.equal(response.status,404,url+' '+method);assert.equal(response.headers.Allow,undefined);
      }
    }
  }
  assert.equal(work,0);
});
