import assert from 'node:assert/strict';
import { test } from 'vitest';
import { attachActiveSessionAddressHint } from '../daemon-client-lifecycle.ts';

test('remote active-session guidance retains the endpoint without URL credentials', () => {
  const response = { ok: true as const, data: { session: 'cwd:abc:default', sessionActive: true } };
  const hinted = attachActiveSessionAddressHint(
    response,
    undefined,
    'https://operator:private-token@example.com/team?secret=hidden#private',
  );
  assert.ok(String(hinted.data?.hint).includes('--daemon-base-url https://example.com/team'));
  assert.ok(String(hinted.data?.hint).includes('--session cwd:abc:default'));
  assert.ok(!JSON.stringify(hinted).includes('private'));
  assert.ok(!JSON.stringify(hinted).includes('hidden'));
  assert.ok(!String(hinted.data?.hint).includes('--state-dir'));
});
