import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import http, { type IncomingMessage } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Readable } from 'node:stream';
import { createAccountRuntime } from '../server/accounts.ts';
import {fileURLToPath} from 'node:url';
import {createCalculator} from '../server/services/calculate.ts';
import type {AccountChart} from '../shared/chart-record-contract.ts';
import { createCityCatalog } from '../server/services/cities.ts';
import { openDatabase } from '../server/storage/database.ts';
import { captureResponse } from './helpers/http-response.ts';
import type { PostfixEntry } from '../server/mail/postfix.ts';

// Both protocol endpoints live only inside this test; no public SMTP or DNS is contacted.
test('local SMTP code leads to login, saved chart, public link and persistent library after restart', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'forma-smtp-test-'));
  const socketPath = path.join(directory, 'control.sock'), connections = new Set<net.Socket>();
  const entries: PostfixEntry[] = [], jar = new Map<string, string>();
  let code = '', submissions = 0, deliveries = 0, clock = Date.now();
  const cleanups: (() => void)[] = [], events: string[] = [];
  const interval = globalThis.setInterval;
  t.mock.method(globalThis, 'setInterval', (callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => {
    if (delay === 300_000) cleanups.push(() => callback(...args));
    return interval(callback, delay, ...args);
  });
  const envelopes: string[] = [];
  const smtp = net.createServer(socket => {
    connections.add(socket); socket.on('close', () => connections.delete(socket));
    socket.write('220 local.test ESMTP\r\n'); socket.setEncoding('utf8');
    let pending = '', data = false;
    socket.on('data', (chunk: string) => {
      pending += chunk;
      while (pending.includes(data ? '\r\n.\r\n' : '\r\n')) {
        const ending = data ? '\r\n.\r\n' : '\r\n', index = pending.indexOf(ending);
        const line = pending.slice(0, index); pending = pending.slice(index + ending.length);
        if (data) {
          data = false; submissions++;
          const id = /^X-Forma-Code-Id: (\w+)$/im.exec(line)![1]!;
          const contextId = /^X-Forma-Context-Id: (\w+)$/im.exec(line)![1]!;
          const discardAt = Number(/^X-Forma-Discard-At: (\d+)$/im.exec(line)![1]);
          const body = Buffer.from(line.slice(line.indexOf('\r\n\r\n') + 4), 'base64').toString();
          code = /Ваш код: (\d{6})/.exec(body)![1]!;
          entries.push({ queueId: 'TestQueue1', codeId: id, contextId, discardAt,
            arrivedAt: Date.now(), state: 'hold', messageBytes: Buffer.byteLength(line) });
          socket.write('250 2.0.0 Ok: queued as TestQueue1\r\n');
        } else if (line.startsWith('EHLO')) socket.write('250-local.test\r\n250-DSN\r\n250 PIPELINING\r\n');
        else if (line.startsWith('MAIL FROM:') || line.startsWith('RCPT TO:')) { envelopes.push(line); socket.write('250 Ok\r\n'); }
        else if (line === 'DATA') { data = true; socket.write('354 End with dot\r\n'); }
        else if (line === 'QUIT') socket.end('221 Bye\r\n');
        else socket.write('250 Ok\r\n');
      }
    });
  });
  const control = http.createServer(async (req, res) => {
    const parts: Buffer[] = []; for await (const part of req) parts.push(Buffer.from(part));
    const action = JSON.parse(Buffer.concat(parts).toString()) as { action: string; codeId?: string; queueId?: string };
    if (action.action === 'send') { assert.equal(action.queueId, 'TestQueue1'); deliveries++; }
    if (action.action === 'delete') {
      const index = entries.findIndex(entry => entry.queueId === action.queueId && entry.codeId === action.codeId);
      if (index >= 0) entries.splice(index, 1);
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(action.action === 'list' ? { entries } : { accepted: true }));
  });
  t.after(async () => {
    for (const socket of connections) socket.destroy();
    await Promise.all([new Promise<void>(resolve => smtp.close(() => resolve())), new Promise<void>(resolve => control.close(() => resolve()))]);
    await rm(directory, { recursive: true, force: true });
  });
  smtp.listen(0, '127.0.0.1'); await once(smtp, 'listening');
  control.listen(socketPath); await once(control, 'listening');
  const configuration = { stateDir: path.join(directory, 'state'), origins: ['http://localhost:3636'],
    trustLoopbackProxy: false, postfix: { controlSocket: socketPath, smtpPort: (smtp.address() as net.AddressInfo).port } };
  const calculate=createCalculator({root:fileURLToPath(new URL('../',import.meta.url))});
  t.after(()=>calculate.close());
  const charts = { cities: createCityCatalog([{id:'1',name:'Test City',aliases:['Test City'],country:'Test',region:'',
    timezone:'UTC',latitude:0,longitude:0}]), calculationVersion: 'runtime-test', calculate };
  const runtimeOptions = { configuration, charts, now: () => clock, report: (event: { event: string }) => { events.push(event.event); } };
  let runtime = await createAccountRuntime(runtimeOptions);
  t.after(() => runtime.close());
  async function request(url: string, body?: unknown, guest=false) {
    const req = Object.assign(Readable.from(body ? [Buffer.from(JSON.stringify(body))] : []), {
      method: body ? 'POST' : 'GET', headers: { host: 'localhost:3636', origin: 'http://localhost:3636',
        cookie: guest ? '' : [...jar].map(([key, value]) => `${key}=${value}`).join('; '), 'content-type': 'application/json' },
      socket: { remoteAddress: '127.0.0.1' },
    }) as unknown as IncomingMessage;
    const res = captureResponse(); await ((url.startsWith('/api/charts') || url.startsWith('/api/shared-charts')) ? runtime.chartHandler! : runtime.handler)(req, res, new URL(url, 'http://localhost:3636'));
    for (const header of (res.headers['Set-Cookie'] ?? []) as string[]) {
      const pair = header.split(';')[0]!, at = pair.indexOf('='), name = pair.slice(0, at);
      if (header.includes('Max-Age=0;') || header.endsWith('Max-Age=0')) jar.delete(name);
      else jar.set(name, pair.slice(at + 1));
    }
    return { status: res.status, body: JSON.parse(res.body) as Record<string, unknown> };
  }
  const start = await request('/api/auth/email/start', { email: 'person@example.invalid' });
  assert.equal(start.status, 200); assert.equal(start.body.delivery, 'queued');
  assert.equal(submissions, 1); assert.equal(deliveries, 1);
  assert.match(envelopes[0]!, /^MAIL FROM:<forma@juxtaposition\.ru> RET=HDRS ENVID=[a-f0-9]{32}$/);
  assert.match(envelopes[1]!, /NOTIFY=SUCCESS,FAILURE$/);
  const attemptId = (start.body.attempt as { id: string }).id;
  assert.equal((await request('/api/auth/email/verify', { attemptId, code })).status, 200);
  const confirmed = await request('/api/auth/confirm', { attemptId }); assert.equal(confirmed.status, 200);
  const accountId = (confirmed.body.account as { id: string }).id;
  const library = await request('/api/charts?accountId=' + accountId);
  assert.equal(library.status, 200); assert.deepEqual(library.body.charts, []);
  const saved=await request('/api/charts',{operationId:'a'.repeat(32),expectedAccountId:accountId,
    name:'Local mail acceptance',note:'Private note',birth:{source:'calculated',date:'2000-01-01',time:'12:00',cityId:'1'}});
  assert.equal(saved.status,200,JSON.stringify(saved.body));
  const chartId=saved.body.chartId as string;
  const own=await request(`/api/charts/${chartId}?accountId=${accountId}`);
  assert.equal(own.status,200);assert.equal((own.body.chart as AccountChart).note,'Private note');
  assert.equal((own.body.chart as AccountChart).activations.personality.length,13);
  assert.equal((own.body.chart as AccountChart).activations.design.length,13);
  const shared=await request(`/api/shared-charts/${chartId}`,undefined,true);
  assert.equal(shared.status,200);assert.equal((shared.body.chart as AccountChart).name,'Local mail acceptance');
  assert.equal('note' in (shared.body.chart as object),false);assert.equal('accountId' in (shared.body.chart as object),false);
  assert.equal((await request(`/api/charts?accountId=${accountId}`,undefined,true)).status,401);
  assert.equal(cleanups.length, 1, 'Charts reuse the account cleanup timer');
  const database = openDatabase(path.join(configuration.stateDir, 'forma.sqlite'));
  try {
    database.connection.prepare('INSERT INTO chart_operation_outcomes VALUES (?,?,?,?)')
      .run(accountId, 'c'.repeat(32), clock, JSON.stringify({ kind: 'deleted', chartId: 'd'.repeat(32) }));
    assert.equal((await request('/api/charts/operations/' + 'c'.repeat(32) + '?accountId=' + accountId)).body.kind, 'deleted');
    clock += 48 * 60 * 60 * 1000;
    const broken = t.mock.method(runtime.accounts, 'cleanup', () => { throw new Error('Temporary account cleanup failure'); });
    cleanups[0]!(); broken.mock.restore();
    assert.equal(database.connection.prepare('SELECT count(*) AS count FROM chart_operation_outcomes').get()!.count, 0);
    assert.equal(events.includes('account_cleanup_failed'), true);
  } finally { database.close(); }
  await runtime.close(); runtime = await createAccountRuntime(runtimeOptions);
  const resumed = await request('/api/account'); assert.equal(resumed.status, 200);
  assert.deepEqual(resumed.body.account, confirmed.body.account);
  const restored=await request(`/api/charts?accountId=${accountId}`);
  assert.equal(restored.status,200);assert.deepEqual((restored.body.charts as AccountChart[]).map(chart=>chart.id),[chartId]);
  assert.deepEqual((await request(`/api/charts/${chartId}?accountId=${accountId}`)).body.chart,own.body.chart);
  assert.equal((await request('/api/auth/logout', { sessionId: attemptId })).status, 200);
  assert.equal((await request('/api/account')).body.account, null);
  assert.equal(submissions, 1, 'Restart and logout never resubmit an SMTP message');
});
