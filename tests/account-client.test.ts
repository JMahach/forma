import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import type { IncomingMessage } from 'node:http';
import { captureResponse } from './helpers/http-response.ts';
import { openDatabase } from '../server/storage/database.ts';
import { createAccounts } from '../server/services/accounts.ts';
import type { CodeMail } from '../server/mail/code-mail.ts';
import { createAccountHandler } from '../server/http/accounts.ts';
import { createAccountClient } from '../src/data/account-client.ts';

function server(t: { after(callback: () => void): void }, telegram?: Parameters<typeof createAccounts>[0]['telegram']) {
  const database = openDatabase(':memory:'); t.after(() => database.close());
  let time = 1_000_000;
  const messages: CodeMail[] = [], calls: string[] = [], cookies = new Map<string, string>();
  const accounts = createAccounts({ database, key: Buffer.alloc(32, 7), now: () => time, telegram,
    mail: { async enqueue(value) { messages.push(value); }, async cancel() {} } });
  const handle = createAccountHandler(accounts, { origins: ['https://forma.example.test'], now: () => time });
  let hold: ((path: string) => Promise<void>) | null = null;
  let beforeHandle: ((path: string) => Promise<void>) | null = null;
  const fetch: typeof globalThis.fetch = async (input, options = {}) => {
    const url = new URL(String(input), 'https://forma.example.test'); calls.push(url.pathname);
    assert.equal(options.credentials, 'same-origin'); assert.equal(options.cache, 'no-store');
    const request = Object.assign(Readable.from(options.body ? [Buffer.from(String(options.body))] : []), {
      method: options.method ?? 'GET', url: url.pathname + url.search,
      headers: { host: url.host, origin: url.origin, 'content-type': 'application/json',
        cookie: [...cookies].map(([name, value]) => `${name}=${value}`).join('; ') },
      socket: { remoteAddress: '192.0.2.1' },
    }) as unknown as IncomingMessage;
    await beforeHandle?.(url.pathname);
    const response = captureResponse(); await handle(request, response, url);
    await hold?.(url.pathname);
    for (const header of (response.headers['Set-Cookie'] ?? []) as string[]) {
      const pair = header.split(';')[0]!, at = pair.indexOf('='), name = pair.slice(0, at);
      if (/Max-Age=0(?:;|$)/.test(header)) cookies.delete(name); else cookies.set(name, pair.slice(at + 1));
    }
    return new Response(response.body, { status: response.status,
      headers: { 'content-type': 'application/json', date: new Date(time).toUTCString() } });
  };
  return { accounts, client: createAccountClient({ fetch, now: () => time }), fetch, calls, messages,
    advance(ms: number) { time += ms; }, hold(value: typeof hold) { hold = value; }, beforeHandle(value: typeof beforeHandle) { beforeHandle = value; } };
}

test('real account HTTP requires verify and confirm before the client sees an authenticated profile', async t => {
  const f = server(t), { client } = f;
  assert.equal(await client.current(), null);
  const attempt = await client.start('person@example.test');
  assert.equal(attempt.expiresAt, 2_800_000); assert.equal(attempt.codeExpiresAt, 1_600_000);
  await client.verify(attempt.id, f.messages[0]!.code);
  assert.equal(await client.current(), null);
  const progress = await client.progress(attempt.id);
  assert.equal(progress.stage, 'verified'); assert.equal(progress.canConfirm, true);
  const confirmed = await client.confirm(attempt.id);
  assert.equal(confirmed.account.email, 'person@example.test'); assert.equal(confirmed.session.id, attempt.id);
  assert.deepEqual(await client.current(), confirmed);
});

test('client preserves server retryAt and replacing the same email preserves the original attempt deadline', async t => {
  const f = server(t), attempt = await f.client.start('person@example.test');
  await assert.rejects(f.client.start('person@example.test', attempt.id), error => {
    assert.equal((error as { code: string }).code, 'auth_rate_limited');
    assert.equal((error as { retryAt: number }).retryAt, attempt.resendAt); return true;
  });
  f.advance(25 * 60_000);
  const later = await f.client.start('PERSON@example.test', attempt.id);
  assert.equal(later.id, attempt.id); assert.equal(later.expiresAt, attempt.expiresAt);
  assert.equal(later.codeExpiresAt, attempt.expiresAt);
});

