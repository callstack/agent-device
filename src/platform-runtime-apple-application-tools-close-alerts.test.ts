import { beforeEach, expect, test, vi } from 'vitest';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { IOS_SIMULATOR } from '@agent-device/test-kit';
import { createAppleApplicationTools } from './platform-runtime-apple-application-tools.ts';

const runMacOsAlertAction = vi.hoisted(() => vi.fn());

vi.mock('@agent-device/platform-apple/macos', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent-device/platform-apple/macos')>()),
  runMacOsAlertAction,
}));

const MACOS_DEVICE: DeviceInfo = {
  platform: 'apple',
  appleOs: 'macos',
  id: 'host-macos-local',
  name: 'Host Mac',
  kind: 'device',
  target: 'desktop',
  booted: true,
};

beforeEach(() => {
  runMacOsAlertAction.mockReset();
  runMacOsAlertAction.mockResolvedValue({});
});

const finalization = { retainRunner: false, stateDir: '/tmp' } as const;

test('close dismisses the automation alert of the closed macOS app', async () => {
  await createAppleApplicationTools(process.env).dismissCloseAlerts(MACOS_DEVICE, {
    ...finalization,
    surface: 'app',
    appBundleId: 'com.apple.systempreferences',
  });

  expect(runMacOsAlertAction).toHaveBeenCalledWith('dismiss', {
    bundleId: 'com.apple.systempreferences',
    env: process.env,
  });
});

test('close of the frontmost-app surface dismisses the frontmost automation alert', async () => {
  await createAppleApplicationTools(process.env).dismissCloseAlerts(MACOS_DEVICE, {
    ...finalization,
    surface: 'frontmost-app',
    appBundleId: 'com.apple.systempreferences',
  });

  expect(runMacOsAlertAction).toHaveBeenCalledWith('dismiss', {
    surface: 'frontmost-app',
    env: process.env,
  });
});

test('close without a macOS app bundle dismisses with no target', async () => {
  await createAppleApplicationTools(process.env).dismissCloseAlerts(MACOS_DEVICE, {
    ...finalization,
    surface: 'app',
  });

  expect(runMacOsAlertAction).toHaveBeenCalledWith('dismiss', { env: process.env });
});

test('close on a non-macOS device dismisses nothing', async () => {
  await createAppleApplicationTools(process.env).dismissCloseAlerts(IOS_SIMULATOR, {
    ...finalization,
    surface: 'app',
    appBundleId: 'com.example.app',
  });

  expect(runMacOsAlertAction).not.toHaveBeenCalled();
});
