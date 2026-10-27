import test from 'node:test';
import assert from 'node:assert/strict';
import { renderCodeMessage } from '../server/mail/code-message.ts';

const sample = { id: 'a'.repeat(32), contextId: 'b'.repeat(32), email: 'person@example.test',
  code: '123456', createdAt: 1_000_000, discardAt: 1_300_000 };

test('a code email contains exactly the accepted subject and body', async () => {
  const result = await renderCodeMessage(sample);
  const mime = result.toString('utf8');
  assert.match(mime, /From: forma@juxtaposition\.ru\r\n/);
  assert.match(mime, /To: person@example\.test\r\n/);
  assert.match(mime, /Content-Transfer-Encoding: base64/);
  const unfolded = mime.replace(/\r\n[ \t]+/g, ' ');
  const subject = unfolded.match(/^Subject: (.+)$/m)![1]!.trim();
  const decodedSubject = subject.replace(/(\?=)[ \t]+(?==\?)/g, '$1').replace(/=\?UTF-8\?B\?([^?]+)\?=/gi, (_, value: string) => Buffer.from(value, 'base64').toString('utf8'));
  assert.equal(decodedSubject, 'Код для входа в Форму');
  const body = Buffer.from(mime.split('\r\n\r\n').slice(1).join('\r\n\r\n').replace(/\s/g, ''), 'base64').toString('utf8').trim();
  assert.equal(body, 'Ваш код: 123456\n\nВведите его на сайте Формы.\n\nСрок действия кода — 10 минут.\n\nЕсли вы не запрашивали код, просто проигнорируйте письмо.');
  assert.match(mime, /Message-ID: <forma-code-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa@juxtaposition\.ru>/);
});

test('template refuses header injection and never accepts arbitrary body content', async () => {
  await assert.rejects(renderCodeMessage({ ...sample, email: 'person@example.test\r\nBcc: other@example.test' }));
  await assert.rejects(renderCodeMessage({ ...sample, code: '123456\nanything' }));
  await assert.rejects(renderCodeMessage({ ...sample, id: 'invalid\r\n' }));
});