test('a delayed verify cookie cannot reopen the context closed by logout', async t => {
  const f = server(t), attempt = await f.client.start('person@example.test');
  let release!: () => void, reached!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const reachedVerify = new Promise<void>(resolve => { reached = resolve; });
  f.hold(async path => { if (path.endsWith('/verify')) { reached(); await pending; } });
  const controller = new AbortController();
  const verifying = f.client.verify(attempt.id, f.messages[0]!.code, controller.signal);
  await reachedVerify; controller.abort(); await f.client.logout(attempt.id); release();
  await assert.rejects(verifying, { name: 'AbortError' });
  assert.equal(await f.client.current(), null);
  await assert.rejects(f.client.confirm(attempt.id), error => (error as { code: string }).code === 'attempt_expired');
});

test('client rejects malformed success and never retries a failed write', async () => {
  let calls = 0;
  const client = createAccountClient({ fetch: async () => { calls++; return Response.json({ attempt: { id: 'bad' }, delivery: 'queued' }); } });
  await assert.rejects(client.start('person@example.test'), error => (error as { code: string }).code === 'invalid_response');
  assert.equal(calls, 1);
});

test('client countdown clock follows the HTTP server rather than a skewed browser clock', async () => {
  let clock = 100;
  const client = createAccountClient({ now: () => clock, fetch: async () => Response.json({ account: null, session: null }, { headers: { date: new Date(1_000_000).toUTCString() } }) });
  await client.current(); assert.equal(client.now(), 1_000_000);
  clock += 10_000; assert.equal(client.now(), 1_010_000);
});

import { createAccountFlow, createAccountServerRequest } from '../src/state/account-flow.ts';

test('real flow revokes a pending verify and ignores its late response after logout', async t => {
  const f = server(t), flow = createAccountFlow({ connection: () => 'online', now: f.client.now,
    request: createAccountServerRequest(f.client), onLogout: async ids => { for (const id of ids) await f.client.logout(id); } });
  await flow.begin(); flow.input('email', 'person@example.test'); await flow.submit();
  flow.input('code', f.messages[0]!.code);
  let release!: () => void, reached!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; }), ready = new Promise<void>(resolve => { reached = resolve; });
  f.hold(async path => { if (path.endsWith('/verify')) { reached(); await held; } });
  const verifying = flow.submit(); await ready; await flow.logout(); release(); await verifying;
  assert.equal(flow.state.screen, 'guest'); assert.equal(flow.state.identity, null);
  assert.equal(await f.client.current(), null);
  assert.equal(f.calls.includes('/api/auth/confirm'), false);
});

for (const lost of ['verify', 'confirm']) test(`explicit retry recovers lost ${lost} response without another code verification`, async t => {
  const f = server(t); let lose = true;
  const client = createAccountClient({ now: f.client.now, fetch: async (input, options) => {
    const response = await f.fetch(input, options);
    if (lose && String(input).endsWith('/' + lost)) {
      lose = false; Object.defineProperty(response, 'json', { value: async () => { throw new TypeError('Connection lost while reading body'); } });
    }
    return response;
  } });
  const flow = createAccountFlow({ connection: () => 'online', now: client.now, request: createAccountServerRequest(client) });
  await flow.begin(); flow.input('email', 'person@example.test'); await flow.submit();
  flow.input('code', f.messages[0]!.code); await flow.submit();
  assert.equal(flow.state.screen, 'guest');
  f.advance(11 * 60_000); flow.tick();
  await flow.submit();
  assert.equal(flow.state.screen, 'unlinked'); assert.equal(flow.state.identity?.email, 'person@example.test');
  assert.equal(f.calls.filter(path => path.endsWith('/verify')).length, 1);
});


