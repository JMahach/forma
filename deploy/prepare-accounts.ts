import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { accountEnvironment } from '../server/runtime/account-environment.ts';
import { createAccountRuntime } from '../server/accounts.ts';

// Bootstrap uses the same storage owner as the server, without opening a port or
// delivering pending mail. Run as the application user before installing Postfix.
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
try { process.loadEnvFile(path.join(root, '.env')); }
catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
const configuration = accountEnvironment(process.env, Number(process.env.PORT || 3636));
const runtime = await createAccountRuntime({configuration:{...configuration,postfix:null}});
await runtime.close();
console.log(`Account storage prepared: ${configuration.stateDir}`);
