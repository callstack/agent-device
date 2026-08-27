import type { AndroidObservationAdapter } from '@agent-device/contracts/android-observation';
import { androidObservation } from '../../platform-runtime.ts';
import {
  createAndroidWindowDumpReader,
  getAndroidAppState,
  getAndroidBlockingDialogObservation,
} from '../../platforms/android/window-state.ts';
import { getAndroidScreenSize } from '../../platforms/android/input-actions.ts';
import { isAndroidPermissionPackage } from '../../platforms/android/alert-detection.ts';

/** Test adapter that preserves existing platform-leaf mocks while production uses package policy. */
export const androidObservationFixture: AndroidObservationAdapter = Object.freeze({
  ...androidObservation,
  readAppState: async (device) => await getAndroidAppState(device),
  readBlockingDialog: async (device) => await getAndroidBlockingDialogObservation(device),
  async readAppFocus(device, appBundleId, options = {}) {
    const read = createAndroidWindowDumpReader(device);
    if (options.requireNoBlockingDialog) {
      const observation = await getAndroidBlockingDialogObservation(device, read);
      if (observation.status === 'dialog') return false;
    }
    return (await getAndroidAppState(device, read)).package === appBundleId;
  },
  readScreenSize: async (device) => await getAndroidScreenSize(device),
  isPermissionPackage: async (packageName) => isAndroidPermissionPackage(packageName),
});

/** Benign router default for tests that exercise locking or response shape, not Android state. */
export const clearAndroidObservationFixture = Object.freeze({
  ...androidObservation,
  readAppState: async () => ({}),
  readBlockingDialog: async () => ({ status: 'clear' }) as const,
  readAppFocus: async () => true,
  readSnapshotNodes: async () => [],
  tap: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
  openApp: async () => undefined,
  readScreenSize: async () => ({ width: 1080, height: 1920 }),
  isPermissionPackage: async (packageName) => isAndroidPermissionPackage(packageName),
} satisfies AndroidObservationAdapter);
