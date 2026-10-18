import { expect, test, vi } from 'vitest';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { resolveFrontmostMacOsApp } from '@agent-device/platform-apple/macos';
import {
  prepareIosRunner,
  prewarmIosRunnerSession,
} from '@agent-device/platform-apple/runner/operations';
import { createAppleApplicationTools } from './platform-runtime-apple-application-tools.ts';

vi.mock('@agent-device/platform-apple/macos', () => ({
  resolveFrontmostMacOsApp: vi.fn(),
  runMacOsAlertAction: vi.fn(),
}));
vi.mock('@agent-device/platform-apple/runner/operations', () => ({
  prepareIosRunner: vi.fn(async () => ({
    runner: { currentUptimeMs: 42 },
    connectMs: 3,
    healthCheckMs: 3,
  })),
  prewarmIosRunnerSession: vi.fn(async () => {}),
}));

const mockResolveFrontmostMacOsApp = vi.mocked(resolveFrontmostMacOsApp);
const mockPrepareIosRunner = vi.mocked(prepareIosRunner);
const mockPrewarmIosRunnerSession = vi.mocked(prewarmIosRunnerSession);

const iosSimulator: DeviceInfo = {
  platform: 'apple',
  appleOs: 'ios',
  id: 'sim-1',
  name: 'iPhone 17 Pro',
  kind: 'simulator',
  booted: true,
};

const macOsDevice: DeviceInfo = {
  platform: 'apple',
  appleOs: 'macos',
  id: 'host-macos-local',
  name: 'Host Mac',
  kind: 'device',
  target: 'desktop',
  booted: true,
};

test('the runner session prewarm forwards the request execution, signal, and error policy to the runner module', async () => {
  const signal = new AbortController().signal;

  await createAppleApplicationTools(process.env).prewarmRunnerSession(
    iosSimulator,
    { requestId: 'req-1', logPath: '/tmp/daemon.log', verbose: true },
    signal,
    false,
  );

  expect(mockPrewarmIosRunnerSession).toHaveBeenCalledExactlyOnceWith(
    iosSimulator,
    expect.objectContaining({
      requestId: 'req-1',
      logPath: '/tmp/daemon.log',
      verbose: true,
      propagateError: false,
      signal,
    }),
  );
});

test('preparing the runner spends the requested budget on stale-bundle cleanup, build, health, and startup', async () => {
  const signal = new AbortController().signal;

  const result = await createAppleApplicationTools(process.env).prepareRunner(
    iosSimulator,
    {
      timeoutMs: 240_000,
      execution: { requestId: 'prepare-request', logPath: '/tmp/state/runner.log' },
    },
    signal,
  );

  expect(result).toEqual({ runner: { currentUptimeMs: 42 }, connectMs: 3, healthCheckMs: 3 });
  expect(mockPrepareIosRunner).toHaveBeenCalledExactlyOnceWith(
    iosSimulator,
    expect.objectContaining({
      cleanStaleBundles: true,
      requestId: 'prepare-request',
      logPath: '/tmp/state/runner.log',
      buildTimeoutMs: 240_000,
      healthTimeoutMs: 240_000,
      startupTimeoutMs: 240_000,
      prepareDeadline: expect.objectContaining({
        elapsedMs: expect.any(Function),
        isExpired: expect.any(Function),
        remainingMs: expect.any(Function),
      }),
      signal,
    }),
  );
});

test('a macOS frontmost-app open resolves the identity of the frontmost application', async () => {
  mockResolveFrontmostMacOsApp.mockResolvedValueOnce({
    bundleId: 'com.apple.TextEdit',
    appName: 'TextEdit',
    pid: 123,
  });

  await expect(
    createAppleApplicationTools(process.env).resolveOpenTarget(macOsDevice, {
      surface: 'frontmost-app',
      currentAppBundleId: 'com.apple.TextEdit',
    }),
  ).resolves.toEqual({ appBundleId: 'com.apple.TextEdit', appName: 'TextEdit' });
  expect(mockResolveFrontmostMacOsApp).toHaveBeenCalledOnce();
});
