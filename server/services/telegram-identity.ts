import { createLocalJWKSet, jwtVerify, type JSONWebKeySet } from 'jose';

export const TELEGRAM_IDENTITY_LIMITS = Object.freeze({ tokenCharacters: 16 * 1024, keyBytes: 64 * 1024, keyCount: 16 });

export interface TelegramIdentity { subject:string; userId:string; username:string|null; expiresAt:number }
export interface TelegramVerification {
 clientId:string; nonce:string; createdAt:number; expiresAt:number; now:number;
 /** Trusted keys obtained by a server-owned adapter from Telegram's fixed JWKS endpoint. */
 keys:JSONWebKeySet;
}
export class TelegramIdentityError extends Error {
 readonly code='telegram_invalid';
 constructor(){super('telegram_invalid');this.name='TelegramIdentityError';}
}
const clock=(value:number)=>Number.isSafeInteger(value) && value>=0 && value<=8.64e15;
const identifier=(value:unknown):string|null=>{
 if(typeof value==='number')return Number.isSafeInteger(value) && value>0 ? String(value):null;
 return typeof value==='string' && /^[1-9][0-9]{0,19}$/.test(value) ? value:null;
};
/**
 * Official OIDC identity only: https://core.telegram.org/bots/telegram-login
 * The account owner must bind/consume the nonce once and confirm email before creating an account.
 * This verifier neither fetches token-supplied URLs nor persists a token or grants a local session.
 */
export async function verifyTelegramIdentity(token:unknown,options:TelegramVerification):Promise<TelegramIdentity> {
 try {
  const {clientId,nonce,createdAt,expiresAt,now,keys}=options;
  if(typeof token!=='string' || token.length>TELEGRAM_IDENTITY_LIMITS.tokenCharacters || !token.length
   || !identifier(clientId) || !/^[A-Za-z0-9_-]{32,128}$/.test(nonce)
   || !clock(now) || !clock(createdAt) || !clock(expiresAt) || now<createdAt || now>=expiresAt
   || !keys || !Array.isArray(keys.keys) || !keys.keys.length || keys.keys.length>TELEGRAM_IDENTITY_LIMITS.keyCount
   || Buffer.byteLength(JSON.stringify(keys),'utf8')>TELEGRAM_IDENTITY_LIMITS.keyBytes)throw new TelegramIdentityError();
  const {payload,protectedHeader}=await jwtVerify(token,createLocalJWKSet(keys),{
   algorithms:['RS256'],issuer:'https://oauth.telegram.org',audience:clientId,
   requiredClaims:['iss','aud','sub','iat','exp','nonce','id'],currentDate:new Date(now),
  });
  if(Object.keys(protectedHeader).some(name=>!['alg','kid','typ'].includes(name))
   || protectedHeader.typ!==undefined && protectedHeader.typ!=='JWT'
   || payload.aud!==clientId || payload.nonce!==nonce
   || !Number.isSafeInteger(payload.iat) || payload.iat!<Math.floor(createdAt/1000) || payload.iat!>Math.floor(now/1000)
   || typeof payload.sub!=='string' || !payload.sub.trim() || payload.sub.length>255
   || /[\u0000-\u001f\u007f]/.test(payload.sub))throw new TelegramIdentityError();
  const tokenExpiresAt=Number(payload.exp)*1000;
  if(!clock(tokenExpiresAt))throw new TelegramIdentityError();
  const userId=identifier(payload.id);
  const username=payload.preferred_username;
  if(!userId || username!==undefined && (typeof username!=='string' || !/^[A-Za-z0-9_]{1,32}$/.test(username))) {
   throw new TelegramIdentityError();
  }
  return{subject:payload.sub,userId,username:username===undefined?null:username as string,expiresAt:tokenExpiresAt};
 }catch{throw new TelegramIdentityError();}
}
