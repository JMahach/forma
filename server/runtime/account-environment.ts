import os from 'node:os';
import path from 'node:path';
import type { PostfixOptions } from '../mail/postfix.ts';

export interface AccountEnvironment {
  telegramClientId?: string;
  stateDir: string; origins: string[]; postfix: PostfixOptions | null; trustLoopbackProxy: boolean;
}

/** Persistent account data is separate from generated calculations and the source tree. */
export function accountEnvironment(env: NodeJS.ProcessEnv, port: number): AccountEnvironment {
  const stateDir = env.FORMA_STATE_DIR ?? path.join(os.homedir(), '.local/share/forma');
  if (!path.isAbsolute(stateDir) || path.resolve(stateDir) === path.parse(stateDir).root) throw new TypeError('FORMA_STATE_DIR must name an absolute private directory');
  const origins = env.FORMA_ACCOUNT_ORIGINS?.split(',').map(value => value.trim())
    ?? [`http://localhost:${port}`, `http://127.0.0.1:${port}`, `http://[::1]:${port}`];
  if (env.FORMA_TRUST_PROXY !== undefined && env.FORMA_TRUST_PROXY !== 'loopback') throw new TypeError('Only an explicitly configured loopback proxy is supported');
  const socket = env.FORMA_POSTFIX_SOCKET, smtpPort = env.FORMA_POSTFIX_PORT;
  let postfix: PostfixOptions | null = null;
  if (socket !== undefined || smtpPort !== undefined) {
    if (!socket || !path.isAbsolute(socket) || !smtpPort || !/^\d+$/.test(smtpPort)
      || Number(smtpPort) < 1 || Number(smtpPort) > 65535) throw new TypeError('Configure both FORMA_POSTFIX_SOCKET and FORMA_POSTFIX_PORT');
    postfix = { controlSocket: socket, smtpPort: Number(smtpPort) };
  }
  const telegramClientId = env.FORMA_TELEGRAM_CLIENT_ID;
  if (telegramClientId !== undefined && !/^[1-9][0-9]{0,19}$/.test(telegramClientId)) throw new TypeError('Invalid FORMA_TELEGRAM_CLIENT_ID');
  return { ...(telegramClientId === undefined ? {} : { telegramClientId }), stateDir, origins, postfix, trustLoopbackProxy: env.FORMA_TRUST_PROXY === 'loopback' };
}
