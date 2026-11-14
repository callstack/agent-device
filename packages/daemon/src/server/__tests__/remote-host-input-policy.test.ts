import assert from 'node:assert/strict';
import { test } from 'vitest';
import { restrictRemoteHostInputs } from '../remote-host-input-policy.ts';
import type { DaemonRequest } from '../../core/daemon-request.ts';

function remoteRequest(input: Record<string, unknown>, flags: Record<string, unknown> = {}) {
  return {
    command: 'screenshot',
    positionals: [],
    flags,
    input,
    internal: { publicNetworkOnly: true },
  } as unknown as DaemonRequest;
}

test('a remote screenshot burst refuses with a typed reason before any device work', () => {
  try {
    restrictRemoteHostInputs(remoteRequest({ count: 5, outPath: '/tmp/x.png' }));
    assert.fail('a remote burst must refuse');
  } catch (error) {
    assert.equal((error as { code?: string }).code, 'INVALID_ARGS');
    assert.equal(
      (error as { details?: { reason?: string } }).details?.reason,
      'REMOTE_SCREENSHOT_BURST_DENIED',
    );
  }
});

test('a remote burst armed by a flags-level count refuses the same way', () => {
  assert.throws(
    () => restrictRemoteHostInputs(remoteRequest({ outPath: '/tmp/x.png' }, { count: 2 })),
    /only the first frame would come back/,
  );
});

test('a remote single screenshot without count still passes the capture lane', () => {
  const restricted = restrictRemoteHostInputs(remoteRequest({ outPath: '/tmp/x.png' }));
  assert.equal((restricted.input as Record<string, unknown>).count, undefined);
  assert.equal(restricted.command, 'screenshot');
});
