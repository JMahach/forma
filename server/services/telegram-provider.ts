import { verifyTelegramIdentity, TelegramIdentityError, TELEGRAM_IDENTITY_LIMITS as limits } from './telegram-identity.ts';

type JSONWebKeySet = Parameters<typeof verifyTelegramIdentity>[1]['keys'];

const JWKS_URL = 'https://oauth.telegram.org/.well-known/jwks.json';
export class TelegramProviderError extends Error {
  readonly code = 'telegram_unavailable';
  constructor() { super('telegram_unavailable'); this.name = 'TelegramProviderError'; }
}
export interface TelegramAttempt { nonce: string; createdAt: number; expiresAt: number }

/** Fetch only Telegram-owned keys; neither tokens nor keys create another persistent store. */
export function createTelegramProvider({ clientId, now = Date.now, fetch: request = globalThis.fetch,
  timeoutMs = 5000 }: { clientId: string; now?: () => number; fetch?: typeof fetch; timeoutMs?: number }) {
  if (!/^[1-9][0-9]{0,19}$/.test(clientId)) throw new TypeError('Invalid Telegram client ID');
  return { clientId, async verify(token: unknown, attempt: TelegramAttempt, { signal }: { signal?: AbortSignal } = {}) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    if (typeof token !== 'string' || !token.length || token.length > limits.tokenCharacters) throw new TelegramIdentityError();
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, timeoutMs);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let rejectAborted: (() => void) | undefined;
    const interrupted = new Promise<never>((_resolve, reject) => {
      rejectAborted = () => { void reader?.cancel().catch(() => {}); reject(new TelegramProviderError()); };
      controller.signal.addEventListener('abort', rejectAborted, { once: true });
    });
    let keys: JSONWebKeySet;
    try {
      keys = await Promise.race([interrupted, (async () => {
        const response = await request(JWKS_URL, { signal: controller.signal, redirect: 'error', headers: { Accept: 'application/json' } });
        if (!response.ok || !response.body || controller.signal.aborted) { await response.body?.cancel(); throw new TelegramProviderError(); }
        reader = response.body.getReader();
        const chunks: Uint8Array[] = []; let size = 0;
        for (;;) {
          const part = await reader.read();
          if (part.done) break;
          size += part.value.byteLength;
          if (size > limits.keyBytes) { await reader.cancel(); throw new TelegramProviderError(); }
          chunks.push(part.value);
        }
        const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!value || typeof value !== 'object' || !('keys' in value) || !Array.isArray(value.keys)
          || !value.keys.length || value.keys.length > limits.keyCount
          || value.keys.some(key => !key || typeof key !== 'object' || Array.isArray(key))) throw new TelegramProviderError();
        return value as JSONWebKeySet;
      })()]);
    } catch {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      throw new TelegramProviderError();
    } finally {
      clearTimeout(timer); signal?.removeEventListener('abort', abort);
      if (rejectAborted) controller.signal.removeEventListener('abort', rejectAborted);
      reader?.releaseLock();
    }
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    return verifyTelegramIdentity(token, { ...attempt, clientId, keys, now: now() });
  } };
}
export type TelegramProvider = ReturnType<typeof createTelegramProvider>;
