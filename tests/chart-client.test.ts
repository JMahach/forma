import { createCalculationReceipts } from '../server/services/calculation-receipt.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import type { IncomingMessage } from 'node:http';
import { captureResponse } from './helpers/http-response.ts';
import { openDatabase } from '../server/storage/database.ts';
import { createAccounts, type AccountCredentials } from '../server/services/accounts.ts';
import type { CodeMail } from '../server/mail/code-mail.ts';
import { createChartRecords } from '../server/services/chart-records.ts';
import { createChartHandler } from '../server/http/charts.ts';
import { createChartCalculation } from '../server/services/chart-calculation.ts';
import { createCityCatalog } from '../server/services/cities.ts';
import { createChartClient } from '../src/data/chart-client.ts';
import { IDBFactory } from 'fake-indexeddb';
import { createAccountLibraryStore } from '../src/data/account-library-store.ts';
import { createAccountLibrary } from '../src/state/account-library.ts';
import { createChartActions } from '../src/state/chart-actions.ts';

const op = (n: number) => n.toString(16).padStart(32, '0');
const utc = '2000-01-01T12:00:32.789Z';
const planets = ['sun','earth','moon','north_node','south_node','mercury','venus','mars','jupiter','saturn','uranus','neptune','pluto'];
async function fixture(t: {after(fn: () => void): void}) {
  const database = openDatabase(':memory:'); t.after(() => database.close());
  let time = 1_000_000;
  const mail: CodeMail[] = [];
  const accounts = createAccounts({database, key: Buffer.alloc(32, 3), now: () => time,
    mail: {async enqueue(value) { mail.push(value); }, async cancel() {}}});
  async function login(email: string) {
    const proof: AccountCredentials = {bindings: {}, sessions: {}};
    const start = await accounts.start({email, ip: '192.0.2.1', credentials: proof});
    proof.bindings[start.attempt.id] = start.binding.secret;
    const grant = accounts.verify(start.attempt.id, mail.at(-1)!.code, proof);
    proof.sessions[start.attempt.id] = grant.secret;
    const confirmed = accounts.confirm(start.attempt.id, proof);
    return {proof, accountId: confirmed.account.id, sessionId: confirmed.session.id};
  }
  const first = await login('first@example.test');
  let current: typeof first | null = first;
  const records = createChartRecords({database, authorize: () => null, now: () => time});
  const side = planets.map((planet, i) => ({planet, longitude: i * 20, gate: i + 1, line: 1}));
  const cities = createCityCatalog([{id: '1', name: 'Test City', aliases: [], country: 'Test',
    region: '', timezone: 'UTC', latitude: 0, longitude: 0}]);
  let preparations = 0, calculationReceipt='';
  const receipts=()=>createCalculationReceipts({key:Buffer.alloc(32,9)});
  const prepare = () => createChartCalculation({cities, receipts:receipts(), calculate: async input => {
    preparations++;
    const result={chart: {id: null, name: '', note: '', createdAt: '', updatedAt: '',
      source: input.mode === 'transit' ? 'transit' as const : 'calculated' as const,
      birthDate: input.date ?? input.utc!.slice(0, 10), birthTime: input.time ?? input.utc!.slice(11, 16),
      birthPlace: input.city?.name ?? '', utc: input.utc ?? '2000-01-01T12:00:00Z',
      timezone: 'UTC', utcOffset: 'UTC+00:00', fold: 0, designUtc: '1999-10-10T01:00:00Z',
      designArcResidualDegrees: 1e-9, personality: side.map(a => a.gate), design: side.map(a => a.gate),
      activations: {personality: side, design: side}, engine: 'test', ephemeris: 'test',
      timezoneDatabase: 'test', nodeModel: 'true', zodiac: 'test', verification: 'test'},
      timeResolution: {ambiguous: false}};
    calculationReceipt=receipts().issue(input,result)!;return result;
  }});
  const calls: {path: string; options: RequestInit}[] = [];
  let alter = async (response: Response) => response;
  const send: typeof fetch = async (input, options = {}) => {
    const path = String(input); calls.push({path, options});
    const req = Object.assign(Readable.from(options.body ? [Buffer.from(String(options.body))] : []), {
      method: options.method ?? 'GET', url: path,
      headers: {host: 'forma.example.test', origin: 'https://forma.example.test', 'content-type': 'application/json',
        cookie: Object.entries(current?.proof.sessions ?? {}).map(([id, token]) => `__Host-forma_s_${id}=${token}`).join('; ')},
      socket: {remoteAddress: '192.0.2.1'},
    }) as unknown as IncomingMessage;
    const res = captureResponse();
    const handler = createChartHandler({records, accounts, origins: ['https://forma.example.test'], now: () => time,
      prepareBirth: prepare()});
    await handler(req, res, new URL(path, 'https://forma.example.test'));
    return alter(new Response(res.body, {status: res.status, headers: {'Content-Type': 'application/json'}}));
  };
  const getSession = () => current && {accountId: current.accountId, sessionId: current.sessionId};
  const client = createChartClient({fetch: send, getSession});
  const intent = (n = 1) => ({operationId: op(n), expectedAccountId: current!.accountId});
  const create = (n = 1, name = 'Транзит') => client.create({...intent(n), name, note: 'private',
    birth: {source: 'transit', utc}});
  return {client, send, getSession, create, intent, calls, first, login,
    switchAccount(value: typeof first | null) { current = value; },
    advance(ms: number) { time += ms; },
    preparations: () => preparations, calculationReceipt:()=>calculationReceipt,
    alter(fn: typeof alter) { alter = fn; }};
}

