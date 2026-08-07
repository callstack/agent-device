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
    'One booted device found ("iPhone 16", udid booted-1) with xyz.blueskyweb.app in the ' +
      'foreground. Run: agent-device open xyz.blueskyweb.app --platform ios',
  );
  expect(detectSoleRunningIosSimulatorApp).toHaveBeenCalledWith(soleBootedDevice);
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

test('a failed or inconclusive foreground-app probe returns no hint', async () => {
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
