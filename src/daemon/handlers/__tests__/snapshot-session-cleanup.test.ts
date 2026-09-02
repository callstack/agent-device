import { afterEach, beforeEach, expect, test, vi } from 'vitest';

vi.mock('@agent-device/platform-apple/runner/operations', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent-device/platform-apple/runner/operations')>()),
  stopIosRunnerSession: vi.fn(async () => {}),
}));
vi.mock('@agent-device/platform-apple/app-lifecycle', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent-device/platform-apple/app-lifecycle')>()),
  closeIosApp: vi.fn(async () => {}),
}));

import { withSessionlessRunnerCleanup } from '../../snapshot-session.ts';
import { platformResourceCleanup } from '../../../platform-runtime-resource-cleanup.ts';
import { closeIosApp } from '@agent-device/platform-apple/app-lifecycle';
import { stopIosRunnerSession } from '@agent-device/platform-apple/runner/operations';
import { IOS_SIMULATOR } from '../../../__tests__/test-utils/device-fixtures.ts';
import { setActiveProviderDeviceRuntimes } from '../../../provider-device-runtime.ts';
import type { ProviderDeviceRuntime } from '@agent-device/contracts/device';

const mockStopIosRunnerSession = vi.mocked(stopIosRunnerSession);
const mockCloseIosApp = vi.mocked(closeIosApp);
const returnOk = async () => 'ok';

beforeEach(() => {
  mockStopIosRunnerSession.mockReset().mockResolvedValue();
  mockCloseIosApp.mockReset().mockResolvedValue();
});

afterEach(() => {
  setActiveProviderDeviceRuntimes([]);
});

test('sessionless iOS runner cleanup stops the runner host app', async () => {
  const result = await withSessionlessRunnerCleanup(
    undefined,
    IOS_SIMULATOR,
    returnOk,
    platformResourceCleanup,
  );
  expect(result).toBe('ok');
  expect(mockStopIosRunnerSession).toHaveBeenCalledWith(IOS_SIMULATOR.id);
  expect(mockCloseIosApp).toHaveBeenCalledWith(IOS_SIMULATOR, 'com.callstack.agentdevice.runner');
});

test('sessionless iOS runner host close is best effort', async () => {
  mockCloseIosApp.mockRejectedValueOnce(new Error('terminate failed'));
  const result = await withSessionlessRunnerCleanup(
    undefined,
    IOS_SIMULATOR,
    returnOk,
    platformResourceCleanup,
  );
  expect(result).toBe('ok');
  expect(mockStopIosRunnerSession).toHaveBeenCalledWith(IOS_SIMULATOR.id);
  expect(mockCloseIosApp).toHaveBeenCalledWith(IOS_SIMULATOR, 'com.callstack.agentdevice.runner');
});

test('sessionless cleanup leaves a provider-owned device to its provider', async () => {
  const device = { ...IOS_SIMULATOR, id: 'limrun:ios:lease-a' };
  const runtime: ProviderDeviceRuntime = {
    provider: 'limrun',
    leaseLifecycle: {},
    deviceInventoryProvider: async () => [device],
    ownsDevice: (candidate) => candidate.id === device.id,
    getInteractor: () => undefined,
    shutdown: async () => {},
  };
  setActiveProviderDeviceRuntimes([runtime]);

  const result = await withSessionlessRunnerCleanup(
    undefined,
    device,
    returnOk,
    platformResourceCleanup,
  );

  expect(result).toBe('ok');
  expect(mockStopIosRunnerSession).not.toHaveBeenCalled();
  expect(mockCloseIosApp).not.toHaveBeenCalled();
});
