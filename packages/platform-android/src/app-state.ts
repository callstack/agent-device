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
const ANDROID_FOCUS_LINE =
  /(?:(mCurrentFocus=Window\{)|(mFocusedApp=AppWindowToken\{)|(mResumedActivity:)|(ResumedActivity:))(.*)$/gm;

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
  const matches = Array.from(text.matchAll(ANDROID_FOCUS_LINE));
  matches.sort(
    (left, right) =>
      focusMarkerRank(left) - focusMarkerRank(right) ||
      (left.index ?? Number.POSITIVE_INFINITY) - (right.index ?? Number.POSITIVE_INFINITY),
  );
  for (const match of matches) {
    const segment = match[5];
    if (!segment) continue;
    const parsed = parseAndroidComponentFromSegment(segment);
    if (parsed) return parsed;
  }
  return null;
}

function focusMarkerRank(match: RegExpMatchArray): number {
  if (match[1]) return 0;
  if (match[2]) return 1;
  if (match[3]) return 2;
  return 3;
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
