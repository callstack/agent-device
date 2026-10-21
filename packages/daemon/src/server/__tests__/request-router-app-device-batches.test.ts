import path from 'node:path';
import { beforeEach, expect, test, vi } from 'vitest';
import { getResolveTargetDeviceMock } from '../../__tests__/support/request-router-dispatch-mocks.ts';
import { fakeCreateCommandSurface } from '../../__tests__/support/command-surface-fake.ts';

vi.mock('../../core/device/device-ready.ts', () => ({ ensureDeviceReady: vi.fn(async () => {}) }));

import { hostAppDevice, type DeviceInfo } from '@agent-device/kernel/device';
import {
  MACOS_DEVICE,
  createTestHostEnvironment,
  mkdtempForTestSync,
} from '@agent-device/test-kit';
import { createTestDeviceInventoryGateways } from '@agent-device/device-selection/inventory-gateways-fixtures';
import {
  createRequestHandler,
  lifecycleDeviceRuntimeGateway,
} from '../../__tests__/support/test-device-runtime-gateway.ts';
import { makeMacOsSession } from '../../__tests__/support/session-factories.ts';
import { makeSessionStore } from '../../__tests__/support/store-factory.ts';
import { LeaseRegistry } from '../../resources/lease-registry.ts';
import type { DaemonRequest } from '../../core/daemon-request.ts';

const mockResolveTargetDevice = vi.mocked(getResolveTargetDeviceMock());
const APPS = ['com.example.one', 'com.example.two'] as const;

beforeEach(() => {
  mockResolveTargetDevice.mockReset();
  // As the native selection does: an open that names an app selects that app's device.
  mockResolveTargetDevice.mockImplementation(async (_flags, options) =>
    options?.appDeviceTarget ? hostAppDevice(MACOS_DEVICE, options.appDeviceTarget) : MACOS_DEVICE,
  );
});

function appSession(bundleId: string) {
  const device: DeviceInfo = hostAppDevice(MACOS_DEVICE, bundleId);
  return makeMacOsSession(bundleId, { device, appBundleId: bundleId, surface: 'app' });
}

/** A batch in the session on `from` that closes it and opens `to` in the same session. */
function switchApps(from: string, to: string): DaemonRequest {
  return {
    token: 'test-token',
    session: from,
    command: 'batch',
    positionals: [],
    flags: {
      batchSteps: [
        { command: 'close' },
        { command: 'open', positionals: [to], flags: { platform: 'macos' } },
      ],
    },
    meta: { requestId: `switch-${from}`, sessionExplicit: true },
  };
}

test('batches in two app sessions that each open the other app finish instead of deadlocking', async () => {
  const sessionStore = makeSessionStore('agent-device-app-device-batches-');
  for (const bundleId of APPS) sessionStore.publish(bundleId, appSession(bundleId));
  const handler = createRequestHandler({
    host: createTestHostEnvironment(),
    createCommandSurface: fakeCreateCommandSurface,
    logPath: path.join(mkdtempForTestSync('daemon'), 'daemon.log'),
    token: 'test-token',
    sessionStore,
    leaseRegistry: new LeaseRegistry(),
    deviceRuntimeGateway: lifecycleDeviceRuntimeGateway,
    deviceInventoryGateways: createTestDeviceInventoryGateways({
      local: async () => [MACOS_DEVICE],
    }),
    trackDownloadableArtifact: () => 'artifact-id',
  });

  // Each batch holds its own app device's lock for its whole run, so each step that opens the
  // other app meets a lock the other batch holds.
  const responses = await Promise.all([
    handler(switchApps(APPS[0], APPS[1])),
    handler(switchApps(APPS[1], APPS[0])),
  ]);

  for (const response of responses) {
    expect(response.ok).toBe(false);
    expect(JSON.stringify(response)).toContain('DEVICE_EXECUTION_LOCK_BUSY');
  }
});