test('create receipt is separate from the current private and public chart', async t => {
  const f = await fixture(t), receipt = await f.create();
  assert.ok(receipt, 'a command must return its account-bound receipt');
  assert.equal(receipt.outcome.kind, 'created');
  assert.equal(receipt.expectedAccountId, f.first.accountId);
  assert.equal(receipt.operationId, op(1));
  assert.equal(receipt.chart?.id, receipt.outcome.chartId);
  const chartId = receipt.outcome.chartId;
  const {chart:own} = await f.client.own({chartId, expectedAccountId: f.first.accountId});
  assert.equal(own.note, 'private');
  assert.equal(own.utc, '2000-01-01T12:00:32.789Z');
  assert.equal(own.activations.design.length, 13);
  const shared = await f.client.public(chartId);
  assert.equal(shared.id, chartId);
  for (const key of ['note', 'accountId', 'noteRevision', 'publicRevision']) assert.equal(key in shared, false);
  assert.equal(f.calls.filter(c => c.options.method === 'POST').length, 1);
});

test('note compare-and-set preserves newer name and does not overwrite an unseen note', async t => {
  const f = await fixture(t), {outcome: created} = await f.create(), chartId = created.chartId;
  await f.client.update({...f.intent(2), chartId, name: 'Новое имя'});
  const saved = await f.client.update({...f.intent(3), chartId, note: {value: 'new note', seenRevision: 1}});
  assert.equal(saved.outcome.kind, 'updated');
  const conflict = await f.client.update({...f.intent(4), chartId, note: {value: 'old draft', seenRevision: 1}});
  assert.equal(conflict.outcome.kind, 'rejected');
  assert.equal(conflict.outcome.code, 'note_conflict');
  const {chart:own} = await f.client.own({chartId, expectedAccountId: f.first.accountId});
  assert.equal(own.name, 'Новое имя'); assert.equal(own.note, 'new note');
  assert.equal(own.utc, utc); assert.equal(f.preparations(), 1);
});

test('copy reads the seen public revision and never carries a private note', async t => {
  const f = await fixture(t), source = (await f.create()).outcome.chartId;
  const seen = await f.client.public(source);
  f.switchAccount(await f.login('second@example.test'));
  const copy = await f.client.addFromSource({...f.intent(2), sourceId: source, seenRevision: seen.revision});
  assert.equal(copy.outcome.kind, 'created');
  const {chart:own} = await f.client.own({chartId: copy.outcome.chartId, expectedAccountId: copy.expectedAccountId});
  assert.equal(own.note, ''); assert.notEqual(own.id, source);
  assert.deepEqual(JSON.parse(String(f.calls.find(c => c.path === '/api/charts/add')!.options.body)),
    {...f.intent(2), sourceId: source, seenRevision: 1});
});

