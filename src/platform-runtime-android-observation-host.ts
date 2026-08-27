import type { AndroidObservationHost } from '@agent-device/contracts/android-observation';

/** Raw Android mechanics injected into the package-owned observation policy. */
export function createAndroidObservationHost(): AndroidObservationHost {
  return Object.freeze({
    async runAdb(device, args, options) {
      const { runAndroidAdb } = await import('./platforms/android/adb.ts');
      const result = await runAndroidAdb(device, [...args], options);
      return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
    },
    async readSnapshotNodes(device) {
      const { snapshotAndroid } = await import('./platforms/android/snapshot.ts');
      const { androidSnapshotPublicationInput } =
        await import('./platforms/android/snapshot-capture.ts');
      const { buildSnapshotState } = await import('./core/snapshot-state.ts');
      const rawSnapshot = await snapshotAndroid(device, { interactiveOnly: false });
      return buildSnapshotState(androidSnapshotPublicationInput(rawSnapshot), undefined).nodes;
    },
    async openApp(device, appBundleId) {
      const { openAndroidApp } = await import('./platforms/android/app-lifecycle.ts');
      await openAndroidApp(device, appBundleId);
    },
  });
}
