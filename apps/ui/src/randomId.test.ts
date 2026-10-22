import test from 'node:test';
import assert from 'node:assert/strict';
import { randomId } from './randomId.ts';

test('HTTP nonsecure-context UUID uses cryptographic bytes with RFC4122 version/variant', () => {
  const values = new Set(Array.from({ length: 100 }, () => randomId({ getRandomValues: crypto.getRandomValues.bind(crypto) })));
  assert.equal(values.size, 100);
  for (const value of values) assert.match(value, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.throws(() => randomId({} as Crypto));
});
