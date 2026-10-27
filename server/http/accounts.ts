import { reportServerFailure, type ServerFailureReport } from '../journal/report.ts';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { isIP } from 'node:net';
import { AccountError, type Accounts, type AccountCredentials } from '../services/accounts.ts';
import { HttpInputError, readJSONObject, sendJSON } from './json.ts';
import { requestSignal } from './request-signal.ts';
import { createAccountSecurity } from './account-security.ts';

const CONTEXT = /^[a-f0-9]{32}$/;
interface AccountHttpOptions { report?: ServerFailureReport; origins: string[]; trustLoopbackProxy?: boolean; now?: () => number; clientIp?: (req: IncomingMessage) => string }

export { parseAccountOrigins } from './account-security.ts';

export function createAccountHandler(accounts: Accounts, { origins, now = Date.now,
  clientIp, report, trustLoopbackProxy = false }: AccountHttpOptions) {
  const getClientIp = clientIp ?? accountClientIp(trustLoopbackProxy);
  const { assertOrigin, credentials, cookie } = createAccountSecurity({ origins, now });
  function context(value: unknown) {
    if (typeof value !== 'string' || !CONTEXT.test(value)) throw new HttpInputError('invalid_request', 400);
    return value;
  }
  return async function handle(req: IncomingMessage, res: ServerResponse, url: URL) {
    let proof: AccountCredentials = { bindings: {}, sessions: {} };
    const issued: string[] = [];
    const endpoint = url.pathname;
    let reported = false;
    function unexpected() {
      if (reported || req.aborted || res.destroyed) return;
      reported = true;
      reportServerFailure(report,{event:'http_request_failed',component:'account',reason:'unexpected'});
    }
    function reply(status: number, body: unknown, retryAt?: number) {
      let discarded: string[];
      try { discarded = accounts.discardedCredentials(proof).map(value => cookie(value.kind, value.id, '', 0)); }
      catch {
        unexpected();
        // A storage failure cannot prove that a browser credential is invalid.
        sendJSON(res, 503, { error: 'account_unavailable' }, { 'Cache-Control': 'private, no-store' });
        return;
      }
      sendJSON(res, status, body, { 'Cache-Control': 'private, no-store',
        ...(discarded.length || issued.length ? { 'Set-Cookie': [...discarded, ...issued] } : {}),
        ...(retryAt === undefined ? {} : { 'Retry-After': String(Math.max(1, Math.ceil((retryAt - now()) / 1000))) }) });
    }
    try {
      assertOrigin(req);
      proof = credentials(req.headers.cookie ?? '');
      if (req.method === 'GET' && endpoint === '/api/account') {
        const current = accounts.current(proof);
        if (current) issued.push(cookie('session', current.session.id, proof.sessions[current.session.id]!, current.session.expiresAt));
        reply(200, current ?? { account: null, session: null }); return;
      }
      if (req.method === 'GET' && endpoint === '/api/auth/attempt') {
        reply(200, accounts.progress(context(url.searchParams.get('id')), proof)); return;
      }
      const actions = new Set(['/api/auth/email/start', '/api/auth/email/resend', '/api/auth/email/verify',
        '/api/auth/confirm', '/api/auth/cancel', '/api/auth/logout', '/api/auth/telegram/start', '/api/auth/telegram/verify']);
      if (!actions.has(endpoint)) { reply(404, { error: 'not_found' }); return; }
      if (req.method !== 'POST') { reply(405, { error: 'method_not_allowed' }); return; }
      const input = await readJSONObject(req, endpoint === '/api/auth/telegram/verify' ? 20 * 1024 : 4096);
      if (endpoint === '/api/auth/telegram/start') {
        const result = accounts.startTelegram({ credentials: proof,
          ...(input.replaceId === undefined ? {} : { replaceId: context(input.replaceId) }) });
        issued.push(cookie('binding', result.binding.id, result.binding.secret, result.binding.expiresAt));
        reply(200, { attempt: result.attempt, telegram: result.telegram }); return;
      }
      if (endpoint === '/api/auth/email/start') {
        const result = await accounts.start({ email: input.email, credentials: proof, ip: getClientIp(req),
          ...(input.replaceId === undefined ? {} : { replaceId: context(input.replaceId) }) });
        issued.push(cookie('binding', result.binding.id, result.binding.secret, result.binding.expiresAt));
        reply(200, { attempt: result.attempt, delivery: 'queued' }); return;
      }
      const id = context(endpoint === '/api/auth/logout' ? input.sessionId : input.attemptId);
      if (endpoint === '/api/auth/telegram/verify') {
        const consumer = requestSignal(req, res);
        try {
          const result = await accounts.verifyTelegram(id, input.idToken, proof, { signal: consumer.signal });
          if (consumer.signal.aborted) return;
          if (result.grant) issued.push(cookie('session', id, result.grant.secret, result.grant.expiresAt));
          reply(200, { attemptId: id, needsEmail: result.needsEmail, needsConfirmation: result.needsConfirmation }); return;
        } finally { consumer.close(); }
      }
      if (endpoint === '/api/auth/email/resend') {
        reply(200, { attempt: await accounts.resend(id, getClientIp(req), proof), delivery: 'queued' }); return;
      }
      if (endpoint === '/api/auth/email/verify') {
        const grant = accounts.verify(id, input.code, proof);
        issued.push(cookie('session', id, grant.secret, grant.expiresAt));
        reply(200, { attemptId: id, needsConfirmation: true }); return;
      }
      if (endpoint === '/api/auth/confirm') {
        const result = accounts.confirm(id, proof);
        issued.push(cookie('session', id, proof.sessions[id]!, result.session.expiresAt));
        reply(200, result); return;
      }
      if (endpoint === '/api/auth/cancel') await accounts.cancel(id, proof);
      else await accounts.logout(id, proof);
      reply(200, { closed: true, contextId: id });
    } catch (error) {
      if (error instanceof AccountError || error instanceof HttpInputError) {
        const retryAt = error instanceof AccountError ? error.retryAt : undefined;
        reply(error.status, { error: error.code, ...(retryAt === undefined ? {} : { retryAt }) }, retryAt);
      } else { unexpected(); reply(503, { error: 'account_unavailable' }); }
    }
  };
}

export function accountClientIp(trustLoopbackProxy: boolean) {
  const normalize = (ip: string) => ip.startsWith('::ffff:') && isIP(ip.slice(7)) === 4 ? ip.slice(7) : ip;
  return (req: IncomingMessage) => {
    const direct = normalize(req.socket.remoteAddress ?? '');
    const forwarded = req.headers['x-real-ip'];
    if (trustLoopbackProxy && (direct === '::1' || isIP(direct) === 4 && direct.startsWith('127.'))
      && typeof forwarded === 'string' && isIP(forwarded)) return normalize(forwarded);
    return direct;
  };
}