test('account client contract keeps email operations and uses shared attempt, confirm and cancel routes', async () => {
  const id = 'a'.repeat(32), expiresAt = 2_000_000;
  const attempt = { id, expiresAt, codeExpiresAt: 1_600_000, resendAt: 1_060_000 };
  const profile = { account: { id: '1', email: 'person@example.test', telegramLinked: false, telegramHandle: null },
    session: { id, expiresAt } };
  const replies = [
    { attempt, delivery: 'queued' }, { attempt, delivery: 'queued' },
    { ...attempt, stage: 'verified', canConfirm: true },
    { attemptId: id, needsConfirmation: true }, profile,
    { closed: true, contextId: id }, { closed: true, contextId: id },
  ];
  const calls: { url: string; method: string | undefined; body: unknown }[] = [];
  const client = createAccountClient({ fetch: async (input, options = {}) => {
    calls.push({ url: String(input), method: options.method,
      body: options.body ? JSON.parse(String(options.body)) : null });
    assert.equal(options.credentials, 'same-origin');
    assert.equal(options.cache, 'no-store');
    return Response.json(replies[calls.length - 1]);
  } });
  await client.start('person@example.test', id);
  await client.resend(id);
  await client.progress(id);
  await client.verify(id, '123456');
  await client.confirm(id);
  await client.cancel(id);
  await client.logout(id);
  assert.deepEqual(calls, [
    { url: '/api/auth/email/start', method: 'POST', body: { email: 'person@example.test', replaceId: id } },
    { url: '/api/auth/email/resend', method: 'POST', body: { attemptId: id } },
    { url: '/api/auth/attempt?id=' + id, method: 'GET', body: null },
    { url: '/api/auth/email/verify', method: 'POST', body: { attemptId: id, code: '123456' } },
    { url: '/api/auth/confirm', method: 'POST', body: { attemptId: id } },
    { url: '/api/auth/cancel', method: 'POST', body: { attemptId: id } },
    { url: '/api/auth/logout', method: 'POST', body: { sessionId: id } },
  ]);
});

for (const telegram of [
  { telegramLinked: true, telegramHandle: null },
  { telegramLinked: false, telegramHandle: null },
  { telegramLinked: true, telegramHandle: '@person' },
  { telegramLinked: false, telegramHandle: '@previous' },
]) test(`account client profile preserves explicit Telegram state ${JSON.stringify(telegram)}`, async () => {
  const id = 'a'.repeat(32);
  const profile = { account: { id: '1', email: 'person@example.test', ...telegram },
    session: { id, expiresAt: 2_000_000 } };
  const client = createAccountClient({ fetch: async () => Response.json(profile) });
  assert.deepEqual(await client.current(), profile);
  assert.deepEqual(await client.confirm(id), profile);
});

for (const method of ['current', 'confirm'] as const) {
  test(`account client profile rejects missing or wrongly typed Telegram fields on ${method}`, async () => {
    const id = 'a'.repeat(32);
    const invalid = [
      ...[undefined, null, 0, 1, 'true', 'false', [], {}].map(telegramLinked => ({ telegramLinked, telegramHandle: null })),
      ...[undefined, true, 42, [], {}].map(telegramHandle => ({ telegramLinked: true, telegramHandle })),
    ];
    for (const telegram of invalid) {
      let calls = 0;
      const client = createAccountClient({ fetch: async () => {
        calls++;
        return Response.json({ account: { id: '1', email: 'person@example.test', ...telegram },
          session: { id, expiresAt: 2_000_000 } });
      } });
      await assert.rejects(method === 'current' ? client.current() : client.confirm(id),
        error => (error as { code: string }).code === 'invalid_response', JSON.stringify(telegram));
      assert.equal(calls, 1, 'invalid response never triggers an automatic retry');
    }
  });
}


const telegramId = 'a'.repeat(32);
const telegramStart = { attempt: { id: telegramId, expiresAt: 2_800_000 },
  telegram: { clientId: '12345', nonce: 'n'.repeat(43), scope: ['profile'] } };
const clientInvalid = (error: unknown) => (error as { code: string }).code === 'invalid_response';

