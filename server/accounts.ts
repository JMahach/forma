import { createChartRuntime } from './charts.ts';
import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, chmod } from 'node:fs/promises';
import path from 'node:path';
import { openDatabase } from './storage/database.ts';
import { createTelegramProvider } from './services/telegram-provider.ts';
import { createAccounts } from './services/accounts.ts';
import { ACCOUNT_POLICY } from './services/account-policy.ts';
import { createAccountHandler, parseAccountOrigins } from './http/accounts.ts';
import { createPostfix } from './mail/postfix.ts';
import { createCodeMailQueue, type MailTerminalHandoff } from './mail/queue.ts';
import type { CodeMailQueue } from './mail/code-mail.ts';
import type { AccountEnvironment } from './runtime/account-environment.ts';

async function accountKey(stateDir: string) {
  const directory = path.join(stateDir, 'keys'), filename = path.join(directory, 'account-hmac.bin');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  try {
    const file = await open(filename, 'wx', 0o600);
    try { await file.writeFile(randomBytes(32)); await file.sync(); } finally { await file.close(); }
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  const file = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size !== 32 || info.mode & 0o077) throw new Error('Account key must be a private 32-byte file');
    return await file.readFile();
  } finally { await file.close(); }
}

export interface AccountRuntimeEvent { event: string; contextId?: string; accountId?: string; codeId?: string; eventId?: string; occurredAt?: number; recipient?: string; reason?: string }

/** One composition root joins storage, account policy, the mail queue and HTTP. */
export async function createAccountRuntime({ configuration, charts, now = Date.now, report = () => {}, handoffMailReport, telegramFetch }: {
  telegramFetch?: typeof fetch;
  configuration: AccountEnvironment; handoffMailReport?: MailTerminalHandoff; charts?: Pick<Parameters<typeof createChartRuntime>[0], 'cities' | 'calculate' | 'calculationVersion' | 'onInvalidResult' | 'cycles'>; now?: () => number; report?: (event: AccountRuntimeEvent) => void | boolean | Promise<void | boolean>;
}) {
  parseAccountOrigins(configuration.origins);
  await mkdir(configuration.stateDir, { recursive: true, mode: 0o700 });
  await chmod(configuration.stateDir, 0o700);
  const key = await accountKey(configuration.stateDir);
  const database = openDatabase(path.join(configuration.stateDir, 'forma.sqlite'));
  const controller = new AbortController();
  let queue: ReturnType<typeof createCodeMailQueue> | undefined, timer: NodeJS.Timeout | undefined;
  try {
    const unavailable: CodeMailQueue = {
      async enqueue() { throw new Error('Postfix is not configured'); },
      async cancel() { /* No transport is permitted when the local queue is not configured. */ },
    };
    const telegram = configuration.telegramClientId ? createTelegramProvider({ clientId: configuration.telegramClientId, now, fetch: telegramFetch }) : undefined;
    const accounts = createAccounts({ database, key, now, report, telegram, signal: controller.signal,
      mail: { enqueue: value => (queue ?? unavailable).enqueue(value), cancel: id => (queue ?? unavailable).cancel(id) } });
    const chartRuntime = charts && createChartRuntime({ ...charts, key, database, accounts, origins: configuration.origins, now, report });
    const handler = createAccountHandler(accounts, { origins: configuration.origins, now, report,
      trustLoopbackProxy: configuration.trustLoopbackProxy });
    if (configuration.postfix) queue = createCodeMailQueue({ database, postfix: createPostfix(configuration.postfix),
      isCurrent: accounts.isMailCurrent, now, report, handoffTerminal: handoffMailReport });
    const emit = (event: string) => { try { void Promise.resolve(report({ event, occurredAt: now() })).catch(() => {}); } catch { /* No authentication effect. */ } };
    timer = setInterval(() => {
      try { accounts.cleanup(); } catch { emit('account_cleanup_failed'); }
      try { chartRuntime?.cleanup(); } catch { emit('chart_cleanup_failed'); }
    }, ACCOUNT_POLICY.cleanupMs); timer.unref();
    queue?.start();
    let closing: Promise<void> | undefined;
    return { handler, chartHandler: chartRuntime?.handler, issueCalculationReceipt:chartRuntime?.issueCalculationReceipt, issueReturnReceipt:chartRuntime?.issueReturnReceipt, accounts, mailConfigured: !!configuration.postfix,
      close() {
        if (!closing) {
          controller.abort(); clearInterval(timer);
          closing = (async () => { try { await queue?.close(); } finally { database.close(); } })();
        }
        return closing;
      },
    };
  } catch (error) {
    controller.abort();
    if (timer) clearInterval(timer);
    await queue?.close(); database.close(); throw error;
  }
}
