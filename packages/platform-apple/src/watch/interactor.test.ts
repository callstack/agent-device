import { beforeEach, expect, test, vi } from 'vitest';
import type { DeviceInfo } from '@agent-device/kernel/device';
import type { RunnerContext } from '@agent-device/contracts/interactor-types';

const { runAppleToolCommand, runSimctlForDevice } = vi.hoisted(() => ({
  runAppleToolCommand: vi.fn(async () => ({ stdout: '', stderr: '', exitCode: 0 })),
  runSimctlForDevice: vi.fn(async () => ({
    stdout:
      'Default width: 396\nDefault height: 484\nPreferred UI Scale: 2\ncom.apple.CoreSimulator.HID.LegacyHID',
    stderr: '',
    exitCode: 0,
  })),
}));

vi.mock('../core/app-launch.ts', () => ({
  openIosApp: vi.fn(),
  closeIosApp: vi.fn(),
  openIosDevice: vi.fn(),
}));
vi.mock('../core/screenshot.ts', () => ({ captureSimulatorScreenshotWithRetry: vi.fn() }));
vi.mock('../core/simulator.ts', () => ({ ensureBootedSimulator: vi.fn(async () => undefined) }));
vi.mock('../core/tool-provider.ts', () => ({ runAppleToolCommand }));
vi.mock('../core/simctl.ts', () => ({ runSimctlForDevice }));
vi.mock('./watch-helper-cache.ts', () => ({
  ensureWatchHelperBinary: vi.fn(async () => ({ path: '/tmp/watch-control' })),
}));

import { createWatchOsInteractor } from './interactor.ts';

function watch(overrides: Partial<DeviceInfo> = {}): DeviceInfo {
  return {
    platform: 'apple',
    appleOs: 'watchos',
    id: 'watch-1',
    name: 'Apple Watch',
    kind: 'simulator',
    target: 'mobile',
    booted: true,
    ...overrides,
  };
}

const context = { signal: new AbortController().signal } as RunnerContext;

beforeEach(() => {
  vi.clearAllMocks();
});

test('watchOS HID interactor rejects a non-default simulator set before host dispatch', () => {
  expect(() =>
    createWatchOsInteractor(watch({ simulatorSetPath: '/tmp/watch-set' }), context),
  ).toThrow('default Simulator device set');
});

test('watchOS HID interactor rejects physical devices before host dispatch', () => {
  expect(() => createWatchOsInteractor(watch({ kind: 'device' }), context)).toThrow(
    'Simulator targets',
  );
  expect(runSimctlForDevice).not.toHaveBeenCalled();
  expect(runAppleToolCommand).not.toHaveBeenCalled();
});

test('watchOS HID interactor refuses a runtime without LegacyHID with a typed reason', async () => {
  vi.mocked(runSimctlForDevice).mockResolvedValueOnce({
    stdout: 'Default width: 396\nDefault height: 484\nPreferred UI Scale: 2',
    stderr: '',
    exitCode: 0,
  });
  const interactor = createWatchOsInteractor(watch({ id: 'watch-no-hid' }), context);

  await expect(interactor.tap(99, 121)).rejects.toMatchObject({
    code: 'UNSUPPORTED_OPERATION',
    details: {
      reason: 'watchos-simulator-hid-unavailable',
      deviceId: 'watch-no-hid',
      exitCode: 0,
    },
  });
  expect(runAppleToolCommand).not.toHaveBeenCalled();
});

test('watchOS HID tap converts logical display points to normalized LegacyHID coordinates', async () => {
  const interactor = createWatchOsInteractor(watch({ id: 'watch-scaled' }), context);

  await interactor.tap(99, 121);

  expect(runAppleToolCommand).toHaveBeenCalledWith(
    '/tmp/watch-control',
    ['watch-scaled', 'tap', '0.5', '0.5'],
    expect.objectContaining({ allowFailure: true }),
  );
});

test('watchOS Crown scroll refuses horizontal, pixel, and duration inputs instead of misreporting them', async () => {
  const interactor = createWatchOsInteractor(watch(), context);

  await expect(interactor.scroll('left')).rejects.toMatchObject({ code: 'UNSUPPORTED_OPERATION' });
  await expect(interactor.scroll('right')).rejects.toMatchObject({ code: 'UNSUPPORTED_OPERATION' });
  await expect(interactor.scroll('down', { pixels: 300 })).rejects.toMatchObject({
    code: 'UNSUPPORTED_OPERATION',
  });
  await expect(interactor.scroll('up', { durationMs: 500 })).rejects.toMatchObject({
    code: 'UNSUPPORTED_OPERATION',
  });
  expect(runAppleToolCommand).not.toHaveBeenCalled();
});

test('watchOS Crown scroll sends only supported vertical amount input', async () => {
  const interactor = createWatchOsInteractor(watch(), context);
  await interactor.scroll('down', { amount: 0.25 });
  expect(runAppleToolCommand).toHaveBeenCalledWith(
    '/tmp/watch-control',
    ['watch-1', 'crown-scroll', '90'],
    expect.objectContaining({ allowFailure: true }),
  );
});

test('watchOS screenshot rejects an unsupported density request instead of ignoring it', async () => {
  const interactor = createWatchOsInteractor(watch(), context);
  await expect(interactor.screenshot('/tmp/watch.png', { pixelDensity: 2 })).rejects.toMatchObject({
    code: 'UNSUPPORTED_OPERATION',
  });
});
