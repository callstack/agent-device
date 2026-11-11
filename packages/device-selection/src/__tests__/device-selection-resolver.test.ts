import assert from 'node:assert/strict';
import { test, vi } from 'vitest';
import { AppError } from '@agent-device/kernel/errors';
import type { DeviceInfo } from '@agent-device/kernel/device';
import {
  markSelectionBootOccurred,
  resolveExistingSessionDeviceSelection,
  resolveInventoryDeviceSelection,
} from '../device-selection-resolver.ts';
import { withTestDeviceInventory } from '../inventory-gateways.fixtures.ts';
import {
  ANDROID_EMULATOR,
  IOS_SIMULATOR,
  MACOS_DEVICE,
  SECOND_BOOTED_ANDROID_EMULATOR,
  STOPPED_ANDROID_EMULATOR,
} from './device-selection-fixtures.ts';

test('explicit identity selector wins before local inference', async () => {
  const selection = await resolveInventoryDeviceSelection({
    devices: [ANDROID_EMULATOR, SECOND_BOOTED_ANDROID_EMULATOR],
    selector: { platform: 'android', serial: SECOND_BOOTED_ANDROID_EMULATOR.id },
    source: 'local',
  });

  assert.equal(selection.device.id, SECOND_BOOTED_ANDROID_EMULATOR.id);
  assert.equal(selection.reason, 'explicit-selector');
  assert.equal(selection.candidateCount, 1);
});

test('a single booted local candidate wins and reports its precedence reason', async () => {
  const selection = await resolveInventoryDeviceSelection({
    devices: [IOS_SIMULATOR, { ...IOS_SIMULATOR, id: 'sim-stopped', booted: false }],
    selector: { platform: 'ios' },
    source: 'local',
  });

  assert.equal(selection.device.id, IOS_SIMULATOR.id);
  assert.equal(selection.reason, 'single-booted-local');
});

test('a single bootable local candidate is selectable without a preliminary devices call', async () => {
  const selection = await resolveInventoryDeviceSelection({
    devices: [STOPPED_ANDROID_EMULATOR],
    selector: { platform: 'android' },
    source: 'local',
  });

  assert.equal(selection.device.id, STOPPED_ANDROID_EMULATOR.id);
  assert.equal(selection.reason, 'single-bootable-local');
  assert.equal(selection.bootOccurred, false);
});

test('the booted simulator with the app installed carries its own selected-by reason', async () => {
  const secondBootedSimulator = { ...IOS_SIMULATOR, id: 'sim-2', name: 'iPhone 17' };
  const findInstalledApp = vi.fn(async (device: DeviceInfo) =>
    device.id === secondBootedSimulator.id ? 'com.example.demo' : undefined,
  );

  const selection = await withTestDeviceInventory(
    { findInstalledApp },
    async () =>
      await resolveInventoryDeviceSelection({
        devices: [IOS_SIMULATOR, secondBootedSimulator],
        selector: { platform: 'ios' },
        source: 'local',
        appleSimulatorAppTarget: 'com.example.demo',
      }),
  );

  assert.equal(selection.device.id, secondBootedSimulator.id);
  assert.equal(selection.reason, 'single-app-installed-local');
  assert.equal(selection.candidateCount, 1);
  assert.equal(selection.source, 'local');
});

test('successful local virtual preparation records the boot event without changing provider evidence', () => {
  const localSelection = markSelectionBootOccurred({
    device: STOPPED_ANDROID_EMULATOR,
    reason: 'single-bootable-local',
    source: 'local',
    candidateCount: 1,
    bootOccurred: false,
  });
  const bootedSelection = markSelectionBootOccurred({
    device: SECOND_BOOTED_ANDROID_EMULATOR,
    reason: 'single-booted-local',
    source: 'local',
    candidateCount: 1,
    bootOccurred: false,
  });
  const providerSelection = markSelectionBootOccurred({
    device: { ...STOPPED_ANDROID_EMULATOR, kind: 'device' },
    reason: 'single-provider-device',
    source: 'provider',
    candidateCount: 1,
    bootOccurred: false,
  });

  assert.equal(localSelection?.bootOccurred, true);
  assert.equal(bootedSelection?.bootOccurred, false);
  assert.equal(providerSelection?.bootOccurred, false);
});

test('multiple equally eligible local candidates fail with structured retry selectors', async () => {
  await assert.rejects(
    () =>
      resolveInventoryDeviceSelection({
        devices: [ANDROID_EMULATOR, SECOND_BOOTED_ANDROID_EMULATOR],
        selector: { platform: 'android' },
        source: 'local',
      }),
    (error: unknown) =>
      error instanceof AppError &&
      error.code === 'AMBIGUOUS_MATCH' &&
      Array.isArray(error.details?.retrySelectors) &&
      error.details.retrySelectors.some(
        (selector) => selector.flag === '--serial' && selector.value === ANDROID_EMULATOR.id,
      ),
  );
});

