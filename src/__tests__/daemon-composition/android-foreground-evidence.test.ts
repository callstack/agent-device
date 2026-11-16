import { test, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createTestDeviceInventoryGateways } from '@agent-device/device-selection/inventory-gateways-fixtures';
import { createTestHostEnvironment, mkdtempForTestSync } from '@agent-device/test-kit';
import { AppError } from '@agent-device/kernel/errors';
import { getResolveTargetDeviceMock } from '../../../packages/daemon/src/__tests__/support/request-router-dispatch-mocks.ts';
import { fakeCreateCommandSurface } from '../../../packages/daemon/src/__tests__/support/command-surface-fake.ts';
import { dispatchApplicationLifecycleEffect } from '../../../packages/daemon/src/__tests__/support/application-lifecycle-runtime-fixture.ts';
import {
  createRequestHandler,
  lifecycleDeviceRuntimeGateway,
} from '../../../packages/daemon/src/__tests__/support/test-device-runtime-gateway.ts';
import { makeSessionStore } from '../../../packages/daemon/src/__tests__/support/store-factory.ts';
import { LeaseRegistry } from '../../../packages/daemon/src/resources/lease-registry.ts';
import {
  makeAndroidDevice,
  openRequest,
} from '../../../packages/daemon/src/server/__tests__/request-router-open-harness.ts';
import { openAndroidApp } from '../../../packages/platform-android/src/app-lifecycle.ts';
import { withAndroidAdbProvider } from '../../../packages/platform-android/src/adb-executor.ts';
import '../../../packages/platform-android/src/__tests__/test-utils/android-host-test-setup.ts';

vi.mock('../../../packages/daemon/src/core/device/device-ready.ts', () => ({
  ensureDeviceReady: vi.fn(async () => {}),
}));
const mockResolveTargetDevice = vi.mocked(getResolveTargetDeviceMock());
function createOpenHandler(sessionStore: ReturnType<typeof makeSessionStore>) {
  return createRequestHandler({
    host: createTestHostEnvironment(),
    createCommandSurface: fakeCreateCommandSurface,
    logPath: path.join(mkdtempForTestSync('daemon'), 'daemon.log'),
    token: 'test-token',
    sessionStore,
    leaseRegistry: new LeaseRegistry(),
    deviceRuntimeGateway: lifecycleDeviceRuntimeGateway,
    deviceInventoryGateways: createTestDeviceInventoryGateways(),
    trackDownloadableArtifact: () => 'artifact-id',
  });
}

test('open relaunch retains Android foreground probe failure in the serialized response and request artifact', async () => {
  const device = makeAndroidDevice('emulator-fence');
  const failure = new AppError(
    'COMMAND_FAILED',
    'probe failed',
    { reason: 'probe-failed' },
    new Error('root cause'),
  );
  let probes = 0;
  try {
    const sessionStore = makeSessionStore('android-fence-request-');
    mockResolveTargetDevice.mockResolvedValue(device);
    vi.mocked(dispatchApplicationLifecycleEffect).mockImplementationOnce(async () => {
      await openAndroidApp(device, 'com.example.app', { terminateRunningApp: true });
    });
    const response = await withAndroidAdbProvider(
      {
        exec: async (args) => {
          if (args[1] === 'dumpsys' && ++probes === 1) throw failure;
          return {
            stdout:
              args[1] === 'dumpsys'
                ? 'mCurrentFocus=Window{42 u0 com.example.app/.Main}\n'
                : '123\n',
            stderr: '',
            exitCode: 0,
          };
        },
      },
      { serial: device.id },
      async () => {
        return await createOpenHandler(sessionStore)(
          openRequest(
            'fence-session',
            { platform: 'android', relaunch: true },
            'fence-request',
            {},
            ['com.example.app'],
          ),
        );
      },
    );
    expect(response.ok).toBe(false);
    if (response.ok) throw new Error('expected failure');
    const wire = JSON.parse(JSON.stringify(response));
    expect(wire.error).toMatchObject({
      code: 'COMMAND_FAILED',
      details: { reason: 'probe-failed' },
    });
    expect(response.error.logPath).toBe(
      path.join(
        sessionStore.resolveDaemonStateDir(),
        'sessions',
        'fence-session',
        'requests',
        'fence-request.ndjson',
      ),
    );
    const events = fs
      .readFileSync(response.error.logPath!, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(events).toContainEqual(
      expect.objectContaining({
        phase: 'android_close_foreground_fence',
        data: {
          initialProcessCount: 1,
          observations: [expect.objectContaining({ result: 'error' })],
        },
      }),
    );
    expect(events).toContainEqual(expect.objectContaining({ phase: 'request_failed' }));
  } finally {
    vi.mocked(dispatchApplicationLifecycleEffect).mockReset();
  }
});
