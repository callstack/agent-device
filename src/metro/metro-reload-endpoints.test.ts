import { test } from 'vitest';
import assert from 'node:assert/strict';
import { parsePort } from './metro-reload-endpoints.ts';

test('a Metro port is a whole number from 1 to 65535', () => {
  assert.equal(parsePort('8082', 8081), 8082);
  assert.equal(parsePort(undefined, 8081), 8081);
  for (const value of ['8081oops', '80.5', '0', '65536', '-1']) {
    assert.throws(() => parsePort(value, 8081), /Invalid Metro port/, value);
  }
});