test('no compatible candidate fails closed without substituting another platform', async () => {
  await assert.rejects(
    () =>
      resolveInventoryDeviceSelection({
        devices: [IOS_SIMULATOR],
        selector: { platform: 'android' },
        source: 'local',
      }),
    (error: unknown) => error instanceof AppError && error.code === 'DEVICE_NOT_FOUND',
  );
});

test('provider inference only accepts one authoritative candidate', async () => {
  const selection = await resolveInventoryDeviceSelection({
    devices: [ANDROID_EMULATOR],
    selector: { platform: 'android' },
    source: 'provider',
  });

  assert.equal(selection.reason, 'single-provider-device');
  assert.equal(selection.source, 'provider');

  await assert.rejects(
    () =>
      resolveInventoryDeviceSelection({
        devices: [ANDROID_EMULATOR, SECOND_BOOTED_ANDROID_EMULATOR],
        selector: { platform: 'android' },
        source: 'provider',
      }),
    (error: unknown) => error instanceof AppError && error.code === 'AMBIGUOUS_MATCH',
  );
});

test('existing session binding is a distinct highest-precedence selection', () => {
  const selection = resolveExistingSessionDeviceSelection(MACOS_DEVICE);

  assert.deepEqual(selection, {
    device: MACOS_DEVICE,
    reason: 'existing-session',
    source: 'session',
    candidateCount: 1,
    bootOccurred: false,
  });
});

const shutDownSimulator = (id: string, name: string, osVersion: string): DeviceInfo => ({
  platform: 'apple',
  id,
  name,
  kind: 'simulator',
  target: 'mobile',
  appleOs: 'ios',
  osVersion,
  booted: false,
});

// ENG-1037: a stock Xcode install ships several shut-down iPhones of one runtime.
const STOCK_SIMULATORS: DeviceInfo[] = [
  shutDownSimulator('sim-17-pro', 'iPhone 17 Pro', '26.5'),
  shutDownSimulator('sim-17', 'iPhone 17', '26.5'),
  { ...shutDownSimulator('ipad-pro', 'iPad Pro 13-inch (M5)', '26.5'), appleOs: 'ipados' },
];

const namesPickHint = (error: unknown) =>
  error instanceof AppError &&
  error.code === 'AMBIGUOUS_MATCH' &&
  String(error.details?.hint).includes('--pick newest');

test.each([
  ['a boot without --pick', { boot: {} }, true],
  ['any other command', {}, false],
])('a shut-down tie fails, naming --pick newest only for %s', async (_label, intent, named) => {
  await assert.rejects(
    () =>
      resolveInventoryDeviceSelection({
        devices: STOCK_SIMULATORS,
        selector: { platform: 'ios' },
        source: 'local',
        ...intent,
      }),
    (error: unknown) =>
      error instanceof AppError &&
      error.code === 'AMBIGUOUS_MATCH' &&
      namesPickHint(error) === named,
  );
});

test('boot --pick newest settles a tie between shut-down devices that otherwise fails', async () => {
  const selection = await resolveInventoryDeviceSelection({
    devices: STOCK_SIMULATORS,
    selector: { platform: 'ios' },
    source: 'local',
    boot: { pick: 'newest' },
  });

  assert.equal(selection.device.id, 'sim-17');
  assert.equal(selection.reason, 'newest-bootable-local');
  assert.equal(selection.candidateCount, 3);
});

test('boot --pick newest orders OS versions numerically before names', async () => {
  const selection = await resolveInventoryDeviceSelection({
    devices: [
      shutDownSimulator('older', 'iPhone 16', '26.9'),
      shutDownSimulator('newer', 'iPhone 17', '26.10'),
    ],
    selector: { platform: 'ios' },
    source: 'local',
    boot: { pick: 'newest' },
  });

  assert.equal(selection.device.id, 'newer');
});

test.each(['26.5', '27.0'])(
  'boot --pick newest prefers iPhones to visionOS at runtime %s',
  async (visionVersion) => {
    const vision = {
      ...shutDownSimulator('vision', 'Apple Vision Pro', visionVersion),
      appleOs: 'visionos' as const,
    };
    const selection = await resolveInventoryDeviceSelection({
      devices: [
        vision,
        shutDownSimulator('iphone', 'iPhone 17', '26.5'),
        shutDownSimulator('iphone-2', 'iPhone 18', '26.5'),
      ],
      selector: { platform: 'ios' },
      source: 'local',
      boot: { pick: 'newest' },
    });

    assert.equal(selection.device.id, 'iphone');
    assert.equal(selection.reason, 'newest-bootable-local');
  },
);

