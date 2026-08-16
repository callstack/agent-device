import { createTestDeviceInventoryGateways } from '../../__tests__/test-utils/device-inventory-gateways.ts';
/**
 * Custom actions are read through the private-AX snapshot backend, which only
 * the iOS simulator has. Every other target would accept `--actions`, take an
 * ordinary capture, and return nodes with no `actions` — indistinguishable from
 * "this screen has no custom actions". The guard runs after the session device
 * is resolved but before any device work, so a seeded session exercises it
 * without a real device.
 */
import { test, expect } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { createRequestHandler } from './test-device-runtime-gateway.ts';
import { LeaseRegistry } from '../lease-registry.ts';
import { makeSessionStore } from '../../__tests__/test-utils/store-factory.ts';
import type { SessionState } from '../types.ts';
import {
  captureSnapshotUse,
  type DeviceRuntimeGateway,
  type PlatformRuntimeOperations,
} from '@agent-device/contracts/platform';
import { snapshotRuntimeFixture } from './snapshot-runtime-fixture.ts';

function snapshotDeviceRuntimeGateway(): DeviceRuntimeGateway<PlatformRuntimeOperations> {
  const runtime = snapshotRuntimeFixture();
  return {
    inspectFacts: runtime.inspectFacts,
    bind: async ({ device }) => {
      const [facts, binding] = await Promise.all([
        runtime.inspectFacts(device),
        runtime.bindDevice(device, captureSnapshotUse),
      ]);
      return {
        ...binding,
        facts,
        [Symbol.asyncDispose]: async () => {},
      };
    },
    shutdown: async () => {},
  };
}

function handlerForDevice(device: DeviceInfo) {
  const sessionStore = makeSessionStore('agent-device-custom-actions-guard-');
  sessionStore.set('default', {
    name: 'default',
    device,
    appBundleId: 'com.example.app',
  } as SessionState);
  return createRequestHandler({
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    token: 'test-token',
    sessionStore,
    leaseRegistry: new LeaseRegistry(),
    deviceInventoryGateways: createTestDeviceInventoryGateways(),
    deviceRuntimeGateway: snapshotDeviceRuntimeGateway(),
    trackDownloadableArtifact: () => 'artifact-id',
  });
}

async function snapshotWithActions(device: DeviceInfo) {
  return await handlerForDevice(device)({
    token: 'test-token',
    session: 'default',
    command: 'snapshot',
    positionals: [],
    flags: { snapshotCustomActions: true, snapshotInteractiveOnly: true },
  });
}

const nonSimulatorTargets: DeviceInfo[] = [
  { platform: 'android', id: 'emulator-5554', name: 'Pixel', kind: 'emulator' },
  { platform: 'android', id: 'ABC123', name: 'Pixel 9', kind: 'device' },
  { platform: 'apple', id: 'mac', name: 'Mac', kind: 'device', appleOs: 'macos' },
  // An iOS PHYSICAL device is the subtle one: iOS family, but no private-AX backend.
  { platform: 'apple', id: 'udid', name: 'iPhone', kind: 'device', appleOs: 'ios' },
  { platform: 'linux', id: 'local', name: 'Linux', kind: 'device' },
  { platform: 'web', id: 'chrome', name: 'Chrome', kind: 'device' },
];

for (const device of nonSimulatorTargets) {
  test(`--actions is refused on ${device.platform}/${device.kind}/${device.appleOs ?? '-'}`, async () => {
    const response = await snapshotWithActions(device);

    expect(response.ok).toBe(false);
    if (response.ok) return;
    expect(response.error.code).toBe('UNSUPPORTED_OPERATION');
    expect(response.error.message).toMatch(/--actions requires an iOS simulator/);
    // The message has to name the target, or the caller cannot tell which half
    // of the request was impossible.
    expect(response.error.message).toContain(device.platform);
  });
}

test('--actions is not refused on an iOS simulator', async () => {
  const response = await snapshotWithActions({
    platform: 'apple',
    id: 'sim-udid',
    name: 'iPhone 17 Pro',
    kind: 'simulator',
    appleOs: 'ios',
  });

  // It fails later (no real runner behind this seeded session), but never on
  // the platform guard.
  expect(response.ok).toBe(false);
  if (response.ok) return;
  expect(response.error.message).not.toMatch(/requires an iOS simulator/);
});
