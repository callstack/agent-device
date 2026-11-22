import { createTestDeviceInventoryGateways } from '@agent-device/device-selection/inventory-gateways-fixtures';
import { expect, test } from 'vitest';
import { AppError } from '@agent-device/kernel/errors';
import {
  ANDROID_EMULATOR,
  mkdtempForTestSync,
  createTestHostEnvironment,
} from '@agent-device/test-kit';
import { forwardingCreateCommandSurface } from '../../__tests__/support/command-surface-fake.ts';
import { makeSession } from '../../__tests__/support/session-factories.ts';
import { makeSessionStore } from '../../__tests__/support/store-factory.ts';
import { createRequestHandler } from '../../__tests__/support/test-device-runtime-gateway.ts';
import { screenshotRuntimeFixture } from '../../__tests__/support/screenshot-runtime-fixture.ts';
import { LeaseRegistry } from '../../resources/lease-registry.ts';

function snapshotHandler(error?: AppError) {
  const sessionStore = makeSessionStore('agent-device-snapshot-helper-response-');
  if (error) {
    sessionStore.publish(
      'default',
      makeSession('default', { device: ANDROID_EMULATOR, appBundleId: 'com.example.app' }),
    );
  }
  const runtime = screenshotRuntimeFixture(
    error
      ? {
          snapshotResult: () => {
            throw error;
          },
        }
      : {},
  );
  const leaseRegistry = new LeaseRegistry();
  const handler = createRequestHandler({
    host: createTestHostEnvironment(),
    createCommandSurface: forwardingCreateCommandSurface,
    logPath: `${mkdtempForTestSync('agent-device-snapshot-helper-response-')}/daemon.log`,
    token: 'token',
    sessionStore,
    leaseRegistry,
    deviceInventoryGateways: createTestDeviceInventoryGateways({
      local: async () => [ANDROID_EMULATOR],
    }),
    deviceRuntimeGateway: runtime.gateway,
    trackDownloadableArtifact: () => 'artifact-id',
  });
  return { handler, sessionStore, leaseRegistry, runtime };
}

async function requestSnapshot(handler: ReturnType<typeof createRequestHandler>) {
  return await handler({
    token: 'token',
    session: 'default',
    command: 'snapshot',
    positionals: [],
    flags: {},
  });
}

test('snapshot responses preserve the device-side install failure classification', async () => {
  const failure = new AppError(
    'COMMAND_FAILED',
    'Android snapshot helper failed: Failed to install Android snapshot helper: INSTALL_FAILED_TEST_ONLY',
    {
      stderr: 'adb: failed to install helper.apk: Failure [INSTALL_FAILED_TEST_ONLY]',
      hint: 'The Android package installer rejected the APK; this is a device-side install failure.',
      androidSnapshotHelperInstallFailure: true,
    },
  );
  const response = await requestSnapshot(snapshotHandler(failure).handler);

  expect(response.ok).toBe(false);
  if (response.ok) return;
  expect(response.error.message).toContain('INSTALL_FAILED_TEST_ONLY');
  expect(response.error.hint).toMatch(/package installer rejected the APK/);
  expect(response.error.hint).toMatch(/device-side install failure/);
  expect(response.error.hint).not.toMatch(/pnpm build:android/);
  expect(response.error.details?.androidSnapshotHelperInstallFailure).toBe(true);
});

test('snapshot responses preserve the transient retry signal on an install failure', async () => {
  const failure = new AppError(
    'COMMAND_FAILED',
    'Android snapshot helper failed: Failed to install Android snapshot helper',
    {
      hint: 'The adb connection dropped; retry the device-side install failure.',
      retriable: true,
      androidSnapshotHelperInstallFailure: true,
    },
  );
  const response = await requestSnapshot(snapshotHandler(failure).handler);

  expect(response.ok).toBe(false);
  if (response.ok) return;
  expect(response.error.message).toMatch(/Android snapshot helper failed/);
  expect(response.error.hint).toMatch(/connection dropped/);
  expect(response.error.hint).toMatch(/device-side install failure/);
  expect(response.error.retriable).toBe(true);
  expect(response.error.details?.androidSnapshotHelperInstallFailure).toBe(true);
});

test('snapshot-only creation binds its lease before another request can read it', async () => {
  const { handler, sessionStore, leaseRegistry, runtime } = snapshotHandler();
  const { leaseId, tenantId, runId, backend } = leaseRegistry.allocateLease({
    tenantId: 'snapshot-owner',
    runId: 'snapshot-run',
    leaseBackend: 'android-instance',
  });
  const request = {
    token: 'token',
    session: 'default',
    command: 'snapshot',
    positionals: [],
    flags: { platform: 'android' as const },
    meta: { sessionExplicit: true },
  };
  const captured = await handler({
    ...request,
    meta: { ...request.meta, leaseId, tenantId, runId, leaseBackend: backend },
  });
  expect(captured.ok, JSON.stringify(captured)).toBe(true);
  expect(sessionStore.lookup('default')?.session.lease?.leaseId).toBe(leaseId);
  expect(await handler(request)).toMatchObject({
    ok: false,
    error: { code: 'UNAUTHORIZED', details: { reason: 'LEASE_SESSION_MISMATCH' } },
  });
  expect(runtime.captureSnapshot).toHaveBeenCalledOnce();
});
