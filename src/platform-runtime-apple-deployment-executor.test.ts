import { expect, test, vi } from 'vitest';
import type { DeviceInfo } from '@agent-device/kernel/device';

const { invalidateIosAppResolutionCache, resolveIosApp } = vi.hoisted(() => ({
  invalidateIosAppResolutionCache: vi.fn(),
  resolveIosApp: vi.fn(),
}));

vi.mock('@agent-device/platform-apple/app-resolution', () => ({
  invalidateIosAppResolutionCache,
  resolveIosApp,
}));

import { createAppleAppDeploymentExecutor } from './platform-runtime-apple-deployment-executor.ts';

const device: DeviceInfo = {
  platform: 'apple',
  appleOs: 'ios',
  id: 'apple-executor',
  name: 'Apple executor',
  kind: 'simulator',
  target: 'mobile',
  booted: true,
};

test('keeps only artifact and identity capabilities in the root adapter', async () => {
  resolveIosApp.mockResolvedValue('com.example.app');
  const executor = createAppleAppDeploymentExecutor();

  await expect(executor.resolveAppBundleId(device, 'Example')).resolves.toBe('com.example.app');

  expect(resolveIosApp).toHaveBeenCalledWith(device, 'Example');
  expect(executor).not.toHaveProperty('install');
  expect(executor).not.toHaveProperty('uninstall');
  expect(executor).not.toHaveProperty('push');
});

test('delegates the full Apple reinstall cache transaction to the lazy native executor', async () => {
  const operation = vi.fn(async () => 'completed');
  invalidateIosAppResolutionCache.mockImplementation(async (_device, scopedOperation) =>
    scopedOperation(),
  );
  const executor = createAppleAppDeploymentExecutor();

  await expect(executor.withInvalidatedAppResolutionCache(device, operation)).resolves.toBe(
    'completed',
  );

  expect(invalidateIosAppResolutionCache).toHaveBeenCalledWith(device, operation);
  expect(operation).toHaveBeenCalledOnce();
});
