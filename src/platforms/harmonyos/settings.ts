import type { DeviceInfo } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';
import { runHarmonyHdc } from './hdc.ts';

export async function setHarmonySetting(
  device: DeviceInfo,
  setting: string,
  state: string,
  appBundleId?: string,
): Promise<Record<string, unknown>> {
  if (setting !== 'clear-app-state') {
    throw new AppError('UNSUPPORTED_OPERATION', `HarmonyOS setting "${setting}" is not supported`, {
      hint: 'HarmonyOS currently supports settings clear-app-state for an app bundle only.',
    });
  }
  if (state !== 'clear') {
    throw new AppError('INVALID_ARGS', 'settings clear-app-state only supports clear.');
  }
  if (!appBundleId) {
    throw new AppError(
      'INVALID_ARGS',
      'settings clear-app-state requires an app id or an active app session.',
    );
  }

  await runHarmonyHdc(device, ['shell', 'aa', 'force-stop', appBundleId], { timeoutMs: 15_000 });
  await runHarmonyHdc(device, ['shell', 'bm', 'clean', '-n', appBundleId, '-d', '-c'], {
    timeoutMs: 15_000,
  });
  return { bundleId: appBundleId, forceStopped: true, clearedData: true, clearedCache: true };
}
