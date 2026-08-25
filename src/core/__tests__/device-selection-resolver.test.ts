import assert from 'node:assert/strict';
import { test, vi } from 'vitest';
import { AppError } from '@agent-device/kernel/errors';
import {
  ANDROID_EMULATOR,
  IOS_SIMULATOR,
  MACOS_DEVICE,
} from '../../__tests__/test-utils/device-fixtures.ts';
import {
  markSelectionBootOccurred,
  resolveExistingSessionDeviceSelection,
  resolveInventoryDeviceSelection,
} from '../device-selection-resolver.ts';
import {
  SECOND_BOOTED_ANDROID_EMULATOR,
  STOPPED_ANDROID_EMULATOR,
} from './device-selection-fixtures.ts';

const mockFindIosSimulatorInstalledApp = vi.hoisted(() => vi.fn());

vi.mock('../../platforms/apple/core/apps.ts', () => ({
  findIosSimulatorInstalledApp: mockFindIosSimulatorInstalledApp,
}));

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
  mockFindIosSimulatorInstalledApp.mockImplementation(async (device: { id: string }) =>
    device.id === secondBootedSimulator.id ? 'com.example.demo' : undefined,
  );

  const selection = await resolveInventoryDeviceSelection({
    devices: [IOS_SIMULATOR, secondBootedSimulator],
    selector: { platform: 'ios' },
    source: 'local',
    appleSimulatorAppTarget: 'com.example.demo',
  });

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
