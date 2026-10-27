import http from 'node:http';
import { createTransport } from 'nodemailer';
import type { CodeMail } from './code-mail.ts';

export interface PostfixEntry {
  queueId: string; codeId: string | null; contextId: string | null; discardAt: number;
  arrivedAt: number; messageBytes: number; state: string;
}
export interface PostfixQueue {
  list(): Promise<PostfixEntry[]>;
  submit(mail: CodeMail, bytes: Buffer): Promise<string>;
  remove(entry: PostfixEntry): Promise<void>;
  send(entry: PostfixEntry): Promise<boolean>;
  close(): void;
}
export interface PostfixOptions { controlSocket: string; smtpPort: number }
const identifier = /^[a-f0-9]{32}$/, queueId = /^[A-Za-z0-9]{5,128}$/;
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const integer = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

/** Only the private local queue is contacted here. Postfix owns external SMTP/TLS. */
export function createPostfix(options: PostfixOptions): PostfixQueue {
  if (!options.controlSocket.startsWith('/') || !Number.isInteger(options.smtpPort)
    || options.smtpPort < 1 || options.smtpPort > 65535) throw new TypeError('Invalid Postfix configuration');
  const smtp = createTransport({ host: '127.0.0.1', port: options.smtpPort, secure: false, ignoreTLS: true,
    connectionTimeout: 2000, greetingTimeout: 2000, socketTimeout: 5000,
    disableFileAccess: true, disableUrlAccess: true });
  async function control(body: Record<string, string>): Promise<Record<string, unknown>> {
    const bytes = Buffer.from(JSON.stringify(body));
    return new Promise((resolve, reject) => {
      const request = http.request({ socketPath: options.controlSocket, path: '/', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': bytes.length } }, response => {
        const chunks: Buffer[] = []; let length = 0;
        response.on('data', (part: Buffer) => {
          length += part.length;
          if (length > 1_048_576) response.destroy(new Error('Postfix response too large'));
          else chunks.push(part);
        });
        response.on('error', reject);
        response.on('end', () => {
          try {
            const value: unknown = JSON.parse(Buffer.concat(chunks).toString());
            if (response.statusCode !== 200 || !object(value)) throw new Error('Postfix control unavailable');
            resolve(value);
          } catch { reject(new Error('Invalid Postfix control response')); }
        });
      });
      const timeout = setTimeout(() => request.destroy(new Error('Postfix control timeout')), 10_000);
      request.on('close', () => clearTimeout(timeout));
      request.on('error', reject); request.end(bytes);
    });
  }
  function target(entry: PostfixEntry) {
    if (!queueId.test(entry.queueId) || !entry.codeId || !identifier.test(entry.codeId)) throw new TypeError('Invalid queue ownership');
    return { queueId: entry.queueId, codeId: entry.codeId };
  }
  return {
    async list() {
      const value = await control({ action: 'list' });
      if (!Array.isArray(value.entries)) throw new Error('Invalid Postfix list');
      return value.entries.map((entry: unknown) => {
        if (!object(entry) || typeof entry.queueId !== 'string' || !queueId.test(entry.queueId)
          || !(entry.codeId === null || typeof entry.codeId === 'string' && identifier.test(entry.codeId))
          || !(entry.contextId === null || typeof entry.contextId === 'string' && identifier.test(entry.contextId))
          || !integer(entry.discardAt) || !integer(entry.arrivedAt) || !integer(entry.messageBytes)
          || typeof entry.state !== 'string') throw new Error('Invalid Postfix metadata');
        return { queueId: entry.queueId, codeId: entry.codeId, contextId: entry.contextId,
          discardAt: entry.discardAt, arrivedAt: entry.arrivedAt, messageBytes: entry.messageBytes, state: entry.state };
      });
    },
    async submit(mail, bytes) {
      const result = await smtp.sendMail({ envelope: { from: 'forma@juxtaposition.ru', to: [mail.email] },
        dsn: { id: mail.id, return: 'headers', notify: ['success', 'failure'] }, raw: bytes });
      const match = /^250\b.*\bqueued as ([A-Za-z0-9]{5,128})\s*$/i.exec(result.response);
      if (!match || result.rejected.length || result.accepted.length !== 1) throw new Error('Postfix acceptance not confirmed');
      return match[1]!;
    },
    async remove(entry) { await control({ action: 'delete', ...target(entry) }); },
    async send(entry) {
      const value = await control({ action: 'send', ...target(entry) });
      if (typeof value.accepted !== 'boolean') throw new Error('Invalid Postfix send response');
      return value.accepted;
    },
    close() { smtp.close(); },
  };
}
