import type {
  AppStateRuntimeCommand,
  AppStateRuntimeCommandResult,
  AppStateRuntimeResult,
} from '@agent-device/contracts/platform';
import type { DeviceInfo } from '@agent-device/kernel/device';

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
const ANDROID_FOCUS_MARKERS = [
  'mCurrentFocus=Window{',
  'mFocusedApp=AppWindowToken{',
  'mResumedActivity:',
  'ResumedActivity:',
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

export function parseAndroidForegroundApp(text: string): AppStateRuntimeResult | null {
  const lines = text.split('\n');
  for (const marker of ANDROID_FOCUS_MARKERS) {
    for (const line of lines) {
      const markerIndex = line.indexOf(marker);
      if (markerIndex === -1) continue;
      const parsed = parseAndroidComponentFromSegment(line.slice(markerIndex + marker.length));
      if (parsed) return parsed;
    }
  }
  return null;
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

function parseAndroidComponentFromSegment(segment: string): AppStateRuntimeResult | null {
  const match = segment.match(/\b([A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+)\/([A-Za-z0-9_.$]+)/);
  return match?.[1] && match[2] ? { package: match[1], activity: match[2] } : null;
}