test('Telegram client completes email onboarding and later confirms a linked identity without a code', async t => {
  const f = server(t, { clientId: '12345', async verify(token) {
    assert.equal(token, 'provider-token');
    return { subject: 'subject', userId: '54321', username: null, expiresAt: 2_000_000 };
  } });
  const { client } = f, started = await client.startTelegram();
  assert.deepEqual(await client.startTelegram(started.attempt.id), started);
  assert.deepEqual(await client.progress(started.attempt.id), { ...started.attempt,
    codeExpiresAt: 0, resendAt: 0, stage: 'telegram', canConfirm: false });
  assert.deepEqual(await client.verifyTelegram(started.attempt.id, 'provider-token'),
    { attemptId: started.attempt.id, needsEmail: true, needsConfirmation: false });
  assert.equal((await client.progress(started.attempt.id)).stage, 'email');
  assert.equal(await client.current(), null);
  const email = await client.start('telegram@example.test', started.attempt.id);
  assert.equal((await client.progress(email.id)).stage, 'code');
  await client.verify(email.id, f.messages[0]!.code);
  const first = await client.confirm(email.id);
  assert.equal(first.account.telegramLinked, true); assert.equal(first.account.telegramHandle, null);
  await client.logout(first.session.id);
  const next = await client.startTelegram();
  assert.deepEqual(await client.verifyTelegram(next.attempt.id, 'provider-token'),
    { attemptId: next.attempt.id, needsEmail: false, needsConfirmation: true });
  assert.deepEqual(await client.progress(next.attempt.id), { ...next.attempt,
    codeExpiresAt: 0, resendAt: 0, stage: 'verified', canConfirm: true });
  assert.equal((await client.confirm(next.attempt.id)).account.id, first.account.id);
  assert.equal(f.messages.length, 1);
});

test('Telegram client sends tokens only in the verify body and returns only public contract fields', async () => {
  const calls: { path: string; body: unknown }[] = [], signal = new AbortController().signal;
  const client = createAccountClient({ fetch: async (input, options = {}) => {
    const path = String(input); calls.push({ path, body: JSON.parse(String(options.body)) });
    assert.equal(options.method, 'POST'); assert.equal(options.credentials, 'same-origin');
    assert.equal(options.cache, 'no-store'); assert.equal(options.signal, signal);
    assert.equal(new Headers(options.headers).has('authorization'), false);
    return Response.json(path.endsWith('/start') ? { ...telegramStart, binding: {secret:'private'},
      attempt: {...telegramStart.attempt, secret:'private'}, telegram: {...telegramStart.telegram, token:'private'} }
      : { attemptId: telegramId, needsEmail: true, needsConfirmation: false, grant: {secret:'private'}, idToken:'private' });
  } });
  assert.deepEqual(await client.startTelegram(undefined, signal), telegramStart);
  assert.deepEqual(await client.verifyTelegram(telegramId, 'provider-token', signal),
    { attemptId: telegramId, needsEmail: true, needsConfirmation: false });
  assert.deepEqual(await client.startTelegram(telegramId, signal), telegramStart);
  assert.deepEqual(calls, [
    {path:'/api/auth/telegram/start',body:{}},
    {path:'/api/auth/telegram/verify',body:{attemptId:telegramId,idToken:'provider-token'}},
    {path:'/api/auth/telegram/start',body:{replaceId:telegramId}},
  ]);
});

test('Telegram client rejects malformed start responses and mismatched replacement attempts', async () => {
  const invalid = [null, {}, {...telegramStart, attempt:null}, {...telegramStart, telegram:null},
    ...['bad', 1, null].map(id => ({...telegramStart,attempt:{...telegramStart.attempt,id}})),
    ...[0, -1, 1.5, '2800000', null].map(expiresAt => ({...telegramStart,attempt:{...telegramStart.attempt,expiresAt}})),
    ...['', '0', '0123', '1'.repeat(21), 123].map(clientId => ({...telegramStart,telegram:{...telegramStart.telegram,clientId}})),
    ...['', 'n'.repeat(31), 'n'.repeat(129), ' '.repeat(43), null].map(nonce => ({...telegramStart,telegram:{...telegramStart.telegram,nonce}})),
    ...[[], ['profile','email'], ['email'], 'profile', null].map(scope => ({...telegramStart,telegram:{...telegramStart.telegram,scope}}))];
  for (const body of invalid) {
    let calls=0; const client=createAccountClient({fetch:async()=>{calls++;return Response.json(body);}});
    await assert.rejects(client.startTelegram(), clientInvalid); assert.equal(calls,1);
  }
  const client=createAccountClient({fetch:async()=>Response.json(telegramStart)});
  await assert.rejects(client.startTelegram('b'.repeat(32)), clientInvalid);
});

test('Telegram client rejects contradictory verification results and results for another attempt', async () => {
  for (const body of [
    {attemptId:telegramId,needsEmail:true,needsConfirmation:true},
    {attemptId:telegramId,needsEmail:false,needsConfirmation:false},
    {attemptId:telegramId,needsEmail:'true',needsConfirmation:false},
    {attemptId:telegramId,needsEmail:true},
    {attemptId:'b'.repeat(32),needsEmail:false,needsConfirmation:true},
  ]) {
    const client=createAccountClient({fetch:async()=>Response.json(body)});
    await assert.rejects(client.verifyTelegram(telegramId,'token'),clientInvalid);
  }
});

