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
import { forgetEndedConnectionLease, withEndedLeasePolicy } from './ended-lease.ts';
import { primeProviderConnection } from './provider-policy.ts';

vi.mock('@agent-device/plugins/store', async (importOriginal) =>
  (await import('../../__tests__/test-utils/limrun-plugin-store.ts')).storeWithLimrunInstalled(
    importOriginal as () => Promise<typeof import('@agent-device/plugins/store')>,
  ),
);

bindTestCommandHost();

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
  forgetEndedConnectionLease(
    {
      json: true,
      help: false,
      version: false,
      stateDir,
      remoteConfig: remoteConfigPath,
      session: 'adc-proxy',
    },
    response,
    createTestHostEnvironment(),
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

test('an ended host-allocated lease stays stored', async () => {
  // A provider declares in code that it forgets an ended lease, so its plugin loads first.
  await primeProviderConnection('limrun', createTestHostEnvironment().env);
  const reply: DaemonResponse = { ok: true, data: { endedLeases: [...ENDED] } };
  assert.equal(
    storedLeaseIdAfter(reply, { leaseBackend: 'macos-app', platform: 'macos' }),
    LEASE_ID,
  );
  assert.equal(storedLeaseIdAfter(reply, { leaseProvider: 'limrun' }), undefined);
  for (const leaseProvider of [undefined, 'revyl', 'browserstack', 'custom-provider']) {
    assert.equal(storedLeaseIdAfter(reply, { leaseProvider }), LEASE_ID);
  }
});

test('a provider whose plugin is not loaded leaves the recorded ended-lease policy as it is', () => {
  const now = new Date().toISOString();
  const recorded = {
    version: 1 as const,
    session: 'adc-custom',
    remoteConfigPath: '/unused/remote.json',
    remoteConfigHash: 'hash',
    tenant: 'custom',
    runId: 'run',
    leaseProvider: 'custom-provider',
    forgetsEndedLease: true,
    connectedAt: now,
    updatedAt: now,
  };
  // The plugin was uninstalled after `connect`: nothing declares the policy, so nothing rewrites it.
  assert.equal(withEndedLeasePolicy(recorded, createTestHostEnvironment().env), recorded);
  const unrecorded = { ...recorded, forgetsEndedLease: undefined };
  assert.equal(withEndedLeasePolicy(unrecorded, createTestHostEnvironment().env), unrecorded);
  // The daemon's own routing always declares it, and the first record is the authority.
  const proxy = withEndedLeasePolicy({ ...unrecorded, leaseProvider: 'proxy' }, {});
  assert.equal(proxy.forgetsEndedLease, true);
  const recordedFalse = { ...proxy, forgetsEndedLease: false };
  assert.equal(withEndedLeasePolicy(recordedFalse, {}), recordedFalse);
});