test('delete and expired outcome never turn a receipt into a present chart or repeat a write', async t => {
  const f = await fixture(t), created = await f.create(), chartId = created.outcome.chartId;
  assert.equal((await f.client.remove({...f.intent(2), chartId})).outcome.kind, 'deleted');
  const recovered = await f.client.outcome(f.intent(1));
  assert.deepEqual(recovered.outcome, created.outcome);
  assert.equal(recovered.chart, undefined);
  await assert.rejects(f.client.own({chartId, expectedAccountId: f.first.accountId}), {code: 'not_found', status: 404});
  f.advance(48 * 60 * 60 * 1000);
  assert.deepEqual((await f.client.outcome(f.intent(1))).outcome, {kind: 'unknown'});
  assert.equal(f.calls.filter(c => c.options.method !== 'GET').length, 2);
});

test('write replies join the real HTTP, client and library with only a necessary fallback read', async t => {
  for (const projection of ['current', 'missing', 'foreign', 'older', 'malformed']) {
    const f = await fixture(t), storage = createAccountLibraryStore({indexedDB:new IDBFactory()});
    const library = createAccountLibrary({client:f.client,storage,online:()=>true});
    t.after(()=>library.close()); await library.connect(f.getSession());
    let puts=0, updates=0;
    const put=storage.put; storage.put=(...args)=>{puts++;return put(...args);};
    library.subscribe(()=>{updates++;}); updates=0;
    f.alter(async response=>{
      const value=await response.json();
      if(value.kind==='created') {
        if(projection==='missing')delete value.chart;
        if(projection==='foreign' && value.chart)value.chart.accountId='999';
        if(projection==='older')value.revision=2;
        if(projection==='malformed' && value.chart)value.chart.activations.design.pop();
      }
      return Response.json(value,{status:response.status});
    });
    const actions=createChartActions({client:f.client,library,getSession:f.getSession,newId:()=>op(1),
      calculate:async()=>{throw new Error('server owns this calculation');}});
    const result=await actions.create({name:'A',note:'',birth:{source:'transit',utc}});
    assert.equal(result.kind,'settled'); assert.equal(result.chart?.utc,utc);
    assert.equal('chart' in result.receipt,false,'the immutable receipt does not contain its current projection');
    assert.equal(f.calls.filter(call=>call.options.method==='POST').length,1);
    assert.equal(f.calls.filter(call=>call.options.method==='GET').length,projection==='current'?0:1,projection);
    assert.equal(f.preparations(),1); assert.equal(puts,1); assert.equal(updates,1);
    assert.equal((await storage.read())!.charts.length,1);
  }
});

test('outcome recovery returns the current projection without rewriting the historical fact', async t=>{
  const f=await fixture(t), created=await f.create(), chartId=created.outcome.chartId;
  await f.client.update({...f.intent(2),chartId,name:'Later name'});
  const reply=await f.client.outcome(f.intent(1));
  assert.deepEqual(reply.outcome,created.outcome);
  assert.equal(reply.chart?.revision,2); assert.equal(reply.chart?.name,'Later name');
  assert.equal(f.preparations(),1);
});

test('a delayed write projection cannot undo a confirmed local or peer deletion', async t=>{
  for(const peer of [false,true]) {
    const f=await fixture(t), indexedDB=new IDBFactory();
    const storage=createAccountLibraryStore({indexedDB}), other=createAccountLibraryStore({indexedDB});
    const library=createAccountLibrary({client:f.client,storage,online:()=>true});
    t.after(()=>{library.close();other.close();}); await library.connect(f.getSession());
    const actions=createChartActions({client:f.client,library,getSession:f.getSession,newId:()=>op(1),
      calculate:async()=>{throw new Error('unused');}});
    f.alter(async response=>{
      const value=await response.clone().json();
      if(value.kind==='created') {
        await f.client.remove({...f.intent(2),chartId:value.chartId});
        if(peer){const snapshot=await other.read();await other.remove(snapshot!.lease!,value.chartId);}
        else await library.forget(value.chartId);
      }
      return response;
    });
    const result=await actions.create({name:'A',note:'',birth:{source:'transit',utc}});
    assert.equal(result.kind,'settled'); assert.equal(result.receipt.outcome.kind,'created');
    assert.equal(result.chart,null); assert.deepEqual(library.charts,[]);
    assert.deepEqual((await storage.read())!.charts,[]);
  }
});

