import assert from 'node:assert/strict';
import { beforeEach, test, vi } from 'vitest';

const { mockHasCachedRunnerArtifact, mockPrewarmRunnerCache, mockHostPlatform } = vi.hoisted(
  () => ({
    mockHasCachedRunnerArtifact: vi.fn(),
    mockPrewarmRunnerCache: vi.fn(),
    mockHostPlatform: vi.fn(),
  }),
);

vi.mock('../core/runner-client.ts', () => ({
  hasCachedAppleRunnerArtifact: mockHasCachedRunnerArtifact,
  prewarmAppleRunnerCache: mockPrewarmRunnerCache,
}));
vi.mock('@agent-device/host-kit/process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent-device/host-kit/process')>()),
  hostPlatform: mockHostPlatform,
}));

import type { HostDiagnosticsContext } from '@agent-device/contracts/host-diagnostics';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { IOS_DEVICE, IOS_SIMULATOR, MACOS_DEVICE } from './device-fixtures.ts';
import { appleRunnerWarmupCheck } from '../doctor.ts';

const ANDROID_EMULATOR: DeviceInfo = {
  platform: 'android',
  id: 'emulator-5554',
  name: 'Pixel',
  kind: 'emulator',
  booted: true,
};

function contextWith(isProviderDevice = false): HostDiagnosticsContext {
  return Object.freeze({
    stateDir: '/tmp/state',
    metroPort: 8081,
    shouldProbeMetro: false,
    isProviderDevice: () => isProviderDevice,
    emitProgress: vi.fn(),
    listLocalDeviceInventory: async () => [],
    shouldPropagateInventoryProbeError: () => false,
    transportOverrides: Object.freeze({}),
  });
}

beforeEach(() => {
  mockHasCachedRunnerArtifact.mockReset();
  mockPrewarmRunnerCache.mockReset();
  mockPrewarmRunnerCache.mockResolvedValue(undefined);
  mockHostPlatform.mockReset();
  mockHostPlatform.mockReturnValue('darwin');
});

test('does not warm non-iOS, physical, or provider-backed devices', async () => {
  const context = contextWith();

  assert.equal(await appleRunnerWarmupCheck(ANDROID_EMULATOR, context), undefined);
  assert.equal(await appleRunnerWarmupCheck(MACOS_DEVICE, context), undefined);
  assert.equal(await appleRunnerWarmupCheck(IOS_DEVICE, contextWith(true)), undefined);
  assert.equal(mockHostPlatform.mock.calls.length, 0);
  assert.equal(mockHasCachedRunnerArtifact.mock.calls.length, 0);
  assert.equal(mockPrewarmRunnerCache.mock.calls.length, 0);
});

test('does not warm an iOS simulator on a non-macOS host', async () => {
  mockHostPlatform.mockReturnValue('linux');

  assert.equal(await appleRunnerWarmupCheck(IOS_SIMULATOR, contextWith()), undefined);
  assert.equal(mockHasCachedRunnerArtifact.mock.calls.length, 0);
  assert.equal(mockPrewarmRunnerCache.mock.calls.length, 0);
});

test('reports a cached runner artifact without starting a build', async () => {
  mockHasCachedRunnerArtifact.mockResolvedValue(true);
  const context = contextWith();

  const check = await appleRunnerWarmupCheck(IOS_SIMULATOR, context);

  assert.deepEqual(check, {
    id: 'ios-runner-cache',
    status: 'pass',
    summary: 'iOS runner artifact cached; first open skips the runner build',
  });
  assert.equal(mockPrewarmRunnerCache.mock.calls.length, 0);
});

test('starts a missing runner build opportunistically and reports the wait command', async () => {
  mockHasCachedRunnerArtifact.mockResolvedValue(false);
  const context = contextWith();

  const check = await appleRunnerWarmupCheck(IOS_SIMULATOR, context);

  assert.equal(check?.id, 'ios-runner-cache');
  assert.equal(check?.status, 'pass');
  assert.match(check?.summary ?? '', /started in the background/);
  assert.equal(
    check?.hint,
    'Run `agent-device prepare ios-runner` to wait for a fully warmed runner instead.',
  );
  assert.deepEqual(mockPrewarmRunnerCache.mock.calls, [[IOS_SIMULATOR, {}]]);
});
