import type {
  AppStateRuntimeCommand,
  AppStateRuntimeCommandResult,
  AppStateRuntimeResult,
} from '@agent-device/contracts/app-state-runtime';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { parseAndroidForegroundApp } from '@agent-device/contracts/android-observation';

export type AndroidAppStateHost = Readonly<{
  run(
    device: DeviceInfo,
    command: AppStateRuntimeCommand,
    signal: AbortSignal,
  ): Promise<AppStateRuntimeCommandResult>;
}>;

const FOCUS_COMMANDS = [
  ['shell', 'dumpsys', 'window', 'windows'],
  ['shell', 'dumpsys', 'window'],
] as const;
const ACTIVITY_COMMANDS = [
  ['shell', 'dumpsys', 'activity', 'activities'],
  ['shell', 'dumpsys', 'activity'],
] as const;

export async function readAndroidAppState(
  host: AndroidAppStateHost,
  device: DeviceInfo,
  signal: AbortSignal,
): Promise<AppStateRuntimeResult> {
  const windowFocus = await readAndroidFocus(host, device, FOCUS_COMMANDS, signal);
  if (windowFocus) return windowFocus;

  const activityFocus = await readAndroidFocus(host, device, ACTIVITY_COMMANDS, signal);
  if (activityFocus) return activityFocus;
  return {};
}

async function readAndroidFocus(
  host: AndroidAppStateHost,
  device: DeviceInfo,
  commands: readonly (readonly string[])[],
  signal: AbortSignal,
): Promise<AppStateRuntimeResult | null> {
  for (const args of commands) {
    signal.throwIfAborted();
    const result = await host.run(device, { args, allowFailure: true }, signal);
    signal.throwIfAborted();
    const parsed = parseAndroidForegroundApp(result.stdout);
    if (parsed) return parsed;
  }
  return null;
}