test('auth progress validates stages and paired code times without exposing extra fields', async () => {
  const base={id:telegramId,expiresAt:2_800_000,codeExpiresAt:0,resendAt:0};
  for(const stage of ['telegram','email','verified']) {
    const expected={...base,stage,canConfirm:stage==='verified'};
    const client=createAccountClient({fetch:async()=>Response.json({...expected,token:'private',email:'private'})});
    assert.deepEqual(await client.progress(telegramId),expected);
  }
  const code={...base,codeExpiresAt:1_600_000,resendAt:1_060_000};
  for(const stage of ['code','verified']) {
    const expected={...code,stage,canConfirm:false};
    const client=createAccountClient({fetch:async()=>Response.json(expected)});
    assert.deepEqual(await client.progress(telegramId),expected);
  }
  for(const body of [
    {...base,stage:'other',canConfirm:false}, {...base,stage:['email'],canConfirm:false},
    {...base,stage:'email',canConfirm:true}, {...base,stage:'email',canConfirm:'false'},
    {...base,stage:'code',canConfirm:false}, {...code,stage:'telegram',canConfirm:false},
    {...base,stage:'verified',canConfirm:true,codeExpiresAt:1},
    {...base,stage:'verified',canConfirm:true,resendAt:1},
    {...code,stage:'verified',canConfirm:true,codeExpiresAt:2_800_001},
    {...code,stage:'code',canConfirm:false,resendAt:-1},
    {...base,stage:'email',canConfirm:false,id:'b'.repeat(32)},
  ]) {
    const client=createAccountClient({fetch:async()=>Response.json(body)});
    await assert.rejects(client.progress(telegramId),clientInvalid);
  }
});

for(const method of ['start','verify','progress'] as const) {
  const call=(client:ReturnType<typeof createAccountClient>, signal?:AbortSignal)=>method==='start'
    ?client.startTelegram(undefined,signal):method==='verify'?client.verifyTelegram(telegramId,'token',signal):client.progress(telegramId,signal);
  const reply=()=>method==='start'?telegramStart:method==='verify'
    ?{attemptId:telegramId,needsEmail:false,needsConfirmation:true}
    :{id:telegramId,expiresAt:2_800_000,codeExpiresAt:0,resendAt:0,stage:'verified',canConfirm:true};
  test(`Telegram ${method} ignores late network and body replies after cancellation`,async()=>{
    for(const phase of ['network','body']) {
      let release!:()=>void, reached!:()=>void, calls=0;
      const held=new Promise<void>(resolve=>{release=resolve;}),ready=new Promise<void>(resolve=>{reached=resolve;});
      const client=createAccountClient({fetch:async()=>{
        calls++;const response=Response.json(reply());
        if(phase==='network'){reached();await held;}
        else Object.defineProperty(response,'json',{value:async()=>{reached();await held;return reply();}});
        return response;
      }});
      const controller=new AbortController(),pending=call(client,controller.signal);
      await ready;controller.abort();release();await assert.rejects(pending,{name:'AbortError'});
      assert.equal(calls,1);
      await assert.rejects(call(client,controller.signal),{name:'AbortError'});assert.equal(calls,1);
    }
  });
  test(`Telegram ${method} preserves failures without retrying`,async()=>{
    for(const failure of ['network','body','server']) {
      let calls=0;
      const client=createAccountClient({fetch:async()=>{
        calls++;if(failure==='network')throw new TypeError('Network failure');
        if(failure==='server')return Response.json({error:'telegram_unavailable',retryAt:3_000_000},{status:503});
        const response=Response.json(reply());Object.defineProperty(response,'json',{value:async()=>{throw new TypeError('Lost body');}});return response;
      }});
      await assert.rejects(call(client),error=>{
        assert.equal((error as {code:string}).code,failure==='server'?'telegram_unavailable':'connection_failed');
        if(failure==='server')assert.equal((error as {retryAt:number}).retryAt,3_000_000);return true;
      });assert.equal(calls,1);
    }
  });
}

