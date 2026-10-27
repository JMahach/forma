import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import type { IncomingMessage } from 'node:http';
import { captureResponse } from './helpers/http-response.ts';
import { createPublicFileHandler } from '../server/http/public-files.ts';
const root=fileURLToPath(new URL('../',import.meta.url));
test('diagnostic metadata comes from the server configuration, independent of hostname',async()=>{
 const handler=createPublicFileHandler({root,environment:'production',appVersion:'0.2-test-build'});
 const response=captureResponse<Buffer>();
 await handler({method:'GET',headers:{host:'127.0.0.1:3636'}} as IncomingMessage,response,'/account');
 assert.equal(response.status,200);const html=response.body.toString('utf8');
 assert.match(html,/<body[^>]*data-app-environment="production"/);
 assert.match(html,/<body[^>]*data-app-version="0.2-test-build"/);
 assert.equal(response.headers['Cache-Control'],'no-cache');
});
test('invalid diagnostic configuration cannot inject HTML or silently claim a different environment',()=>{
 assert.throws(()=>createPublicFileHandler({root,appVersion:'x" onload="secret'}),/version/i);
 assert.throws(()=>createPublicFileHandler({root,environment:'unknown' as 'stand'}),/environment/i);
});
