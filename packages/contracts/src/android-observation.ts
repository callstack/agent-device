import type { AppStateRuntimeResult } from './app-state-runtime.ts';
import type { DeviceInfo } from '@agent-device/kernel/device';
import type { SnapshotNode } from '@agent-device/kernel/snapshot';

/** Focus facts that are safe to pass between the daemon and an Android owner. */
export type AndroidBlockingDialogFocus = Readonly<{
  /**
   * The package that owns the not-responding process. It is present only when the observer
   * resolved exactly one owning package, so an absent package means foreign or unresolved.
   */
  package?: string;
  /** The not-responding process that the dialog names. A process name is not a package name. */
  process?: string;
  focusedWindow: string;
  raw: string;
}>;

/**
 * One observation of Android's focused system-window state. `unknown` is the case the daemon must
 * not confuse with `clear`: no read named the focused window, so it is evidence about nothing.
 */
export type AndroidBlockingDialogObservation =
  | Readonly<{ status: 'dialog'; focus: AndroidBlockingDialogFocus }>
  | Readonly<{
      status: 'clear';
      /** The app package that owns the focused window, when the read named one. */
      focusedPackage?: string;
    }>
  | Readonly<{ status: 'unknown' }>;

/** The minimal result needed by daemon-owned recovery to classify an adb tap. */
export type AndroidObservationCommandResult = Readonly<{
  exitCode: number;
  stdout: string;
  stderr: string;
}>;

/**
 * `requireComplete` rejects a truncated or sparse capture. Only a reader that infers a node is
 * absent sets it; a reader that looks for a present node can use a partial capture.
 */
export type AndroidSnapshotReadOptions = Readonly<{ requireComplete?: boolean }>;

/** Raw Android mechanics supplied by root composition to the package-owned observer. */
export type AndroidObservationHost = Readonly<{
  runAdb(
    device: DeviceInfo,
    args: readonly string[],
    options?: Readonly<{ allowFailure?: boolean; timeoutMs?: number }>,
  ): Promise<AndroidObservationCommandResult>;
  readSnapshotNodes(
    device: DeviceInfo,
    options?: AndroidSnapshotReadOptions,
  ): Promise<SnapshotNode[]>;
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
  readSnapshotNodes(
    device: DeviceInfo,
    options?: AndroidSnapshotReadOptions,
  ): Promise<SnapshotNode[]>;
  tap(device: DeviceInfo, x: number, y: number): Promise<AndroidObservationCommandResult>;
  openApp(device: DeviceInfo, appBundleId: string): Promise<void>;
  readScreenSize(device: DeviceInfo): Promise<Readonly<{ width: number; height: number }>>;
  isPermissionPackage(packageName: string): Promise<boolean>;
}>;
