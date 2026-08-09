import { AppError } from '@agent-device/kernel/errors';
import { beforeEach, expect, test, vi } from 'vitest';

const listBootedIosSimulators = vi.hoisted(() => vi.fn());
const detectSoleRunningIosSimulatorApp = vi.hoisted(() => vi.fn());

vi.mock('../core/device-inventory-context.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../core/device-inventory-context.ts')>()),
  listLocalDeviceInventory: listBootedIosSimulators,
}));
vi.mock('../platforms/apple/core/app-resolution.ts', () => ({ detectSoleRunningIosSimulatorApp }));

import { IOS_DEVICE, IOS_SIMULATOR } from '../__tests__/test-utils/index.ts';
import { buildIosOpenCommandHint, resolveSoleForegroundIosApp } from './ios-app-session-hint.ts';

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

test('request cancellation from the inventory probe is propagated', async () => {
  const canceled = new AppError('COMMAND_FAILED', 'request canceled', {
    reason: 'request_canceled',
  });
  listBootedIosSimulators.mockRejectedValue(canceled);

  await expect(buildIosOpenCommandHint(IOS_SIMULATOR)).rejects.toBe(canceled);
});

test('abort control flow from the foreground-app probe is propagated', async () => {
  const canceled = new DOMException('This operation was aborted', 'AbortError');
  listBootedIosSimulators.mockResolvedValue([{ ...IOS_SIMULATOR, id: 'booted-1' }]);
  detectSoleRunningIosSimulatorApp.mockRejectedValue(canceled);

  await expect(buildIosOpenCommandHint(IOS_SIMULATOR)).rejects.toBe(canceled);
});

test('missing inventory-context wiring is propagated', async () => {
  const unavailable = new AppError(
    'COMMAND_FAILED',
    'Device inventory gateway is unavailable outside request execution',
    { reason: 'device_inventory_context_unavailable' },
  );
  listBootedIosSimulators.mockRejectedValue(unavailable);

  await expect(buildIosOpenCommandHint(IOS_SIMULATOR)).rejects.toBe(unavailable);
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

test('resolveSoleForegroundIosApp resolves the device and app when unambiguous', async () => {
  const soleBootedDevice = { ...IOS_SIMULATOR, id: 'booted-1', name: 'iPhone 16' };
  const app = { bundleId: 'xyz.blueskyweb.app', name: 'Bluesky' };
  listBootedIosSimulators.mockResolvedValue([soleBootedDevice]);
  detectSoleRunningIosSimulatorApp.mockResolvedValue(app);

  const resolved = await resolveSoleForegroundIosApp({ simulatorSetPath: '/custom/set' });

  expect(resolved).toEqual({ device: soleBootedDevice, app });
  expect(listBootedIosSimulators).toHaveBeenCalledWith({
    platform: 'ios',
    iosSimulatorSetPath: '/custom/set',
    kind: 'simulator',
    booted: true,
  });
  expect(detectSoleRunningIosSimulatorApp).toHaveBeenCalledWith(soleBootedDevice);
});

test('resolveSoleForegroundIosApp returns undefined for zero booted simulators', async () => {
  listBootedIosSimulators.mockResolvedValue([]);

  expect(await resolveSoleForegroundIosApp()).toBeUndefined();
  expect(detectSoleRunningIosSimulatorApp).not.toHaveBeenCalled();
});

test('resolveSoleForegroundIosApp returns undefined for more than one booted simulator', async () => {
  listBootedIosSimulators.mockResolvedValue([
    { ...IOS_SIMULATOR, id: 'booted-1' },
    { ...IOS_SIMULATOR, id: 'booted-2' },
  ]);

  expect(await resolveSoleForegroundIosApp()).toBeUndefined();
  expect(detectSoleRunningIosSimulatorApp).not.toHaveBeenCalled();
});

test('resolveSoleForegroundIosApp returns undefined when the running-app probe is inconclusive', async () => {
  listBootedIosSimulators.mockResolvedValue([{ ...IOS_SIMULATOR, id: 'booted-1' }]);
  detectSoleRunningIosSimulatorApp.mockResolvedValue(undefined);

  expect(await resolveSoleForegroundIosApp()).toBeUndefined();
});

test('resolveSoleForegroundIosApp catches a rejecting probe instead of propagating it', async () => {
  // The catch-all lives in the resolver, so both consumers (the hint and
  // open --foreground) inherit the never-propagate contract from one place.
  listBootedIosSimulators.mockRejectedValue(new Error('simctl timed out'));

  await expect(resolveSoleForegroundIosApp()).resolves.toBeUndefined();

  listBootedIosSimulators.mockResolvedValue([{ ...IOS_SIMULATOR, id: 'booted-1' }]);
  detectSoleRunningIosSimulatorApp.mockRejectedValue(new Error('launchctl timed out'));

  await expect(resolveSoleForegroundIosApp()).resolves.toBeUndefined();
});