test('the connected Telegram flow crosses real HTTP and SQLite, keeps one registration attempt, then signs in without another email',async t=>{
  const {createAccountSession}=await import('../src/state/account-session.ts');
  const {createAccountLogoutStore}=await import('../src/data/account-logout-store.ts');
  const {IDBFactory}=await import('fake-indexeddb');
  let shownNonce='',providerCalls=0;
  const f=server(t,{clientId:'123',async verify(token,context){
    assert.equal(token,'signed-provider-proof');assert.equal(context.nonce,shownNonce);providerCalls++;
    return {subject:'subject',userId:'12345678901234567890',username:null,expiresAt:99_000_000};
  }});
  const session=createAccountSession({client:f.client,connection:()=> 'online',logoutStore:createAccountLogoutStore({indexedDB:new IDBFactory()}),
    telegram:{reserve(){return {close(){},async authenticate(start){shownNonce=start.telegram.nonce;return 'signed-provider-proof';}};}}});
  t.after(()=>session.destroy());const flow=session.flow;
  await flow.telegram();assert.equal(flow.state.step,'email');assert.equal(flow.state.session,null);
  const original=flow.state.attempt!;f.advance(120000);flow.input('email','owner@example.test');await flow.submit();
  assert.equal(flow.state.attempt!.id,original.id);assert.equal(flow.state.attempt!.expiresAt,original.expiresAt);
  flow.input('code',f.messages.at(-1)!.code);await flow.submit();assert.equal(flow.state.screen,'linked');
  assert.equal(flow.state.identity!.telegramHandle,null);assert.equal(providerCalls,1);assert.equal(f.messages.length,1);
  await flow.logout();await flow.telegram();assert.equal(flow.state.screen,'linked');assert.equal(providerCalls,2);assert.equal(f.messages.length,1);
});

test('refreshing a verified Telegram link preserves the existing session and does not auto-confirm',async t=>{
  const {createAccountSession}=await import('../src/state/account-session.ts');
  const {createAccountLogoutStore}=await import('../src/data/account-logout-store.ts');
  const {IDBFactory}=await import('fake-indexeddb');
  const f=server(t,{clientId:'123',async verify(){return {subject:'subject',userId:'123',username:null,expiresAt:99_000_000};}});
  const email=await f.client.start('owner@example.test');await f.client.verify(email.id,f.messages[0].code);const before=await f.client.confirm(email.id);
  const started=await f.client.startTelegram();await f.client.verifyTelegram(started.attempt.id,'signed');
  const session=createAccountSession({client:f.client,connection:()=> 'online',logoutStore:createAccountLogoutStore({indexedDB:new IDBFactory()}),
    saved:{email:before.account.email,attemptEmail:'',attemptId:started.attempt.id,step:'telegram',verificationPending:true},
    telegram:{reserve(){return {close(){},async authenticate(){assert.fail('verified link must not request a fresh proof');}};}}});
  t.after(()=>session.destroy());f.calls.length=0;
  await session.refresh();assert.equal(session.flow.state.step,'telegram');assert.equal(session.flow.state.session!.id,before.session.id);
  assert.deepEqual(f.calls,['/api/account','/api/auth/attempt']);assert.equal(session.flow.state.screen,'unlinked');
  await session.flow.submit();assert.equal(session.flow.state.screen,'linked');assert.equal(session.flow.state.session!.id,started.attempt.id);
  assert.equal(f.calls.filter(path=>path==='/api/auth/confirm').length,1);
});