test('a lost response is recovered by a separate read, with no automatic repeated save', async t => {
  const f = await fixture(t);
  f.alter(async () => { throw new TypeError('connection lost after commit'); });
  await assert.rejects(f.create(), {code: 'connection_failed'});
  assert.equal(f.calls.length, 1);
  f.alter(async response => response);
  const receipt = await f.client.outcome(f.intent());
  assert.equal(receipt.outcome.kind, 'created');
  const page = await f.client.list({expectedAccountId: f.first.accountId});
  assert.equal(page.charts.length, 1);
  assert.equal(f.calls.filter(c => c.options.method === 'POST').length, 1);
});

test('pages preserve account and cursor and all ready records remain readable without recalculation', async t => {
  const f = await fixture(t);
  await f.create(1, 'A'); await f.create(2, 'B'); await f.create(3, 'C');
  const first = await f.client.list({expectedAccountId: f.first.accountId, limit: 2});
  assert.equal(first.charts.length, 2); assert.ok(first.nextCursor);
  assert.equal(Object.hasOwn(first,'calculationVersion'),false);
  assert.ok(first.charts.every(chart => !Object.hasOwn(chart,'calculationCurrent')));
  const last = await f.client.list({expectedAccountId: f.first.accountId, after: first.nextCursor, limit: 2});
  assert.equal(last.charts.length, 1); assert.equal(last.nextCursor, null);
  assert.equal(new Set([...first.charts, ...last.charts].map(c => c.id)).size, 3);
  assert.equal(f.preparations(), 3);
  const {chart:opened} = await f.client.own({chartId: first.charts[0]!.id, expectedAccountId: f.first.accountId});
  assert.deepEqual(opened,first.charts[0]); assert.equal(f.preparations(),3);
});

test('late private reads cannot return after logout, account change or a new session of the same account', async t => {
  for (const transition of ['logout', 'account', 'session']) {
    const f = await fixture(t), chartId = (await f.create()).outcome.chartId;
    f.alter(async response => {
      // The headers are already available; the account changes while the body is read.
      const json = response.json.bind(response);
      response.json = async () => {
        const value = await json();
        f.switchAccount(transition === 'logout' ? null : {...f.first,
          ...(transition === 'account' ? {accountId: '999'} : {sessionId: op(77)})});
        return value;
      };
      return response;
    });
    await assert.rejects(f.client.own({chartId, expectedAccountId: f.first.accountId}), {code: 'account_changed'});
  }
});

test('a confirmed late command keeps its account-bound outcome but grants no chart data', async t => {
  const f = await fixture(t);
  f.alter(async response => { f.switchAccount(null); return response; });
  const receipt = await f.create();
  assert.equal(receipt.outcome.kind, 'created'); assert.equal(receipt.expectedAccountId, f.first.accountId);
  assert.equal('chart' in receipt, false);
  const count = f.calls.length;
  await assert.rejects(f.client.own({chartId: receipt.outcome.chartId, expectedAccountId: f.first.accountId}),
    {code: 'account_changed'});
  assert.equal(f.calls.length, count);
});

test('source projection cannot transmit computed data, and required account identity is never inferred', async t => {
  const f = await fixture(t);
  const input = {...f.intent(), name: 'Natal', note: '', activations: 'untrusted',
    birth: {source: 'calculated' as const, date: '2000-01-01', time: '12:00', cityId: '1',
      cityName: 'Test City', fold: 0 as const, activations: 'untrusted', timezone: 'Other'}};
  const receipt = await f.client.create(input);
  assert.equal(receipt.outcome.kind, 'created');
  assert.deepEqual(JSON.parse(String(f.calls[0]!.options.body)).birth,
    {source: 'calculated', date: '2000-01-01', time: '12:00', cityId: '1', cityName: 'Test City', fold: 0});
  assert.equal('activations' in JSON.parse(String(f.calls[0]!.options.body)), false);
  const count = f.calls.length;
  await assert.rejects(f.client.create({...input, expectedAccountId: undefined as unknown as string}), {code: 'invalid_request'});
  await assert.rejects(f.client.list({expectedAccountId: '999'}), {code: 'account_changed'});
  assert.equal(f.calls.length, count);
});

