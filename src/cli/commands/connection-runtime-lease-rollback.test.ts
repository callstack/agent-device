import { bindTestCommandHost, createTestHostEnvironment } from '@agent-device/test-kit';
import { afterEach, test, vi } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  connectionWorkspace,
  createTestClient,
  grantedLease,
  proxyWorkspace,
  recordedLeaseRelease,
  seedConnectionState,
  type LeaseAllocateRequest,
} from '../../__tests__/remote-connection.fixtures.ts';
import { materializeRemoteConnectionForCommand } from './connection-runtime.ts';
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

function writeProfile(remoteConfigPath: string) {
  fs.writeFileSync(remoteConfigPath, JSON.stringify({ daemonBaseUrl: 'https://daemon.example' }));
}

test('a lease this command allocated is released when Metro preparation fails', async () => {
  const { tempRoot, stateDir, remoteConfigPath } = connectionWorkspace(
    'agent-device-connect-metro-fail-',
  );
  writeProfile(remoteConfigPath);
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
  writeProfile(remoteConfigPath);
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

test('a lease the daemon says this request did not create is kept when Metro preparation fails', async () => {
  const { tempRoot, stateDir, remoteConfigPath } = connectionWorkspace(
    'agent-device-connect-metro-fail-not-created-',
  );
  writeProfile(remoteConfigPath);
  const release = recordedLeaseRelease();
  const prepareFailure = metroPrepareFailure();

  await assert.rejects(
    async () =>
      await materializeOnHost({
        stateDir,
        remoteConfigPath,
        client: createTestClient({
          // Another session of the same tenant/run holds this lease; the daemon hands it to the
          // repeat allocation instead of creating one, and only the answer says so.
          allocate: async (request: LeaseAllocateRequest) => ({
            leaseId: 'lease-held-by-another-session',
            tenantId: request.tenant,
            runId: request.runId,
            backend: request.leaseBackend ?? 'android-instance',
            created: false,
          }),
          release: release.stub,
          prepare: async () => {
            throw prepareFailure;
          },
        }),
      }),
    prepareFailure,
  );

  // The other session's record names that lease, so this failed command must leave it alive.
  assert.equal(release.request, undefined);

  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('an allocation omitting created is kept when Metro preparation fails', async () => {
  const { tempRoot, stateDir, remoteConfigPath } = connectionWorkspace(
    'agent-device-connect-old-daemon-',
  );
  writeProfile(remoteConfigPath);
  const releases: string[] = [];
  const prepareFailure = metroPrepareFailure();
  await assert.rejects(
    materializeOnHost({
      stateDir,
      remoteConfigPath,
      client: createTestClient({
        allocate: async (request) => {
          const { created: _created, ...lease } = grantedLease(request);
          return lease;
        },
        release: async (request) => {
          releases.push(request.leaseId);
          return { released: true };
        },
        prepare: async () => {
          throw prepareFailure;
        },
      }),
    }),
    (error) => {
      assert.equal(error, prepareFailure);
      assert.equal(prepareFailure.details?.leaseRollback, undefined);
      return true;
    },
  );
  assert.deepEqual(releases, []);
  assert.equal(readRemoteConnectionState({ stateDir, session: 'adc-android' }), null);
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('an already absent lease adds no rollback failure to the Metro error', async () => {
  const { tempRoot, stateDir, remoteConfigPath } = connectionWorkspace(
    'agent-device-connect-expired-',
  );
  writeProfile(remoteConfigPath);
  const releases: string[] = [];
  const prepareFailure = metroPrepareFailure();
  await assert.rejects(
    materializeOnHost({
      stateDir,
      remoteConfigPath,
      client: createTestClient({
        release: async (request) => {
          releases.push(request.leaseId);
          return { released: false };
        },
        prepare: async () => {
          throw prepareFailure;
        },
      }),
    }),
    (error) => {
      assert.equal(error, prepareFailure);
      assert.equal(prepareFailure.details?.leaseRollback, undefined);
      return true;
    },
  );
  assert.deepEqual(releases, ['lease-1']);
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('a lease allocated before a platform conflict is still released when acquisition fails', async () => {
  const { tempRoot, stateDir, remoteConfigPath, flags } = proxyWorkspace(
    'agent-device-connect-platform-conflict-',
  );
  const release = recordedLeaseRelease();

  // The proxy grants an Android device for an ios-instance lease: allocation succeeded, the axis
  // only disagrees once acquisition settles the platform afterwards, and the grant must not leak.
  await assert.rejects(
    async () =>
      await materializeRemoteConnectionForCommand({
        host: createTestHostEnvironment(),
        command: 'open',
        flags: { ...flags, stateDir, remoteConfig: remoteConfigPath },
        client: createTestClient({
          allocate: async (request) =>
            grantedLease(request, { deviceKey: 'android:mobile:emulator-5554' }),
          release: release.stub,
        }),
      }),
    (error: unknown) =>
      error instanceof AppError && error.details?.reason === 'CONNECTION_PLATFORM_CONFLICT',
  );

  assert.equal(release.request?.leaseId, 'lease-1');
  assert.equal(readRemoteConnectionState({ stateDir, session: 'adc-proxy' })?.leaseId, undefined);

  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('a lease the session record already names survives an active-pointer write failure', async () => {
  const { tempRoot, stateDir, remoteConfigPath } = connectionWorkspace(
    'agent-device-connect-pointer-fail-',
  );
  writeProfile(remoteConfigPath);
  const release = recordedLeaseRelease();

  const originalRenameSync = fs.renameSync.bind(fs);
  const writeFailure = new Error('pointer write failed');
  vi.spyOn(fs, 'renameSync').mockImplementation((oldPath, newPath) => {
    if (String(newPath).endsWith(path.join('remote-connections', '.active-session.json'))) {
      throw writeFailure;
    }
    return originalRenameSync(oldPath, newPath);
  });

  await assert.rejects(
    async () =>
      await materializeRemoteConnectionForCommand({
        host: createTestHostEnvironment(),
        command: 'open',
        // No Metro settings at all: the failure comes from the pointer write, not from Metro.
        flags: {
          ...metroFlags(stateDir, remoteConfigPath),
          metroPublicBaseUrl: undefined,
          metroProxyBaseUrl: undefined,
        },
        client: createTestClient({ release: release.stub }),
      }),
    writeFailure,
  );

  // The durable session record names the lease: the pointer is a reader, not the commit point,
  // and disconnect can still find the lease through the record.
  assert.equal(readRemoteConnectionState({ stateDir, session: 'adc-android' })?.leaseId, 'lease-1');
  assert.equal(release.request, undefined);

  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('a rollback whose release failed reports it on the Metro failure instead of masking it', async () => {
  const { tempRoot, stateDir, remoteConfigPath } = connectionWorkspace(
    'agent-device-connect-metro-fail-release-',
  );
  writeProfile(remoteConfigPath);
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
    reason: 'LEASE_RELEASE_FAILED',
    error: 'provider rejected the release',
  });

  fs.rmSync(tempRoot, { recursive: true, force: true });
});
