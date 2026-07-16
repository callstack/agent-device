import { beforeEach, expect, test } from 'vitest';
import { createRequestHandler } from '../request-router.ts';
import { LeaseRegistry } from '../lease-registry.ts';
import { SessionStore } from '../session-store.ts';
import { AppError } from '../../kernel/errors.ts';
import { resetAndroidSnapshotHelperInstallCache } from '../../platforms/android/snapshot-helper-install.ts';
import { ANDROID_SNAPSHOT_HELPER_FIXTURE_ARTIFACT } from '../../__tests__/test-utils/index.ts';
import type { AndroidAdbProvider } from '../../platforms/android/adb-executor.ts';

function makeAndroidSessionStore(name: string): SessionStore {
  const sessionStore = new SessionStore(`/tmp/${name}`);
  sessionStore.set('default', {
    name: 'default',
    createdAt: Date.now(),
    device: {
      platform: 'android',
      id: 'remote-android-1',
      name: 'Remote Android',
      kind: 'device',
      booted: true,
    },
    appBundleId: 'com.example.app',
    actions: [],
  });
  return sessionStore;
}

function makeHandler(sessionStore: SessionStore, androidAdbProvider: () => AndroidAdbProvider) {
  return createRequestHandler({
    logPath: '/tmp/daemon.log',
    token: 'token',
    sessionStore,
    leaseRegistry: new LeaseRegistry(),
    androidAdbProvider,
    trackDownloadableArtifact: () => 'artifact-id',
  });
}

beforeEach(() => {
  resetAndroidSnapshotHelperInstallCache();
});

// Regression for #1284/#1285 P1: a provider whose `install` REJECTS with an
// enriched INSTALL_FAILED_* error (instead of resolving with a nonzero result)
// must still surface the device-side install classification on the public
// daemon snapshot error, not the generic retry/doctor hint.
test('snapshot reports a device-side install failure when the provider install rejects', async () => {
  const sessionStore = makeAndroidSessionStore(
    'agent-device-request-router-snapshot-helper-install-reject-test',
  );
  const provider: AndroidAdbProvider = {
    // Version probe reports no installed helper; every other device query is inert.
    exec: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    install: async () => {
      throw new AppError('COMMAND_FAILED', 'Failed to install Android snapshot helper', {
        stderr: 'adb: failed to install helper.apk: Failure [INSTALL_FAILED_TEST_ONLY]',
        stdout: '',
        exitCode: 1,
        processExitError: true,
      });
    },
    snapshotHelperArtifact: ANDROID_SNAPSHOT_HELPER_FIXTURE_ARTIFACT,
  };
  const handler = makeHandler(sessionStore, () => provider);

  const response = await handler({
    token: 'token',
    session: 'default',
    command: 'snapshot',
    positionals: [],
    flags: {},
  });

  expect(response.ok).toBe(false);
  if (response.ok) throw new Error('Expected snapshot to fail');
  expect(response.error.message).toMatch(/Android snapshot helper failed/);
  expect(response.error.message).toMatch(/INSTALL_FAILED_TEST_ONLY/);
  // The provider funnel's classified adb hint is preserved, with the
  // device-side framing appended rather than replacing it.
  expect(response.error.hint).toMatch(/package installer rejected the APK/);
  expect(response.error.hint).toMatch(/device-side install failure/);
  expect(response.error.hint).not.toMatch(/pnpm build:android/);
  expect(response.error.details?.androidSnapshotHelperInstallFailure).toBe(true);
});

// ADR 0010 wire contract: a transient-classified install rejection (here the
// funnel's `connection_dropped` family) must keep its structured `retriable`
// signal through the capture rewrap onto the public daemon error.
test('snapshot keeps the transient retry signal when the provider install rejection is retriable', async () => {
  const sessionStore = makeAndroidSessionStore(
    'agent-device-request-router-snapshot-helper-install-transient-test',
  );
  const provider: AndroidAdbProvider = {
    exec: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    install: async () => {
      throw new AppError('COMMAND_FAILED', 'Failed to install Android snapshot helper', {
        stderr: 'adb: transport error while pushing helper.apk',
        stdout: '',
        exitCode: 1,
        processExitError: true,
      });
    },
    snapshotHelperArtifact: ANDROID_SNAPSHOT_HELPER_FIXTURE_ARTIFACT,
  };
  const handler = makeHandler(sessionStore, () => provider);

  const response = await handler({
    token: 'token',
    session: 'default',
    command: 'snapshot',
    positionals: [],
    flags: {},
  });

  expect(response.ok).toBe(false);
  if (response.ok) throw new Error('Expected snapshot to fail');
  expect(response.error.message).toMatch(/Android snapshot helper failed/);
  expect(response.error.hint).toMatch(/connection dropped/);
  expect(response.error.hint).toMatch(/device-side install failure/);
  expect(response.error.retriable).toBe(true);
  expect(response.error.details?.androidSnapshotHelperInstallFailure).toBe(true);
});
