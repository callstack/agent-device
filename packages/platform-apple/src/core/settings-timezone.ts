import { SETTING_RESET_STATE } from '@agent-device/contracts/settings-catalog';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { requireExecSuccess } from '@agent-device/host-kit/command';
import { runSimctlForDevice } from './simctl-execution.ts';

/**
 * The simulator has no time zone of its own: its apps take the host Mac's unless their environment
 * names one. `launchctl setenv` in the simulator's launchd sets `TZ` for every process it starts
 * afterwards (until the simulator reboots), and `unsetenv` hands them back the host's zone.
 */
export async function setIosTimeZone(
  device: DeviceInfo,
  state: string,
): Promise<Record<string, unknown>> {
  const timeZone = state === SETTING_RESET_STATE ? undefined : state;
  const previousTimeZone = await readLaunchdTimeZone(device);
  await runSimctlChecked(
    device,
    timeZone === undefined
      ? ['launchctl', 'unsetenv', 'TZ']
      : ['launchctl', 'setenv', 'TZ', timeZone],
    'Failed to set the iOS simulator time zone',
  );
  return {
    timeZone: timeZone ?? null,
    previousTimeZone,
    warnings: [
      timeZone === undefined
        ? 'Running apps keep the old time zone until they relaunch (run open <app> --relaunch).'
        : 'Running apps keep the old time zone until they relaunch (run open <app> --relaunch), and the override is lost when the simulator reboots.',
    ],
  };
}

/** The `TZ` the simulator's launchd hands new processes, or `null` when they take the host's. */
async function readLaunchdTimeZone(device: DeviceInfo): Promise<string | null> {
  const result = await runSimctlChecked(
    device,
    ['launchctl', 'getenv', 'TZ'],
    'Failed to read the iOS simulator time zone',
  );
  const value = result.stdout.trim();
  return value.length > 0 ? value : null;
}

async function runSimctlChecked(device: DeviceInfo, args: readonly string[], message: string) {
  return requireExecSuccess(
    await runSimctlForDevice(device, ['spawn', device.id, ...args], { allowFailure: true }),
    message,
  );
}
