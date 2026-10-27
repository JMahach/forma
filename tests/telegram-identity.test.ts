import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPair, exportJWK, SignJWT, type JWTPayload } from 'jose';
import { verifyTelegramIdentity } from '../server/services/telegram-identity.ts';

const now=1_800_000_000_000, seconds=now/1000;
const key=await generateKeyPair('RS256',{extractable:true});
const publicKey={...await exportJWK(key.publicKey),kid:'telegram-test',alg:'RS256',use:'sig'};
const keys={keys:[publicKey]}, nonce='n'.repeat(43);
const options={clientId:'123456789',nonce,createdAt:now-60_000,expiresAt:now+29*60_000,now,keys};
const claims:JWTPayload={iss:'https://oauth.telegram.org',aud:options.clientId,sub:'9876543210',
 iat:seconds-10,exp:seconds+3600,nonce,id:987654321,preferred_username:'sample_user'};
const sign=(changes:JWTPayload={})=>new SignJWT({...claims,...changes})
 .setProtectedHeader({alg:'RS256',kid:publicKey.kid,typ:'JWT'}).sign(key.privateKey);
const denied=(token:unknown,settings=options)=>assert.rejects(verifyTelegramIdentity(token,settings),{code:'telegram_invalid'});

test('official ID token verifies into only the stable identity and optional handle',async()=>{
 const token=await sign({name:'Private Name',phone_number:'15555555555',picture:'https://example.test/photo',email:'untrusted@example.test'});
 assert.deepEqual(await verifyTelegramIdentity(token,options),{subject:'9876543210',userId:'987654321',username:'sample_user',expiresAt:(seconds+3600)*1000});
 assert.deepEqual(await verifyTelegramIdentity(await sign({preferred_username:undefined}),options),
  {subject:'9876543210',userId:'987654321',username:null,expiresAt:(seconds+3600)*1000});
});
test('issuer, one audience, nonce and token lifetime must all match',async()=>{
 for(const change of [{iss:'https://example.test'},{aud:'other-client'},{aud:[options.clientId,'other-client']},
 {nonce:'old-attempt'},{nonce:undefined},{exp:seconds},{exp:undefined},{iat:undefined},{iat:seconds+1},{iat:seconds-3600},
 {sub:undefined},{sub:''}]){
  await denied(await sign(change),options);
 }
});
test('the original attempt lifetime limits verification independently of token expiry',async()=>{
 const token=await sign();
 await denied(token,{...options,expiresAt:now});
 await denied(token,{...options,createdAt:now+1});
 await denied(token,{...options,nonce:'x'.repeat(43)});
 await denied(token,{...options,now:NaN});
});
test('invalid signatures, unsupported algorithms and attacker-selected keys are refused',async()=>{
 const valid=await sign();
 const parts=valid.split('.');parts[1]=Buffer.from(JSON.stringify({...claims,id:42})).toString('base64url');
 await denied(parts.join('.'));
 const foreign=await generateKeyPair('RS256');
 await denied(await new SignJWT(claims).setProtectedHeader({alg:'RS256',kid:publicKey.kid}).sign(foreign.privateKey));
 const hmac=await new SignJWT(claims).setProtectedHeader({alg:'HS256',kid:publicKey.kid}).sign(new TextEncoder().encode('not-a-public-key'));
 await denied(hmac);
 await denied(await new SignJWT(claims).setProtectedHeader({alg:'RS256',kid:'unknown'}).sign(key.privateKey));
 await denied(await new SignJWT(claims).setProtectedHeader({alg:'RS256',kid:publicKey.kid,jku:'https://attacker.invalid/keys'}).sign(key.privateKey));
});
test('identities and usernames are validated without rounding identifiers or trusting arbitrary strings',async()=>{
 for(const id of [0,-1,1.5,Number.MAX_SAFE_INTEGER+1,'01','a',{},null,undefined]){
  await denied(await sign({id}));
 }
 assert.equal((await verifyTelegramIdentity(await sign({id:'9876543210123456789'}),options)).userId,'9876543210123456789');
 for(const preferred_username of ['@name','two words','name\nother','x'.repeat(33),4]){
  await denied(await sign({preferred_username}));
 }
});
test('oversized or malformed tokens and key sets fail without exposing their contents',async()=>{
 for(const token of [null,{},'', 'x'.repeat(16*1024+1),'not.a.jwt'])await denied(token);
 await denied(await sign(),{...options,keys:{keys:[]}});
 try{await verifyTelegramIdentity('PRIVATE-TOKEN',options);assert.fail('must reject');}
 catch(error){assert.equal((error as Error).message,'telegram_invalid');assert.equal((error as Error).cause,undefined);}
});