test('boot --pick newest prefers iPads to visionOS when no iPhone is available', async () => {
  const selection = await resolveInventoryDeviceSelection({
    devices: [
      { ...shutDownSimulator('vision', 'Apple Vision Pro', '27.0'), appleOs: 'visionos' },
      { ...shutDownSimulator('ipad', 'iPad Air', '26.5'), appleOs: 'ipados' },
      { ...shutDownSimulator('ipad-2', 'iPad Pro', '26.5'), appleOs: 'ipados' },
    ],
    selector: { platform: 'ios' },
    source: 'local',
    boot: { pick: 'newest' },
  });

  assert.equal(selection.device.id, 'ipad');
  assert.equal(selection.reason, 'newest-bootable-local');
});

test('ordinary selection remains ambiguous between equally preferred iPhones alongside visionOS', async () => {
  await assert.rejects(
    () =>
      resolveInventoryDeviceSelection({
        devices: [
          { ...shutDownSimulator('vision', 'Apple Vision Pro', '27.0'), appleOs: 'visionos' },
          shutDownSimulator('iphone', 'iPhone 17', '26.5'),
          shutDownSimulator('iphone-2', 'iPhone 18', '26.5'),
        ],
        selector: { platform: 'ios' },
        source: 'local',
        boot: {},
      }),
    (error: unknown) => error instanceof AppError && error.code === 'AMBIGUOUS_MATCH',
  );
});

test('visionOS remains selectable alone and by explicit name or UDID', async () => {
  const vision = {
    ...shutDownSimulator('vision', 'Apple Vision Pro', '27.0'),
    appleOs: 'visionos' as const,
  };
  const phone = shutDownSimulator('iphone', 'iPhone 17', '26.5');
  for (const [devices, selector] of [
    [[vision], { platform: 'ios' as const }],
    [[phone, vision], { platform: 'ios' as const, deviceName: vision.name }],
    [[phone, vision], { platform: 'ios' as const, udid: vision.id }],
  ] as const) {
    const selection = await resolveInventoryDeviceSelection({
      devices: [...devices],
      selector,
      source: 'local',
      boot: { pick: 'newest' },
    });
    assert.equal(selection.device.id, vision.id);
  }
});

test('boot --pick newest never overrides an already booted preferred device', async () => {
  const booted = { ...shutDownSimulator('booted-older', 'iPhone 16', '18.6'), booted: true };
  const selection = await resolveInventoryDeviceSelection({
    devices: [shutDownSimulator('newer', 'iPhone 17', '26.5'), booted],
    selector: { platform: 'ios' },
    source: 'local',
    boot: { pick: 'newest' },
  });

  assert.equal(selection.device.id, booted.id);
  assert.equal(selection.reason, 'single-booted-local');
});

test.each([{ pick: 'newest' as const }, {}])(
  'a booted tie stays ambiguous and never suggests --pick (boot %j)',
  async (boot) => {
    await assert.rejects(
      () =>
        resolveInventoryDeviceSelection({
          devices: STOCK_SIMULATORS.map((device) => ({ ...device, booted: true })),
          selector: { platform: 'ios' },
          source: 'local',
          boot,
        }),
      (error: unknown) =>
        error instanceof AppError && error.code === 'AMBIGUOUS_MATCH' && !namesPickHint(error),
    );
  },
);

test('boot --pick newest prefers a mobile AVD over a TV AVD that sorts first by name', async () => {
  const selection = await resolveInventoryDeviceSelection({
    devices: [
      { ...STOPPED_ANDROID_EMULATOR, id: 'Android_TV', name: 'Android_TV', target: 'tv' },
      STOPPED_ANDROID_EMULATOR,
    ],
    selector: { platform: 'android' },
    source: 'local',
    boot: { pick: 'newest' },
  });

  assert.equal(selection.device.id, STOPPED_ANDROID_EMULATOR.id);
});

test.each([{ pick: 'newest' as const }, {}])(
  'a boot never picks between provider devices nor suggests --pick (boot %j)',
  async (boot) => {
    await assert.rejects(
      () =>
        resolveInventoryDeviceSelection({
          devices: STOCK_SIMULATORS,
          selector: { platform: 'ios' },
          source: 'provider',
          boot,
        }),
      (error: unknown) =>
        error instanceof AppError && error.code === 'AMBIGUOUS_MATCH' && !namesPickHint(error),
    );
  },
);
