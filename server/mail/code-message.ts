import { createTransport } from 'nodemailer';
import type { CodeMail } from './code-mail.ts';

const composer = createTransport({ streamTransport: true, buffer: true, newline: 'windows' });

/** MIME encoding is delegated to Nodemailer; wording is the accepted template. */
export async function renderCodeMessage(mail: CodeMail): Promise<Buffer> {
  if (!/^[a-f0-9]{32}$/.test(mail.id) || !/^[a-f0-9]{32}$/.test(mail.contextId)
    || !/^\d{6}$/.test(mail.code) || /[\r\n\x00]/.test(mail.email)
    || !Number.isSafeInteger(mail.createdAt) || !Number.isSafeInteger(mail.discardAt)) {
    throw new TypeError('Invalid code mail');
  }
  const result = await composer.sendMail({
    from: { address: 'forma@juxtaposition.ru', name: '' },
    to: [{ address: mail.email, name: '' }],
    date: new Date(mail.createdAt),
    messageId: `<forma-code-${mail.id}@juxtaposition.ru>`,
    subject: 'Код для входа в Форму',
    text: `Ваш код: ${mail.code}\n\nВведите его на сайте Формы.\n\nСрок действия кода — 10 минут.\n\nЕсли вы не запрашивали код, просто проигнорируйте письмо.`,
    textEncoding: 'base64',
    headers: { 'Auto-Submitted': 'auto-generated', 'X-Forma-Code-Id': mail.id,
      'X-Forma-Context-Id': mail.contextId, 'X-Forma-Discard-At': String(mail.discardAt) },
    disableFileAccess: true,
    disableUrlAccess: true,
  });
  if (!Buffer.isBuffer(result.message)) throw new TypeError('Mail composer must return bytes');
  return result.message;
}
