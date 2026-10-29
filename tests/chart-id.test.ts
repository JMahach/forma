import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { createRandomId } from '../src/domain/chart-record.ts';

// Each crypto double supplies only the capability exercised at this browser boundary.
const uuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

test('chart IDs prefer native randomUUID with its original receiver', () => {
  const expected = '00112233-4455-4677-8899-aabbccddeeff';
  const cryptoApi = {
    randomUUID() { assert.equal(this, cryptoApi); return expected; },
    getRandomValues() { assert.fail('native UUID generation should be used'); }
  };
  assert.equal(createRandomId(cryptoApi as unknown as Crypto), expected);
});

test('HTTP fallback uses random bytes and sets UUID v4 version and variant', () => {
  for (const value of [0, 255] as const) {
    const cryptoApi = {
      getRandomValues(bytes: Uint8Array) {
        assert.equal(this, cryptoApi);
        assert.ok(bytes instanceof Uint8Array);
        assert.equal(bytes.length, 16);
        bytes.fill(value);
        return bytes;
      }
    };
    const id = createRandomId(cryptoApi as unknown as Crypto);
    assert.match(id, uuidV4);
    assert.equal(id, value === 0 ? '00000000-0000-4000-8000-000000000000' : 'ffffffff-ffff-4fff-bfff-ffffffffffff');
  }
});

test('HTTP fallback creates distinct valid IDs', () => {
  const cryptoApi = { getRandomValues: (bytes:Uint8Array) => webcrypto.getRandomValues(bytes) };
  const ids = Array.from({ length: 1000 }, () => createRandomId(cryptoApi as unknown as Crypto));
  assert.equal(new Set(ids).size, ids.length);
  for (const id of ids) assert.match(id, uuidV4);

});

test('missing random-byte support reports a readable error instead of using weak randomness', () => {
  for (const cryptoApi of [null, {}] as const) {
    assert.throws(() => createRandomId(cryptoApi as unknown as Crypto), /Браузер не поддерживает создание идентификатора карты/);
  }
});