test('malformed payloads and foreign private rows are rejected before reaching state', async t => {
  const f = await fixture(t), chartId = (await f.create()).outcome.chartId;
  for (const mutate of [
    (v: any) => { v.chart.accountId = '999'; },
    (v: any) => { v.chart.id = op(99); },
    (v: any) => { v.chart.revision = 0; },
    (v: any) => { v.chart.noteRevision = v.chart.revision + 1; },
    (v: any) => { v.chart.activations.design.pop(); },
    (v: any) => { v.chart.personality = [64]; },
    (v: any) => { v.chart.utc = '2000-02-30T12:00:00Z'; },
    (v: any) => { v.chart.designUtc = v.chart.utc; },
  ]) {
    f.alter(async response => { const v = await response.json(); mutate(v); return Response.json(v); });
    await assert.rejects(f.client.own({chartId, expectedAccountId: f.first.accountId}), {code: 'invalid_response'});
  }
  for (const mutate of [
    (v: any) => { v.nextCursor = op(98); },
    (v: any) => { v.charts.push(v.charts[0]); },
  ]) {
    f.alter(async response => { const v = await response.json(); mutate(v); return Response.json(v); });
    await assert.rejects(f.client.list({expectedAccountId: f.first.accountId}), {code: 'invalid_response'});
  }
  f.alter(async response => { const v = await response.json(); v.chart.note = 'private leak'; return Response.json(v); });
  await assert.rejects(f.client.public(chartId), {code: 'invalid_response'});
});

test('the HTTP reason, status and ambiguity choices survive independently of visible wording', async t => {
  const f = await fixture(t);
  const choices = [{fold: 0, utc: '2000-01-01T12:00:00Z', label: 'UTC+00:00'},
    {fold: 1, utc: '2000-01-01T13:00:00Z', label: 'UTC−01:00'}];
  f.alter(async () => Response.json({error: 'ambiguous_time', message: 'Choose offset', choices}, {status: 422}));
  await assert.rejects(f.create(), error => {
    assert.equal((error as any).code, 'ambiguous_time'); assert.equal((error as any).status, 422);
    assert.deepEqual((error as any).choices, choices); return true;
  });
  f.alter(async () => new Response('Unavailable', {status: 503}));
  await assert.rejects(f.client.list({expectedAccountId: f.first.accountId}), {code: 'server_error', status: 503});
});

test('cancellation before sending or during body read prevents publishing and never retries', async t => {
  const f = await fixture(t), stopped = new AbortController(); stopped.abort();
  await assert.rejects(f.client.create({...f.intent(), name: 'A', note: '', birth: {source: 'transit', utc}}, stopped.signal),
    {name: 'AbortError'});
  assert.equal(f.calls.length, 0);
  const controller = new AbortController();
  f.alter(async response => {
    const json = response.json.bind(response);
    response.json = async () => { const value = await json(); controller.abort(); return value; };
    return response;
  });
  await assert.rejects(f.client.create({...f.intent(), name: 'A', note: '', birth: {source: 'transit', utc}}, controller.signal),
    {name: 'AbortError'});
  assert.equal(f.calls.length, 1);
});

test('client obeys its injected connection gate before sending a command', async t => {
  const {createHttpTransport} = await import('../src/data/http-transport.ts');
  const f = await fixture(t);
  const send=createHttpTransport({connection:{current: 'offline', subscribe: () => () => {}}, fetch:f.send});
  const client = createChartClient({getSession: f.getSession,fetch:send});
  await assert.rejects(client.create({...f.intent(), name: 'A', note: '', birth: {source: 'transit', utc}}), {code: 'offline'});
  assert.equal(f.calls.length, 0);
});

