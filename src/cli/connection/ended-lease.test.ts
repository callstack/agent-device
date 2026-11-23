import { bindTestCommandHost, createTestHostEnvironment } from '@agent-device/test-kit';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test, vi } from 'vitest';
import type { DaemonResponse } from '@agent-device/kernel/contracts';
import {
  connectionWorkspace,
  seedConnectionState,
  type StoredConnectionSeed,
} from '../../__tests__/remote-connection.fixtures.ts';
import { readRemoteConnectionState } from '@agent-device/remote/remote-connection-state';
import { createAgentDeviceClient } from '@agent-device/client';
import { materializeRemoteConnectionForCommand } from '../../__tests__/test-utils/materialize-connection.ts';
import { forgetEndedConnectionLease } from './ended-lease.ts';
import { primeProviderConnection } from './provider-policy.ts';

vi.mock('@agent-device/plugins/store', async (importOriginal) =>
  (await import('../../__tests__/test-utils/limrun-plugin-store.ts')).storeWithLimrunInstalled(
    importOriginal as () => Promise<typeof import('@agent-device/plugins/store')>,
  ),
);

bindTestCommandHost();

const LEASE_ID = 'abc123abc123abc1';
const ENDED = [{ leaseId: LEASE_ID, outcome: 'released' }] as const;

function endLeaseOnConnection(
  response: DaemonResponse,
  overrides: Partial<StoredConnectionSeed> = {},
) {
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
  const flags = {
    json: true,
    help: false,
    version: false,
    stateDir,
    remoteConfig: remoteConfigPath,
    session: 'adc-proxy',
  };
  forgetEndedConnectionLease(flags, response, createTestHostEnvironment());
  return { flags, state: readRemoteConnectionState({ stateDir, session: 'adc-proxy' }) };
}

function storedStateAfter(response: DaemonResponse, overrides: Partial<StoredConnectionSeed> = {}) {
  return endLeaseOnConnection(response, overrides).state;
}

function storedLeaseIdAfter(
  response: DaemonResponse,
  overrides: Partial<StoredConnectionSeed> = {},
): string | undefined {
  return storedStateAfter(response, overrides)?.leaseId;
}

test('an ended lease is forgotten from a reply or its error details', () => {
  const replies: DaemonResponse[] = [
    { ok: true, data: { session: 'adc-proxy', endedLeases: [...ENDED] } },
    {
      ok: false,
      error: { code: 'COMMAND_FAILED', message: 'failed', details: { endedLeases: [...ENDED] } },
    },
  ];
  for (const reply of replies) {
    const stored = storedStateAfter(reply);
    assert.equal(stored?.leaseId, undefined);
    assert.equal(stored?.endedLeaseId, LEASE_ID);
  }
});

test('the stored lease stays unless the reply ends that lease at response level', () => {
  const nestedStep = { step: 1, command: 'close', ok: true, data: { endedLeases: [...ENDED] } };
  const replies: DaemonResponse[] = [
    { ok: true, data: { endedLeases: [{ leaseId: 'f'.repeat(32), outcome: 'released' }] } },
    { ok: true, data: { endedLeases: [{ leaseId: LEASE_ID, outcome: 'retained' }] } },
    { ok: true, data: { endedLeases: { leaseId: LEASE_ID, outcome: 'released' } } },
    { ok: true, data: { lease: { leaseId: LEASE_ID, tenantId: 'proxy', runId: 'run' } } },
    { ok: true, data: { total: 1, executed: 1, results: [nestedStep] } },
  ];
  for (const reply of replies) assert.equal(storedLeaseIdAfter(reply), LEASE_ID);
});

test('an ended host-allocated lease stays stored', async () => {
  // A provider declares in code that it forgets an ended lease, so its plugin loads first.
  await primeProviderConnection('limrun', createTestHostEnvironment().env);
  const reply: DaemonResponse = { ok: true, data: { endedLeases: [...ENDED] } };
  assert.equal(
    storedLeaseIdAfter(reply, { leaseBackend: 'macos-app', platform: 'macos' }),
    LEASE_ID,
  );
  const limrun = storedStateAfter(reply, { leaseProvider: 'limrun' });
  assert.equal(limrun?.leaseId, undefined);
  assert.equal(limrun?.endedLeaseId, undefined);
  for (const leaseProvider of [undefined, 'revyl', 'browserstack', 'custom-provider']) {
    assert.equal(storedLeaseIdAfter(reply, { leaseProvider }), LEASE_ID);
  }
});

test('artifacts still sends the lease that a close ended', async () => {
  const { flags } = endLeaseOnConnection({ ok: true, data: { endedLeases: [...ENDED] } });
  const host = createTestHostEnvironment();
  const client = createAgentDeviceClient(
    {},
    {
      host,
      transport: async (request) => {
        throw new Error(`unexpected daemon request: ${request.command}`);
      },
    },
  );
  const leaseIdFor = async (command: string) =>
    (await materializeRemoteConnectionForCommand({ host, command, client, flags })).flags.leaseId;

  assert.equal(await leaseIdFor('artifacts'), LEASE_ID);
  assert.equal(await leaseIdFor('session'), undefined);
});
