import { beforeEach, expect, test, vi } from 'vitest';

const listBootedIosSimulators = vi.hoisted(() => vi.fn());
const detectSoleRunningIosSimulatorApp = vi.hoisted(() => vi.fn());

vi.mock('../platforms/apple/core/devices.ts', () => ({ listBootedIosSimulators }));
vi.mock('../platforms/apple/core/app-resolution.ts', () => ({ detectSoleRunningIosSimulatorApp }));

import { IOS_DEVICE, IOS_SIMULATOR } from '../__tests__/test-utils/index.ts';
import { buildIosOpenCommandHint } from './ios-app-session-hint.ts';

beforeEach(() => {
  listBootedIosSimulators.mockReset();
  detectSoleRunningIosSimulatorApp.mockReset();
});

test('an unambiguous environment gets the exact runnable open command', async () => {
  const soleBootedDevice = { ...IOS_SIMULATOR, id: 'booted-1', name: 'iPhone 16' };
  listBootedIosSimulators.mockResolvedValue([soleBootedDevice]);
  detectSoleRunningIosSimulatorApp.mockResolvedValue({
    bundleId: 'xyz.blueskyweb.app',
    name: 'Bluesky',
  });

  const hint = await buildIosOpenCommandHint(IOS_SIMULATOR);

  expect(hint).toBe(
    'One booted device found ("iPhone 16", udid booted-1) with xyz.blueskyweb.app running. ' +
      'Run: agent-device open xyz.blueskyweb.app --platform ios --udid booted-1',
  );
  expect(detectSoleRunningIosSimulatorApp).toHaveBeenCalledWith(soleBootedDevice);
});

test('a custom simulator set is echoed back so the printed command is the one that was run', async () => {
  const soleBootedDevice = {
    ...IOS_SIMULATOR,
    id: 'booted-1',
    name: 'iPhone 16',
    simulatorSetPath: '/tmp/agent-device sim set',
  };
  listBootedIosSimulators.mockResolvedValue([soleBootedDevice]);
  detectSoleRunningIosSimulatorApp.mockResolvedValue({
    bundleId: 'xyz.blueskyweb.app',
    name: 'Bluesky',
  });

  const hint = await buildIosOpenCommandHint(soleBootedDevice);

  expect(hint).toBe(
    'One booted device found ("iPhone 16", udid booted-1) with xyz.blueskyweb.app running. ' +
      'Run: agent-device open xyz.blueskyweb.app --platform ios --udid booted-1 ' +
      "--ios-simulator-device-set '/tmp/agent-device sim set'",
  );
});

test('a hint that would exceed the wire-redaction truncation length falls back to undefined', async () => {
  // A truncated mid-command hint (see redactDiagnosticData in
  // packages/kernel/src/redaction.ts, which silently truncates any details
  // string over 400 chars) is worse than the generic default — it looks
  // actionable but isn't copy-paste-safe.
  const soleBootedDevice = {
    ...IOS_SIMULATOR,
    id: 'booted-1',
    name: 'iPhone 16',
    simulatorSetPath: `/very/long/simulator/set/path/${'segment/'.repeat(30)}`,
  };
  listBootedIosSimulators.mockResolvedValue([soleBootedDevice]);
  detectSoleRunningIosSimulatorApp.mockResolvedValue({
    bundleId: 'xyz.blueskyweb.app',
    name: 'Bluesky',
  });

  await expect(buildIosOpenCommandHint(soleBootedDevice)).resolves.toBeUndefined();
});

test('a rejecting probe (timeout or spawn failure) is caught, not propagated', async () => {
  listBootedIosSimulators.mockRejectedValue(new Error('simctl timed out'));

  await expect(buildIosOpenCommandHint(IOS_SIMULATOR)).resolves.toBeUndefined();
});

test('a rejecting foreground-app probe is caught, not propagated', async () => {
  listBootedIosSimulators.mockResolvedValue([{ ...IOS_SIMULATOR, id: 'booted-1' }]);
  detectSoleRunningIosSimulatorApp.mockRejectedValue(new Error('launchctl timed out'));

  await expect(buildIosOpenCommandHint(IOS_SIMULATOR)).resolves.toBeUndefined();
});

test('more than one booted simulator stays ambiguous and returns no hint', async () => {
  listBootedIosSimulators.mockResolvedValue([
    { ...IOS_SIMULATOR, id: 'booted-1' },
    { ...IOS_SIMULATOR, id: 'booted-2' },
  ]);

  const hint = await buildIosOpenCommandHint(IOS_SIMULATOR);

  expect(hint).toBeUndefined();
  expect(detectSoleRunningIosSimulatorApp).not.toHaveBeenCalled();
});

test('no booted simulator returns no hint', async () => {
  listBootedIosSimulators.mockResolvedValue([]);

  const hint = await buildIosOpenCommandHint(IOS_SIMULATOR);

  expect(hint).toBeUndefined();
  expect(detectSoleRunningIosSimulatorApp).not.toHaveBeenCalled();
});

test('a failed or inconclusive running-app probe returns no hint', async () => {
  listBootedIosSimulators.mockResolvedValue([{ ...IOS_SIMULATOR, id: 'booted-1' }]);
  detectSoleRunningIosSimulatorApp.mockResolvedValue(undefined);

  const hint = await buildIosOpenCommandHint(IOS_SIMULATOR);

  expect(hint).toBeUndefined();
});

test('a physical iOS device never probes for a hint', async () => {
  const hint = await buildIosOpenCommandHint(IOS_DEVICE);

  expect(hint).toBeUndefined();
  expect(listBootedIosSimulators).not.toHaveBeenCalled();
});