test('a real successful progress response for the old attempt cannot carry its private input into another account', async t => {
  const {createAccountSession}=await import('../src/state/account-session.ts');
  const {createAccountLogoutStore}=await import('../src/data/account-logout-store.ts');
  const {IDBFactory}=await import('fake-indexeddb');
  const f=server(t);
  const first=await f.client.start('first@example.test');
  await f.client.verify(first.id,f.messages.at(-1)!.code);await f.client.confirm(first.id);
  const session=createAccountSession({client:f.client,connection:()=> 'online',logoutStore:createAccountLogoutStore({indexedDB:new IDBFactory()})});
  t.after(()=>session.destroy());await session.refresh();
  const second=await f.client.start('second@example.test');
  await f.client.verify(second.id,f.messages.at(-1)!.code);
  let release!:()=>void, captured!:()=>void;
  const wait=new Promise<void>(resolve=>{release=resolve;}), entered=new Promise<void>(resolve=>{captured=resolve;});
  t.after(()=>release());
  // The other tab's request already captured its cookies before C existed.
  f.beforeHandle(async path=>{if(path==='/api/auth/confirm'){captured();await wait;}});
  const confirmation=f.client.confirm(second.id);await entered;
  await session.flow.begin();session.flow.input('email','private-draft@example.test');
  await session.flow.submit();session.flow.input('code','123456');
  const previous=session.flow.state.attempt!.id;
  release();const next=await confirmation;f.beforeHandle(null);
  assert.equal((await f.client.progress(previous)).stage,'code','the server really retains the former unfinished attempt');
  await session.receive({kind:'changed',id:next.session.id});
  assert.equal(session.flow.state.session?.id,next.session.id);
  assert.equal(session.flow.state.identity?.id,next.account.id);
  assert.equal(session.flow.state.attempt,null);
  assert.equal(session.flow.state.email,'second@example.test');
  assert.equal(session.flow.state.attemptEmail,'');
  assert.equal(session.flow.state.code,'');
  assert.equal(session.flow.snapshot,null);
});


test('account client carries only an origin proof matching the confirmed account and session',async()=>{
 const sessionId='a'.repeat(32),proof=`v1.17.${sessionId}.${'A'.repeat(43)}`;
 const value={account:{id:'17',email:'proof@example.test',telegramLinked:false,telegramHandle:null},session:{id:sessionId,expiresAt:1000,diagnosticProof:proof}};
 const client=createAccountClient({fetch:async()=>Response.json(value)});
 assert.equal((await client.current())?.session.diagnosticProof,proof);
 for(const bad of ['bad',proof.replace('v1.17.','v1.18.'),proof.replace(sessionId,'b'.repeat(32))]) {
  value.session.diagnosticProof=bad;await assert.rejects(client.current(),{code:'invalid_response'});
 }
});


test('a real signed report survives browser reopen and expired login without borrowing current cookies',async t=>{
 const {IDBFactory}=await import('fake-indexeddb');
 const {createJournal}=await import('../src/journal.ts');
 const {createDiagnosticClient}=await import('../src/data/diagnostic-client.ts');
 const {createDiagnosticHandler}=await import('../server/http/diagnostics.ts');
 const {ACCOUNT_POLICY}=await import('../server/services/account-policy.ts');
 const f=server(t),attempt=await f.client.start('owner@example.test');
 await f.client.verify(attempt.id,f.messages[0]!.code);const confirmed=await f.client.confirm(attempt.id);
 const indexedDB=new IDBFactory(),options={indexedDB,appVersion:'test-proof',environment:'production' as const};
 const before=createJournal({...options,accountId:confirmed.account.id,sessionId:confirmed.session.id,
  diagnosticProof:confirmed.session.diagnosticProof,connection:()=> 'offline'});
 const logged=await before.begin({action:'calculate',component:'calculator'}).reportFailure({stage:'request',reason:'connection_failed'});
 assert.equal(logged?.queued,true);await before.close();
 f.advance(ACCOUNT_POLICY.sessionMs+1);f.accounts.cleanup();assert.equal(await f.client.current(),null);
 const written:unknown[]=[];
 const handle=createDiagnosticHandler({accounts:f.accounts,origins:['https://forma.example.test'],write:async report=>{
  written.push(report);return {status:'accepted',receivedAt:100,duplicate:false};}});
 const transport=createDiagnosticClient({fetch:async(input,init)=>{
  const url=new URL(String(input),'https://forma.example.test');
  const request=Object.assign(Readable.from([Buffer.from(String(init!.body))]),{
   method:init!.method,url:url.pathname,headers:{...Object.fromEntries(new Headers(init!.headers)),host:url.host,origin:url.origin},
   socket:{remoteAddress:'192.0.2.1'}}) as unknown as IncomingMessage;
  const response=captureResponse();await handle(request,response);
  return new Response(response.body,{status:response.status,headers:{'content-type':'application/json'}});
 }});
 const reopened=createJournal({...options,send:transport});t.after(()=>reopened.close());
 await reopened.wake();
 assert.equal(written.length,1);assert.deepEqual(written[0],{...logged!.report,deliveryIp:'192.0.2.1'});
 assert.equal(JSON.stringify(written).includes(confirmed.session.diagnosticProof!),false);
 assert.equal(await f.client.current(),null);
});
