import '../platform-runtime-android-adb-host.ts';
export {
  createAndroidPortReverseManager,
  type AndroidAdbExecutor,
  type AndroidAdbExecutorOptions,
  type AndroidAdbProvider,
  type AndroidPortReverseEndpoint,
} from '@agent-device/platform-android/mechanics';
export { listAndroidAppsWithAdb } from '@agent-device/platform-android/mechanics';

import type { AndroidAdbExecutor } from '@agent-device/platform-android/mechanics';
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
