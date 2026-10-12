import type {
  AndroidObservationAdapter,
  AndroidObservationHost,
} from '@agent-device/contracts/android-observation';
import { createAndroidObservationAdapter } from '@agent-device/platform-android';
import {
  androidSnapshotPublicationInput,
  createAndroidWindowDumpReader,
  getAndroidAppState,
  getAndroidBlockingDialogObservation,
  getAndroidScreenSize,
  isAndroidPermissionPackage,
  openAndroidApp,
  runAndroidAdb,
  snapshotAndroid,
} from '@agent-device/platform-android/mechanics';
import { buildSnapshotState } from '@agent-device/capture-kit/snapshot-state';

/** The Android observation port: package policy over mechanics, so suite mocks on `@agent-device/platform-android/mechanics` answer every read. */
const mechanicsObservationHost: AndroidObservationHost = Object.freeze({
  async runAdb(device, args, options) {
    const result = await runAndroidAdb(device, args, options);
    return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
  },
  async readSnapshotNodes(device) {
    const rawSnapshot = await snapshotAndroid(device, { interactiveOnly: false });
    return buildSnapshotState(androidSnapshotPublicationInput(rawSnapshot), undefined).nodes;
  },
  async openApp(device, appBundleId) {
    await openAndroidApp(device, appBundleId);
  },
});

/** Package observation policy with a mechanics-backed host, as the production adapter is composed. */
export const androidObservationPolicyFixture: AndroidObservationAdapter =
  createAndroidObservationAdapter(mechanicsObservationHost);

/** Adapter preserving the platform-leaf mock surface: policy members delegate to the mechanics leaves. */
export const androidObservationFixture: AndroidObservationAdapter = Object.freeze({
  ...androidObservationPolicyFixture,
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
  ...androidObservationPolicyFixture,
  readAppState: async () => ({}),
  readBlockingDialog: async () => ({ status: 'clear' }) as const,
  readAppFocus: async () => true,
  readSnapshotNodes: async () => [],
  tap: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
  openApp: async () => undefined,
  readScreenSize: async () => ({ width: 1080, height: 1920 }),
  isPermissionPackage: async (packageName) => isAndroidPermissionPackage(packageName),
} satisfies AndroidObservationAdapter);
