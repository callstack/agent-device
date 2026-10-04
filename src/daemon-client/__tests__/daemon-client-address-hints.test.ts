import type { DaemonResponse } from '../../daemon/daemon-request.ts';
import { shellQuoteIfNeeded } from '@agent-device/kernel/device-shell';
import assert from 'node:assert/strict';
import { test } from 'vitest';
import { attachActiveSessionAddressHint } from '../daemon-client-address-hints.ts';

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
  assert.ok(String(hinted.data?.hint).includes('provide or configure --daemon-auth-token'));
});

test('attachActiveSessionAddressHint shell-quotes a --state-dir/--session value containing spaces or shell metacharacters', () => {
  const unsafeStateDir = '/tmp/state dir with $(danger)';
  const unsafeSession = 'cwd:abc123:my session; rm -rf /';
  const response: Extract<DaemonResponse, { ok: true }> = {
    ok: true,
    data: { session: unsafeSession, message: 'Replayed 1 step in 0.1s' },
  };

  const hinted = attachActiveSessionAddressHint(response, unsafeStateDir);

  assert.equal(
    hinted.data?.hint,
    "This session's daemon was kept alive because its script left the session active; " +
      `pass --state-dir ${shellQuoteIfNeeded(unsafeStateDir)} ` +
      `--session ${shellQuoteIfNeeded(unsafeSession)} on your next command to reach it.`,
  );
  // Both values actually needed quoting — this test would pass vacuously
  // (raw interpolation indistinguishable from quoted) if they didn't.
  assert.notEqual(shellQuoteIfNeeded(unsafeStateDir), unsafeStateDir);
  assert.notEqual(shellQuoteIfNeeded(unsafeSession), unsafeSession);
});

test('attachActiveSessionAddressHint omits --state-dir but still quotes an unsafe --session-only value', () => {
  const unsafeSession = "cwd:abc123:it's mine";
  const response: Extract<DaemonResponse, { ok: true }> = {
    ok: true,
    data: { session: unsafeSession, message: 'Replayed 1 step in 0.1s' },
  };

  const hinted = attachActiveSessionAddressHint(response, undefined);

  assert.equal(
    hinted.data?.hint,
    "This session's daemon was kept alive because its script left the session active; " +
      `pass --session ${shellQuoteIfNeeded(unsafeSession)} on your next command to reach it.`,
  );
  assert.doesNotMatch(String(hinted.data?.hint), /--state-dir/);
});
