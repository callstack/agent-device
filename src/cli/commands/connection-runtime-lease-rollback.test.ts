import { bindTestCommandHost, createTestHostEnvironment } from '@agent-device/test-kit';
import { afterEach, test, vi } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  connectionWorkspace,
  createTestClient,
  recordedLeaseRelease,
  seedConnectionState,
} from '../../__tests__/remote-connection.fixtures.ts';
import { materializeRemoteConnectionForCommand } from './connection-runtime.ts';
import { LEASE_ROLLBACK_RELEASE_FAILED_REASON } from './connection-lease-transaction.ts';
import { readRemoteConnectionState } from '@agent-device/remote/remote-connection-state';
import { AppError } from '@agent-device/kernel/errors';

bindTestCommandHost();

afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

/**
 * A well-formed `metro.prepare` refusal: the daemon could not reach the Metro target. One instance
 * per test, because the rollback may record secondary evidence on the error it was given.
 */
function metroPrepareFailure(): AppError {
  return new AppError('COMMAND_FAILED', 'Metro target is unreachable', {
    reason: 'METRO_PREPARE_FAILED',
  });
}

/** An `open` on a fresh session whose profile carries deferred Metro config. */
function metroFlags(stateDir: string, remoteConfigPath: string) {
  return {
    json: true,
    help: false,
    version: false,
    stateDir,
    remoteConfig: remoteConfigPath,
    daemonBaseUrl: 'https://daemon.example',
    tenant: 'acme',
    runId: 'run-123',
    session: 'adc-android',
    platform: 'android' as const,
    metroPublicBaseUrl: 'https://sandbox.example.test',
    metroProxyBaseUrl: 'https://proxy.example.test',
  };
}

function materializeOnHost(options: {
  stateDir: string;
  remoteConfigPath: string;
  client: Parameters<typeof materializeRemoteConnectionForCommand>[0]['client'];
}) {
  return materializeRemoteConnectionForCommand({
    host: createTestHostEnvironment(),
    command: 'open',
    flags: metroFlags(options.stateDir, options.remoteConfigPath),
    client: options.client,
  });
}

test('a lease this command allocated is released when Metro preparation fails', async () => {
  const { tempRoot, stateDir, remoteConfigPath } = connectionWorkspace(
    'agent-device-connect-metro-fail-',
  );
  fs.writeFileSync(remoteConfigPath, JSON.stringify({ daemonBaseUrl: 'https://daemon.example' }));
  const release = recordedLeaseRelease();
  const prepareFailure = metroPrepareFailure();

  await assert.rejects(
    async () =>
      await materializeOnHost({
        stateDir,
        remoteConfigPath,
        client: createTestClient({
          release: release.stub,
          prepare: async () => {
            throw prepareFailure;
          },
        }),
      }),
    prepareFailure,
  );

  // The record was never written, so this call still owned the lease it allocated and must end it.
  assert.equal(release.request?.leaseId, 'lease-1');
  assert.equal(release.request?.tenant, 'acme');
  assert.equal(release.request?.runId, 'run-123');
  assert.equal(release.request?.leaseBackend, 'android-instance');
  assert.equal(readRemoteConnectionState({ stateDir, session: 'adc-android' }), null);

  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('a lease this command renewed is kept when Metro preparation fails', async () => {
  const { tempRoot, stateDir, remoteConfigPath } = connectionWorkspace(
    'agent-device-connect-metro-fail-reused-',
  );
  fs.writeFileSync(remoteConfigPath, JSON.stringify({ daemonBaseUrl: 'https://daemon.example' }));
  const release = recordedLeaseRelease();
  seedConnectionState({
    stateDir,
    state: {
      session: 'adc-android',
      remoteConfigPath,
      daemon: { baseUrl: 'https://daemon.example' },
      tenant: 'acme',
      runId: 'run-123',
      leaseId: 'lease-renewed',
      leaseBackend: 'android-instance',
      platform: 'android',
    },
  });
  const prepareFailure = metroPrepareFailure();

  await assert.rejects(
    async () =>
      await materializeOnHost({
        stateDir,
        remoteConfigPath,
        client: createTestClient({
          release: release.stub,
          prepare: async () => {
            throw prepareFailure;
          },
        }),
      }),
    prepareFailure,
  );

  // The stored record owned that lease before this call, so disconnect still does.
  assert.equal(release.request, undefined);
  assert.equal(
    readRemoteConnectionState({ stateDir, session: 'adc-android' })?.leaseId,
    'lease-renewed',
  );

  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('a rollback whose release failed reports it on the Metro failure instead of masking it', async () => {
  const { tempRoot, stateDir, remoteConfigPath } = connectionWorkspace(
    'agent-device-connect-metro-fail-release-',
  );
  fs.writeFileSync(remoteConfigPath, JSON.stringify({ daemonBaseUrl: 'https://daemon.example' }));
  const prepareFailure = metroPrepareFailure();
  const releaseFailure = new AppError('COMMAND_FAILED', 'provider rejected the release');

  let thrown: unknown;
  try {
    await materializeOnHost({
      stateDir,
      remoteConfigPath,
      client: createTestClient({
        release: async () => {
          throw releaseFailure;
        },
        prepare: async () => {
          throw prepareFailure;
        },
      }),
    });
    assert.fail('expected materialization to reject');
  } catch (error) {
    thrown = error;
  }

  // ADR 0010 as amended by ADR 0019: the operation's own failure stays the thrown error with its
  // typed reason intact, and the cleanup failure rides beside it as structured evidence.
  assert.equal(thrown, prepareFailure);
  assert.ok(thrown instanceof AppError);
  assert.equal(thrown.code, 'COMMAND_FAILED');
  assert.equal(thrown.message, 'Metro target is unreachable');
  assert.equal(thrown.details?.reason, 'METRO_PREPARE_FAILED');
  assert.deepEqual(thrown.details?.leaseRollback, {
    leaseId: 'lease-1',
    released: false,
    reason: LEASE_ROLLBACK_RELEASE_FAILED_REASON,
    error: 'provider rejected the release',
  });

  fs.rmSync(tempRoot, { recursive: true, force: true });
});
