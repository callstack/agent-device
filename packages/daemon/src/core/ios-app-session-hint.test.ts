import { daemonPlatformServicesFixture } from '../__tests__/support/platform-services-fixture.ts';
import { beforeEach, expect, test, vi } from 'vitest';
import { IOS_DEVICE, IOS_SIMULATOR } from '@agent-device/test-kit/device-fixtures';
import { buildIosOpenCommandHint } from './ios-app-session-hint.ts';

// The foreground-app probe is stubbed through the port (ADR 0019 section 11), never by mocking
// the platform module behind it.
const resolveSoleForegroundApp = vi.fn();
const platformServices = daemonPlatformServicesFixture({
  appleSessionObservation: {
    observeRunnerSession: async () => undefined,
    resolveSoleForegroundApp,
  },
});

beforeEach(() => {
  resolveSoleForegroundApp.mockReset();
});

test('an unambiguous environment gets the exact runnable open command', async () => {
  const soleBootedDevice = { ...IOS_SIMULATOR, id: 'booted-1', name: 'iPhone 16' };
  resolveSoleForegroundApp.mockResolvedValue({
    device: soleBootedDevice,
    app: { bundleId: 'xyz.blueskyweb.app' },
  });

  const hint = await buildIosOpenCommandHint(IOS_SIMULATOR, platformServices);

  expect(hint).toBe(
    'One booted device found ("iPhone 16", udid booted-1) with xyz.blueskyweb.app running. ' +
      'Run: agent-device open xyz.blueskyweb.app --platform ios --udid booted-1',
  );
  expect(resolveSoleForegroundApp).toHaveBeenCalledWith({ simulatorSetPath: undefined });
});

test('a custom simulator set is echoed back so the printed command is the one that was run', async () => {
  const soleBootedDevice = {
    ...IOS_SIMULATOR,
    id: 'booted-1',
    name: 'iPhone 16',
    simulatorSetPath: '/tmp/agent-device sim set',
  };
  resolveSoleForegroundApp.mockResolvedValue({
    device: soleBootedDevice,
    app: { bundleId: 'xyz.blueskyweb.app' },
  });

  const hint = await buildIosOpenCommandHint(soleBootedDevice, platformServices);

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
  resolveSoleForegroundApp.mockResolvedValue({
    device: soleBootedDevice,
    app: { bundleId: 'xyz.blueskyweb.app' },
  });

  await expect(
    buildIosOpenCommandHint(soleBootedDevice, platformServices),
  ).resolves.toBeUndefined();
});

test('an inconclusive observation keeps the generic hint', async () => {
  resolveSoleForegroundApp.mockResolvedValue(undefined);
  await expect(buildIosOpenCommandHint(IOS_SIMULATOR, platformServices)).resolves.toBeUndefined();
});

test('control-flow failures from the observation port propagate', async () => {
  const canceled = new DOMException('This operation was aborted', 'AbortError');
  resolveSoleForegroundApp.mockRejectedValue(canceled);
  await expect(buildIosOpenCommandHint(IOS_SIMULATOR, platformServices)).rejects.toBe(canceled);
});

test('a physical iOS device never probes for a hint', async () => {
  await expect(buildIosOpenCommandHint(IOS_DEVICE, platformServices)).resolves.toBeUndefined();
  expect(resolveSoleForegroundApp).not.toHaveBeenCalled();
});
