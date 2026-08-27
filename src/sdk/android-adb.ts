export {
  createAndroidPortReverseManager,
  type AndroidAdbExecutor,
  type AndroidAdbExecutorOptions,
  type AndroidAdbProvider,
  type AndroidPortReverseEndpoint,
} from '../platforms/android/adb-executor.ts';
export { listAndroidAppsWithAdb } from '../platforms/android/app-helpers.ts';

import type { AndroidAdbExecutor } from '../platforms/android/adb-executor.ts';
import type { AppStateRuntimeResult } from '@agent-device/contracts/app-state-runtime';

export async function getAndroidAppStateWithAdb(
  adb: AndroidAdbExecutor,
): Promise<AppStateRuntimeResult> {
  const { getAndroidAppStateWithAdb: read } = await import('../platform-runtime.ts');
  return await read(adb);
}

export {
  forceStopAndroidAppWithAdb,
  openAndroidAppWithAdb,
} from '../platforms/android/app-control.ts';
export { captureAndroidLogcatWithAdb } from '../platforms/android/logcat.ts';
export {
  dismissAndroidKeyboardWithAdb,
  getAndroidKeyboardStatusWithAdb,
  readAndroidClipboardWithAdb,
  type AndroidKeyboardDismissResult,
  type AndroidKeyboardState,
  writeAndroidClipboardWithAdb,
} from '../platforms/android/device-input-state.ts';
