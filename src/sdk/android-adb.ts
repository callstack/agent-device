export {
  createAndroidPortReverseManager,
  type AndroidAdbExecutor,
  type AndroidAdbExecutorOptions,
  type AndroidAdbProvider,
  type AndroidPortReverseEndpoint,
} from '../platforms/android/adb-executor.ts';
export { listAndroidAppsWithAdb } from '../platforms/android/app-helpers.ts';

import { createAndroidAppStateReader } from '../platforms/android/app-helpers.ts';
import type { AndroidAdbExecutor } from '../platforms/android/adb-executor.ts';
import type { AppStateRuntimeResult } from '@agent-device/contracts/app-state-runtime';

/**
 * Composition seam: the dumpsys foreground parser is platform-android's, so
 * only the root composition may load it (R13); the published signature stays
 * `(adb) => AppStateRuntimeResult`.
 */
export async function getAndroidAppStateWithAdb(
  adb: AndroidAdbExecutor,
): Promise<AppStateRuntimeResult> {
  const { parseAndroidForegroundApp } = await import('../platform-runtime.ts');
  return await createAndroidAppStateReader(parseAndroidForegroundApp)(adb);
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
