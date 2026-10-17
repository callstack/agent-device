import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'vitest';
import type { DaemonResponse } from '@agent-device/kernel/contracts';
import {
  connectionWorkspace,
  seedConnectionState,
  type StoredConnectionSeed,
} from '../../__tests__/remote-connection.fixtures.ts';
import { readRemoteConnectionState } from '@agent-device/remote/remote-connection-state';
import { forgetEndedProxyLease } from './ended-lease.ts';

const LEASE_ID = 'abc123abc123abc1';
const ENDED = [{ leaseId: LEASE_ID, outcome: 'released' }] as const;

function storedLeaseIdAfter(
  response: DaemonResponse,
  overrides: Partial<StoredConnectionSeed> = {},
): string | undefined {
  const { stateDir, remoteConfigPath } = connectionWorkspace('agent-device-ended-lease-');
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
  forgetEndedProxyLease(
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

test('an ended lease is forgotten from a reply or its error details', () => {
  const replies: DaemonResponse[] = [
    { ok: true, data: { session: 'adc-proxy', endedLeases: [...ENDED] } },
    {
      ok: false,
      error: { code: 'COMMAND_FAILED', message: 'failed', details: { endedLeases: [...ENDED] } },
    },
  ];
  for (const reply of replies) assert.equal(storedLeaseIdAfter(reply), undefined);
});

test('the stored lease stays unless the reply ends that lease at response level', () => {
  const nestedStep = { step: 1, command: 'close', ok: true, data: { endedLeases: [...ENDED] } };
  const replies: DaemonResponse[] = [
    { ok: true, data: { endedLeases: [{ leaseId: 'other-lease', outcome: 'released' }] } },
    { ok: true, data: { endedLeases: [{ leaseId: LEASE_ID, outcome: 'retained' }] } },
    { ok: true, data: { endedLeases: { leaseId: LEASE_ID, outcome: 'released' } } },
    { ok: true, data: { lease: { leaseId: LEASE_ID, tenantId: 'proxy', runId: 'run' } } },
    { ok: true, data: { total: 1, executed: 1, results: [nestedStep] } },
  ];
  for (const reply of replies) assert.equal(storedLeaseIdAfter(reply), LEASE_ID);
});

test('an ended lease the CLI does not own stays stored: host-allocated or non-proxy', () => {
  const reply: DaemonResponse = { ok: true, data: { endedLeases: [...ENDED] } };
  assert.equal(
    storedLeaseIdAfter(reply, { leaseBackend: 'macos-app', platform: 'macos' }),
    LEASE_ID,
  );
  assert.equal(storedLeaseIdAfter(reply, { leaseProvider: undefined }), LEASE_ID);
});
