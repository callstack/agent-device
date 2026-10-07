import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readHostPrincipal } from './host-principal.ts';

test('a Host principal header is read only in the tenant format, and a malformed one is refused', () => {
  assert.equal(readHostPrincipal({}), undefined);
  assert.equal(
    readHostPrincipal({ 'x-agent-device-principal': 'host-svc-3f9c2a1b' }),
    'host-svc-3f9c2a1b',
  );
  assert.equal(readHostPrincipal({ 'x-agent-device-principal': 'host svc/../x' }), null);
  assert.equal(readHostPrincipal({ 'x-agent-device-principal': ['a', 'b'] }), null);
});
