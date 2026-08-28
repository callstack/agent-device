import type { AndroidObservationHost } from '@agent-device/contracts/android-observation';

/** Raw Android mechanics injected into the package-owned observation policy. */
export function createAndroidObservationHost(): AndroidObservationHost {
  return Object.freeze({
    async runAdb(device, args, options) {
      const { runAndroidAdb } = await loadAndroidMechanics();
      const result = await runAndroidAdb(device, [...args], options);
      return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
    },
    async readSnapshotNodes(device) {
      const { snapshotAndroid, androidSnapshotPublicationInput } = await loadAndroidMechanics();
      const { buildSnapshotState } = await import('./core/snapshot-state.ts');
      const rawSnapshot = await snapshotAndroid(device, { interactiveOnly: false });
      return buildSnapshotState(androidSnapshotPublicationInput(rawSnapshot), undefined).nodes;
    },
    async openApp(device, appBundleId) {
      const { openAndroidApp } = await loadAndroidMechanics();
      await openAndroidApp(device, appBundleId);
    },
  });
}

async function loadAndroidMechanics() {
  const { loadAndroidMechanics: load } = await import('./platform-runtime-android-mechanics.ts');
  return await load();
}
