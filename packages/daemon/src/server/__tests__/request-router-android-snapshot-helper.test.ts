import { createTestDeviceInventoryGateways } from '@agent-device/device-selection/inventory-gateways-fixtures';
import { expect, test } from 'vitest';
import { AppError } from '@agent-device/kernel/errors';
import { ANDROID_EMULATOR, mkdtempForTestSync } from '@agent-device/test-kit';
import { forwardingCreateCommandSurface } from '../../__tests__/support/command-surface-fake.ts';
import { makeSession } from '../../__tests__/support/session-factories.ts';
import { makeSessionStore } from '../../__tests__/support/store-factory.ts';
import { createRequestHandler } from '../../__tests__/support/test-device-runtime-gateway.ts';
import { screenshotRuntimeFixture } from '../../__tests__/support/screenshot-runtime-fixture.ts';
import { LeaseRegistry } from '../../resources/lease-registry.ts';

function snapshotHandler(error: AppError) {
  const sessionStore = makeSessionStore('agent-device-snapshot-helper-response-');
  sessionStore.publish(
    'default',
    makeSession('default', { device: ANDROID_EMULATOR, appBundleId: 'com.example.app' }),
  );
  const runtime = screenshotRuntimeFixture({
    snapshotResult: () => {
      throw error;
    },
  });
  const handler = createRequestHandler({
    createCommandSurface: forwardingCreateCommandSurface,
    logPath: `${mkdtempForTestSync('agent-device-snapshot-helper-response-')}/daemon.log`,
    token: 'token',
    sessionStore,
    leaseRegistry: new LeaseRegistry(),
    deviceInventoryGateways: createTestDeviceInventoryGateways(),
    deviceRuntimeGateway: runtime.gateway,
    trackDownloadableArtifact: () => 'artifact-id',
  });
  return handler;
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
  const response = await requestSnapshot(snapshotHandler(failure));

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
  const response = await requestSnapshot(snapshotHandler(failure));

  expect(response.ok).toBe(false);
  if (response.ok) return;
  expect(response.error.message).toMatch(/Android snapshot helper failed/);
  expect(response.error.hint).toMatch(/connection dropped/);
  expect(response.error.hint).toMatch(/device-side install failure/);
  expect(response.error.retriable).toBe(true);
  expect(response.error.details?.androidSnapshotHelperInstallFailure).toBe(true);
});
