import type { DeviceInfo } from '@agent-device/kernel/device';
import { AppError, sessionAppRequiredDetails } from '@agent-device/kernel/errors';
import { parseSettingState } from '@agent-device/contracts/settings';
import { runHarmonyShell } from './hdc.ts';

/**
 * The screen-off timeout `power-shell timeout -o` accepts at its largest: the 32-bit maximum, in
 * milliseconds. `off` restores the timeout the system setting holds (`power-shell timeout -r`).
 */
const HARMONY_KEEP_AWAKE_TIMEOUT_MS = '2147483647';

export async function setHarmonySetting(
  device: DeviceInfo,
  setting: string,
  state: string,
  appBundleId?: string,
): Promise<Record<string, unknown>> {
  if (setting === 'keep-awake') {
    const enabled = parseSettingState(state);
    await runHarmonyShell(
      device,
      enabled
        ? ['power-shell', 'timeout', '-o', HARMONY_KEEP_AWAKE_TIMEOUT_MS]
        : ['power-shell', 'timeout', '-r'],
      { timeoutMs: 15_000 },
    );
    return { keepAwake: enabled ? 'enabled' : 'disabled' };
  }
  if (setting !== 'clear-app-state') {
    throw new AppError('UNSUPPORTED_OPERATION', `HarmonyOS setting "${setting}" is not supported`, {
      hint: 'HarmonyOS currently supports settings clear-app-state and keep-awake only.',
    });
  }
  if (state !== 'clear') {
    throw new AppError('INVALID_ARGS', 'settings clear-app-state only supports clear.');
  }
  if (!appBundleId) {
    throw new AppError(
      'INVALID_ARGS',
      'settings clear-app-state requires an app id or an active app session.',
      sessionAppRequiredDetails(),
    );
  }

  await runHarmonyShell(device, ['aa', 'force-stop', appBundleId], { timeoutMs: 15_000 });
  await runHarmonyShell(device, ['bm', 'clean', '-n', appBundleId, '-d', '-c'], {
    timeoutMs: 15_000,
  });
  return { bundleId: appBundleId, forceStopped: true, clearedData: true, clearedCache: true };
}
