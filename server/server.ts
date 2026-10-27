import http from 'node:http';
import { createMailboxProxy } from './dev/mailbox-proxy.ts';
import { networkInterfaces } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCityCatalog } from './services/cities.ts';
import { createCalculator } from './services/calculate.ts';
import { createCalculationFailureReporter } from './services/calculation-failure.ts';
import { createRequestHandler } from './http/app.ts';
import { createDiagnosticHandler, DIAGNOSTIC_HTTP_RESERVED_BYTES } from './http/diagnostics.ts';
import { createTransitDays } from './services/transit-days.ts';
import { createNatalDays } from './services/natal-days.ts';
import { createPublicFileHandler, readReleaseManifest } from './http/public-files.ts';
import { createCycles, cyclesCalculationFingerprint } from './services/cycles.ts';
import { createLifetimeService } from './services/lifetime.ts';

import { createComputeQueue } from './runtime/compute-queue.ts';
import { calculationVersion } from './runtime/calculation-version.ts';
import { accountEnvironment } from './runtime/account-environment.ts';
import { createAccountRuntime } from './accounts.ts';
import { journalEnvironment } from './runtime/journal-environment.ts';
import { createJournalRuntime } from './journal/runtime.ts';

import { reportServerFailure } from './journal/report.ts';
import { createServiceInput, SERVICE_INPUT_RESERVED_BYTES } from './journal/service-input.ts';
import type { StartupComponent } from './journal/events.ts';

const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/** This composition owns startup failures and closes every owner it has created. */
export async function startServer({ root = projectRoot, env = process.env, release = false }: {
  root?: string; env?: NodeJS.ProcessEnv; release?: boolean;
} = {}) {
  const port = Number(env.PORT || 3636), host = env.HOST || '0.0.0.0';
  // A valid journal destination is required first. An invalid destination must
  // not silently create an alternative archive or report recursively to itself.
  const accountConfiguration = accountEnvironment(env, port);
  const journalConfiguration = journalEnvironment(env, accountConfiguration.stateDir);
  const journal = createJournalRuntime({...journalConfiguration, clientReservedBytes:DIAGNOSTIC_HTTP_RESERVED_BYTES+SERVICE_INPUT_RESERVED_BYTES});
  const cleanup: Array<() => unknown> = [];
  let closing: Promise<void> | undefined, component: StartupComponent = 'configuration';
  function close() {
    if (!closing) closing = (async () => {
      await Promise.allSettled(cleanup.map(dispose => Promise.resolve().then(dispose)));
      await journal.close();
    })();
    return closing;
  }
  try {
    const serviceInput=createServiceInput({directory:journalConfiguration.directory,report:journal.report});
    cleanup.push(()=>serviceInput.close());
    // Diagnostics remain best-effort; unavailable IPC cannot block the website.
    await serviceInput.ready;
    if(journalConfiguration.environment==='production' && !env.FORMA_APP_VERSION) {
      throw new TypeError('Set FORMA_APP_VERSION to the deployed version in production');
    }
    const appVersion=env.FORMA_APP_VERSION??'0.2-development';
    component='cities';
    const cities = await loadCityCatalog(path.join(root, 'data/cities.json'));
    component='versions';
    const numericVersion = await calculationVersion(root);
    const cyclesVersion = await cyclesCalculationFingerprint(root);
    component='public_files';
    const releaseDir = release ? path.join(root, 'dist') : null;
    const publicFiles = createPublicFileHandler({ cyclesVersion, calculationVersion: numericVersion, appVersion, environment:journalConfiguration.environment, ...(releaseDir
      ? { root: releaseDir, files: await readReleaseManifest(releaseDir), precompressed: true } : { root }) });
    const computeQueue = createComputeQueue(); cleanup.push(() => computeQueue.close());
    component='calculator';
    const calculate = createCalculator({ root, computeQueue, report: journal.report }); cleanup.push(() => calculate.close());
    component='transit_day';
    const transitDays = await createTransitDays({ root, computeQueue, report: journal.report,
      calculationVersion: numericVersion, cacheDir: env.TRANSIT_CACHE_DIR }); cleanup.push(() => transitDays.close());
    component='natal_day';
    const natalDays = createNatalDays({ root, computeQueue, report: journal.report, calculationVersion: numericVersion });
    component='cycles';
    const cycles = createCycles({ root, computeQueue, report: journal.report, cacheVersion: cyclesVersion }); cleanup.push(() => cycles.close());
    component='lifetime';
    const lifetime = createLifetimeService({ root, calculationVersion: numericVersion, report: journal.report }); cleanup.push(() => lifetime?.close());
    const invalidChartResult = createCalculationFailureReporter('calculator', journal.report);
    component='account';
    const account = await createAccountRuntime({ configuration: accountConfiguration,
      charts: { cities, calculate, cycles, calculationVersion: numericVersion, onInvalidResult: () => invalidChartResult('invalid_result') },
      report: journal.report, handoffMailReport: journal.handoffMailReport,
    }); cleanup.push(() => account.close());
    component='routing';
    const diagnosticHandler = createDiagnosticHandler({accounts:account.accounts,origins:accountConfiguration.origins,
      trustLoopbackProxy:accountConfiguration.trustLoopbackProxy,
      write:({deliveryIp,...report})=>journal.receiveClient(report,deliveryIp)});
    const handler = createRequestHandler({ root, report: journal.report, cities, calculate, transitDays, natalDays, lifetime, cycles, publicFiles,
      versions: { calculationVersion: numericVersion, cyclesVersion },
      accountHandler: account.handler, chartHandler: account.chartHandler, issueCalculationReceipt:account.issueCalculationReceipt, issueReturnReceipt:account.issueReturnReceipt, diagnosticHandler });
    const mailbox = createMailboxProxy({enabled:env.FORMA_LOCAL_MAILBOX === '1',
      environment:journalConfiguration.environment, release, port}); cleanup.push(() => mailbox.close());
    const server = http.createServer((req,res) => {
      if (!mailbox.handleHttp(req,res)) void handler(req,res);
    });
    cleanup.push(() => { if (server.listening) server.close(); });
    server.on('upgrade', (req,socket,head) => {
      if (!mailbox.handleUpgrade(req,socket,head)) socket.destroy();
    });
    server.on('close', () => { void close().catch(() => {}); });
    component='listener';
    await new Promise<void>((resolve,reject) => {
      server.once('error',reject);
      server.listen(port,host,() => { server.off('error',reject); resolve(); });
    });
    // Let HTTP requests drain; producers finish before the journal closes.
    const stop = () => { mailbox.close(); server.close(); };
    process.once('SIGTERM', stop); process.once('SIGINT', stop);
    cleanup.push(() => { process.off('SIGTERM',stop); process.off('SIGINT',stop); });
    const addresses = host === '0.0.0.0'
      ? ['localhost', ...new Set(Object.values(networkInterfaces()).flat()
        .filter(entry => entry?.family === 'IPv4').map(entry => entry.address))]
      : [host];
    for (const address of addresses) {
      const authority = address.includes(':') ? `[${address}]` : address;
      console.log(`Форма: http://${authority}:${port}/`);
    }
    if (!account.mailConfigured) console.log('Форма: почта не настроена; отправка кодов недоступна.');
    transitDays.startWarmup();
    return server;
  } catch (error) {
    reportServerFailure(journal.report,{event:'startup_failed',component,reason:'unexpected'});
    await close().catch(() => {});
    throw error;
  }
}

if (import.meta.main) {
  try { process.loadEnvFile(path.join(projectRoot, '.env')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  await startServer({release:process.argv.includes('--release')});
}
