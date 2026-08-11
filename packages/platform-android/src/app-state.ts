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
      const segment = line.slice(markerIndex + marker.length);
      const parsed = parseAndroidComponentFromSegment(segment);
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
  for (const token of segment.trim().split(/\s+/)) {
    const slashIndex = token.indexOf('/');
    if (slashIndex <= 0) continue;

    const packageName = readAndroidName(token.slice(0, slashIndex), false);
    const activity = readAndroidName(token.slice(slashIndex + 1), true);
    if (packageName && activity && packageName.length === slashIndex) {
      return { package: packageName, activity };
    }
  }
  return null;
}

function readAndroidName(value: string, allowDollar: boolean): string {
  let index = 0;
  while (index < value.length && isAndroidNameChar(value[index], allowDollar)) index += 1;
  return value.slice(0, index);
}

function isAndroidNameChar(char: string | undefined, allowDollar: boolean): boolean {
  if (!char) return false;
  const code = char.charCodeAt(0);
  return (
    (code >= 48 && code <= 57) ||
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) ||
    char === '_' ||
    char === '.' ||
    (allowDollar && char === '$')
  );
}
