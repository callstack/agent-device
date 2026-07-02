import { test, expect, vi, beforeEach } from 'vitest';

// The `devices` handler resolves its inventory through listDeviceInventory; mocking it
// lets us drive the additive `appleOs` projection off the shared device fixtures without
// touching real local discovery.
vi.mock('../../../core/dispatch-resolve.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../core/dispatch-resolve.ts')>();
  return { ...actual, listDeviceInventory: vi.fn(async () => []) };
});

import { handleSessionInventoryCommands } from '../session-inventory.ts';
import { listDeviceInventory } from '../../../core/dispatch-resolve.ts';
import { makeSessionStore } from '../../../__tests__/test-utils/store-factory.ts';
import type { DaemonRequest, DaemonResponse } from '../../types.ts';
import type { AppleOS, DeviceInfo } from '../../../kernel/device.ts';
import {
  ANDROID_EMULATOR,
  IOS_SIMULATOR,
  IPADOS_SIMULATOR,
  MACOS_DEVICE,
  TVOS_SIMULATOR,
  VISIONOS_SIMULATOR,
} from '../../../__tests__/test-utils/device-fixtures.ts';

const mockListDeviceInventory = vi.mocked(listDeviceInventory);

beforeEach(() => {
  mockListDeviceInventory.mockReset();
});

type PublicDevice = { id: string; platform: string; appleOs?: AppleOS };

async function runDevices(): Promise<DaemonResponse | null> {
  const req: DaemonRequest = {
    token: 't',
    session: 'default',
    command: 'devices',
    positionals: [],
    flags: {},
  };
  return handleSessionInventoryCommands({
    req,
    sessionName: 'default',
    sessionStore: makeSessionStore('agent-device-inventory-appleos-'),
  });
}

async function listPublicDevices(inventory: DeviceInfo[]): Promise<PublicDevice[]> {
  mockListDeviceInventory.mockResolvedValue(inventory);
  const response = await runDevices();
  expect(response?.ok).toBe(true);
  if (!response?.ok) throw new Error('expected devices to succeed');
  return response.data?.devices as PublicDevice[];
}

test('devices surfaces the appleOs discriminant per Apple fixture', async () => {
  const devices = await listPublicDevices([
    IOS_SIMULATOR,
    IPADOS_SIMULATOR,
    TVOS_SIMULATOR,
    VISIONOS_SIMULATOR,
    MACOS_DEVICE,
  ]);

  const byId = new Map(devices.map((device) => [device.id, device]));
  const expected: Array<[string, AppleOS, string]> = [
    [IOS_SIMULATOR.id, 'ios', 'ios'],
    [IPADOS_SIMULATOR.id, 'ipados', 'ios'],
    [TVOS_SIMULATOR.id, 'tvos', 'ios'],
    [VISIONOS_SIMULATOR.id, 'visionos', 'ios'],
    [MACOS_DEVICE.id, 'macos', 'macos'],
  ];

  for (const [id, appleOs, leaf] of expected) {
    const device = byId.get(id);
    expect(device, `expected device ${id} in output`).toBeTruthy();
    // The additive `appleOs` carries the specific Apple OS ...
    expect(device?.appleOs).toBe(appleOs);
    // ... while `platform` stays the PUBLIC leaf (never the internal `apple`).
    expect(device?.platform).toBe(leaf);
    expect(device?.platform).not.toBe('apple');
  }
});

test('devices omits appleOs for non-Apple devices', async () => {
  const devices = await listPublicDevices([ANDROID_EMULATOR, IOS_SIMULATOR]);

  const android = devices.find((device) => device.id === ANDROID_EMULATOR.id);
  expect(android?.platform).toBe('android');
  expect(android && 'appleOs' in android).toBe(false);

  const ios = devices.find((device) => device.id === IOS_SIMULATOR.id);
  expect(ios?.appleOs).toBe('ios');
});

test('devices drops a stray appleOs on a non-Apple device (gated to Apple platforms)', async () => {
  // Regression: appleOs is Apple-only. A malformed/legacy NON-Apple record carrying a
  // valid Apple OS value must NOT surface it — the projection gates on the platform,
  // not merely on field presence.
  const androidWithStrayAppleOs: DeviceInfo = { ...ANDROID_EMULATOR, appleOs: 'macos' };
  const devices = await listPublicDevices([androidWithStrayAppleOs]);
  const android = devices.find((device) => device.id === ANDROID_EMULATOR.id);
  expect(android?.platform).toBe('android');
  expect(android && 'appleOs' in android).toBe(false);
});
