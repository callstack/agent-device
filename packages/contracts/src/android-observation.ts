import type { AppStateRuntimeResult } from './app-state-runtime.ts';
import type { DeviceInfo } from '@agent-device/kernel/device';
import type { SnapshotNode } from '@agent-device/kernel/snapshot';

/** Focus facts that are safe to pass between the daemon and an Android owner. */
export type AndroidBlockingDialogFocus = Readonly<{
  package?: string;
  focusedWindow: string;
  raw: string;
}>;

/** One observation of Android's focused system-window state. */
export type AndroidBlockingDialogObservation =
  | Readonly<{ status: 'dialog'; focus: AndroidBlockingDialogFocus }>
  | Readonly<{ status: 'clear' }>
  | Readonly<{ status: 'unknown' }>;

/** The minimal result needed by daemon-owned recovery to classify an adb tap. */
export type AndroidObservationCommandResult = Readonly<{
  exitCode: number;
  stdout: string;
  stderr: string;
}>;

/** Raw Android mechanics supplied by root composition to the package-owned observer. */
export type AndroidObservationHost = Readonly<{
  runAdb(
    device: DeviceInfo,
    args: readonly string[],
    options?: Readonly<{ allowFailure?: boolean }>,
  ): Promise<AndroidObservationCommandResult>;
  readSnapshotNodes(device: DeviceInfo): Promise<SnapshotNode[]>;
  openApp(device: DeviceInfo, appBundleId: string): Promise<void>;
}>;

/** Root-composed Android observations and narrowly scoped recovery actions. */
export type AndroidObservationAdapter = Readonly<{
  readAppState(device: DeviceInfo): Promise<AppStateRuntimeResult>;
  readBlockingDialog(device: DeviceInfo): Promise<AndroidBlockingDialogObservation>;
  readAppFocus(
    device: DeviceInfo,
    appBundleId: string,
    options?: Readonly<{ requireNoBlockingDialog?: boolean }>,
  ): Promise<boolean>;
  readSnapshotNodes(device: DeviceInfo): Promise<SnapshotNode[]>;
  tap(device: DeviceInfo, x: number, y: number): Promise<AndroidObservationCommandResult>;
  openApp(device: DeviceInfo, appBundleId: string): Promise<void>;
  readScreenSize(device: DeviceInfo): Promise<Readonly<{ width: number; height: number }>>;
  isPermissionPackage(packageName: string): Promise<boolean>;
}>;

const ANDROID_FOCUS_MARKERS = [
  'mCurrentFocus=Window{',
  'mFocusedApp=AppWindowToken{',
  'mResumedActivity:',
  'ResumedActivity:',
] as const;

/** Extracts the foreground package/activity from `dumpsys window`/`activity` output. */
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

function parseAndroidComponentFromSegment(segment: string): AppStateRuntimeResult | null {
  const match = segment.match(/\b([A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+)\/([A-Za-z0-9_.$]+)/);
  return match?.[1] && match[2] ? { package: match[1], activity: match[2] } : null;
}
