import '../platform-runtime-android-adb-host.ts';
export {
  createAndroidPortReverseManager,
  type AndroidAdbExecutor,
  type AndroidAdbExecutorOptions,
  type AndroidAdbProvider,
  type AndroidPortReverseEndpoint,
} from '@agent-device/platform-android/mechanics';
export { listAndroidAppsWithAdb } from '@agent-device/platform-android/mechanics';
export { runAdbExecOut, runAdbShell } from '@agent-device/platform-android/mechanics';
import {
  runAndroidExecOut as runAndroidExecOutOnHost,
  runAndroidShell as runAndroidShellOnHost,
} from '@agent-device/platform-android/mechanics';
import { withSdkHost } from './host.ts';

export async function runAndroidShell(...args: Parameters<typeof runAndroidShellOnHost>) {
  return await withSdkHost(() => runAndroidShellOnHost(...args));
}

export async function runAndroidExecOut(...args: Parameters<typeof runAndroidExecOutOnHost>) {
  return await withSdkHost(() => runAndroidExecOutOnHost(...args));
}
export type { ShellWord } from '@agent-device/kernel/device-shell';

import type { AndroidAdbExecutor } from '@agent-device/platform-android/mechanics';
import type { AppStateRuntimeResult } from '@agent-device/contracts/app-state-runtime';

export async function getAndroidAppStateWithAdb(
  adb: AndroidAdbExecutor,
  signal?: AbortSignal,
): Promise<AppStateRuntimeResult> {
  const { getAndroidAppStateWithAdb: read } = await import('../platform-runtime.ts');
  return await read(adb, signal);
}

export {
  forceStopAndroidAppWithAdb,
  openAndroidAppWithAdb,
} from '@agent-device/platform-android/mechanics';
export { captureAndroidLogcatWithAdb } from '@agent-device/platform-android/mechanics';
export {
  dismissAndroidKeyboardWithAdb,
  getAndroidKeyboardStatusWithAdb,
  readAndroidClipboardWithAdb,
  type AndroidKeyboardDismissResult,
  type AndroidKeyboardState,
  writeAndroidClipboardWithAdb,
} from '@agent-device/platform-android/mechanics';
