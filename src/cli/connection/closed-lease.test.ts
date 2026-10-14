import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'vitest';
import type { DaemonResponse } from '@agent-device/kernel/contracts';
import {
  connectionWorkspace,
  seedConnectionState,
  type StoredConnectionSeed,
} from '../../__tests__/remote-connection.fixtures.ts';
import { readRemoteConnectionState } from '../../remote/remote-connection-state.ts';
import { forgetProxyLeaseReleasedByClose } from './closed-lease.ts';

const LEASE_ID = 'abc123abc123abc1';
const RELEASED = { outcome: 'released', leaseId: LEASE_ID } as const;

function storedLeaseIdAfter(
  response: DaemonResponse,
  overrides: Partial<StoredConnectionSeed> = {},
): string | undefined {
  const { stateDir, remoteConfigPath } = connectionWorkspace('agent-device-closed-lease-');
  fs.writeFileSync(remoteConfigPath, JSON.stringify({ daemonBaseUrl: 'https://daemon.example' }));
  seedConnectionState({
    stateDir,
    state: {
      session: 'adc-proxy',
      remoteConfigPath,
      tenant: 'proxy',
      runId: 'proxy-client-1',
      leaseId: LEASE_ID,
      leaseBackend: 'ios-instance',
      leaseProvider: 'proxy',
      platform: 'ios',
      ...overrides,
    },
  });
  forgetProxyLeaseReleasedByClose(
    {
      json: true,
      help: false,
      version: false,
      stateDir,
      remoteConfig: remoteConfigPath,
      session: 'adc-proxy',
    },
    response,
  );
  return readRemoteConnectionState({ stateDir, session: 'adc-proxy' })?.leaseId;
}

const closeStep = { step: 1, command: 'close', ok: true, data: { lease: RELEASED }, durationMs: 1 };

test('a released lease is forgotten from a close reply, its error, or a batch step', () => {
  const replies: DaemonResponse[] = [
    { ok: true, data: { session: 'adc-proxy', lease: RELEASED } },
    {
      ok: false,
      error: { code: 'COMMAND_FAILED', message: 'failed', details: { lease: RELEASED } },
    },
    { ok: true, data: { total: 1, executed: 1, totalDurationMs: 1, results: [closeStep] } },
    {
      ok: false,
      error: {
        code: 'COMMAND_FAILED',
        message: 'step 2',
        details: { partialResults: [closeStep] },
      },
    },
  ];
  for (const reply of replies) assert.equal(storedLeaseIdAfter(reply), undefined);
});

test('the stored lease stays unless the reply releases that lease', () => {
  const replies: DaemonResponse[] = [
    { ok: true, data: { lease: { outcome: 'retained', leaseId: LEASE_ID } } },
    { ok: true, data: { lease: { outcome: 'none' } } },
    { ok: true, data: { lease: { outcome: 'released', leaseId: 'other-lease' } } },
    { ok: true, data: { lease: { leaseId: LEASE_ID, tenantId: 'proxy', runId: 'run' } } },
  ];
  for (const reply of replies) assert.equal(storedLeaseIdAfter(reply), LEASE_ID);
});

test('a released lease the CLI does not own stays stored: host-allocated or non-proxy', () => {
  const reply: DaemonResponse = { ok: true, data: { lease: RELEASED } };
  assert.equal(
    storedLeaseIdAfter(reply, { leaseBackend: 'macos-app', platform: 'macos' }),
    LEASE_ID,
  );
  assert.equal(storedLeaseIdAfter(reply, { leaseProvider: undefined }), LEASE_ID);
});
