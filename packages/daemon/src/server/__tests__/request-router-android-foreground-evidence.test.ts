import { test, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createTestDeviceInventoryGateways } from '@agent-device/device-selection/inventory-gateways-fixtures';
import { createTestHostEnvironment, mkdtempForTestSync } from '@agent-device/test-kit';
import { AppError } from '@agent-device/kernel/errors';
import { getResolveTargetDeviceMock } from '../../__tests__/support/request-router-dispatch-mocks.ts';
import { fakeCreateCommandSurface } from '../../__tests__/support/command-surface-fake.ts';
import { dispatchApplicationLifecycleEffect } from '../../__tests__/support/application-lifecycle-runtime-fixture.ts';
import {
  createRequestHandler,
  lifecycleDeviceRuntimeGateway,
} from '../../__tests__/support/test-device-runtime-gateway.ts';
import { makeSessionStore } from '../../__tests__/support/store-factory.ts';
import { LeaseRegistry } from '../../resources/lease-registry.ts';
import { makeAndroidDevice, openRequest } from './request-router-open-harness.ts';
import { emitDiagnostic } from '@agent-device/host-kit/diagnostics';

vi.mock('../../core/device/device-ready.ts', () => ({
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
  try {
    const sessionStore = makeSessionStore('android-fence-request-');
    mockResolveTargetDevice.mockResolvedValue(device);
    vi.mocked(dispatchApplicationLifecycleEffect).mockImplementationOnce(async () => {
      emitDiagnostic({
        phase: 'android_close_foreground_fence',
        data: {
          initialProcessCount: 1,
          observations: [{ startMs: 0, endMs: 10, remainingMs: 1990, result: 'error' }],
        },
      });
      throw failure;
    });
    const response = await createOpenHandler(sessionStore)(
      openRequest('fence-session', { platform: 'android', relaunch: true }, 'fence-request', {}, [
        'com.example.app',
      ]),
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
        `${response.error.diagnosticsRecord?.requestId}.ndjson`,
      ),
    );
    // The daemon names the record. The caller's request id names no file.
    expect(response.error.diagnosticsRecord?.requestId).toMatch(/^[a-f0-9]{32}-unleased$/);
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
          observations: [{ startMs: 0, endMs: 10, remainingMs: 1990, result: 'error' }],
        },
      }),
    );
    expect(events).toContainEqual(expect.objectContaining({ phase: 'request_failed' }));
  } finally {
    vi.mocked(dispatchApplicationLifecycleEffect).mockReset();
  }
});