test('a changed public source is refused and copying never becomes a silent second action', async t => {
  const f = await fixture(t), chartId = (await f.create()).outcome.chartId;
  const seen = await f.client.public(chartId);
  await f.client.update({...f.intent(2), chartId, name: 'Changed'});
  f.switchAccount(await f.login('second@example.test'));
  const result = await f.client.addFromSource({...f.intent(3), sourceId: chartId, seenRevision: seen.revision});
  assert.equal(result.outcome.kind, 'rejected'); assert.equal(result.outcome.code, 'source_changed');
  assert.equal((await f.client.list({expectedAccountId: result.expectedAccountId})).charts.length, 0);
  assert.equal(f.calls.filter(c => c.path === '/api/charts/add').length, 1);
});

test('malformed command receipts never imply a completed save', async t => {
  const f = await fixture(t);
  for (const value of [
    {kind: 'created', chartId: op(88), revision: 0},
    {kind: 'created', chartId: 'not-an-id', revision: 1},
    {kind: 'rejected', chartId: op(88), code: 'unexpected'},
    {kind: 'rejected', chartId: op(88), code: ['note_conflict']},
    {kind: 'unknown'},
  ]) {
    f.alter(async () => Response.json(value));
    await assert.rejects(f.create(), {code: 'invalid_response'});
  }
  assert.equal(f.calls.length, 5);
});

test('late list and outcome reads also reject a retired session', async t => {
  for (const operation of ['list', 'outcome']) {
    const f = await fixture(t); await f.create();
    f.alter(async response => { f.switchAccount(null); return response; });
    const read = operation === 'list' ? f.client.list({expectedAccountId: f.first.accountId})
      : f.client.outcome({operationId: op(1), expectedAccountId: f.first.accountId});
    await assert.rejects(read, {code: 'account_changed'});
  }
});

test('a late private refusal cannot revoke the next session, while a current refusal keeps its HTTP cause', async t => {
  for (const operation of ['own', 'list', 'outcome']) {
    const f = await fixture(t), chartId = (await f.create()).outcome.chartId;
    const read = () => operation === 'own' ? f.client.own({chartId, expectedAccountId: f.first.accountId})
      : operation === 'list' ? f.client.list({expectedAccountId: f.first.accountId})
      : f.client.outcome({operationId: op(1), expectedAccountId: f.first.accountId});
    f.alter(async () => Response.json({error: 'auth_required'}, {status: 401}));
    await assert.rejects(read(), {code: 'auth_required', status: 401});
    f.alter(async () => {
      f.switchAccount({...f.first, accountId: '999', sessionId: op(99)});
      return Response.json({error: 'auth_required'}, {status: 401});
    });
    await assert.rejects(read(), {code: 'account_changed'});
  }
});


test('client and HTTP save a signed ready chart without recalculation or persisting its proof',async t=>{
  const f=await fixture(t);await f.create();const proof=f.calculationReceipt();assert.ok(proof);
  const result=await f.client.create({...f.intent(50),name:'Another name',note:'Own note',
    birth:{source:'transit',utc},calculationReceipt:proof});
  assert.equal(result.outcome.kind,'created');assert.equal(f.preparations(),1);
  assert.equal(JSON.parse(String(f.calls.at(-1)!.options.body)).calculationReceipt,proof);
  const {chart}=await f.client.own({chartId:result.outcome.chartId,expectedAccountId:f.first.accountId});
  assert.equal(chart.name,'Another name');assert.equal(chart.note,'Own note');
  assert.equal(Object.hasOwn(chart,'calculationReceipt'),false);
  await assert.rejects(f.client.create({...f.intent(51),name:'Tampered',note:'',
    birth:{source:'transit',utc},calculationReceipt:proof+'x'}),{code:'invalid_request'});
  assert.equal(f.preparations(),1);
});
test('catalog HTTP failures retain Retry-After for the shared background budget',async()=>{
 const client=createChartClient({getSession:()=>({accountId:'1',sessionId:'s'}),fetch:async()=>new Response('{"error":"busy"}',{status:429,headers:{'Retry-After':'120'}})});
 await assert.rejects(client.catalog({expectedAccountId:'1'}),error=>(error as {retryAfterMs?:number}).retryAfterMs===120000);
});
