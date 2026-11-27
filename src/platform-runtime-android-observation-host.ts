import type { AndroidObservationHost } from '@agent-device/contracts/android-observation';
import { AppError } from '@agent-device/kernel/errors';

/** Raw Android mechanics injected into the package-owned observation policy. */
export function createAndroidObservationHost(): AndroidObservationHost {
  return Object.freeze({
    async runAdb(device, args, options) {
      const { runAndroidAdb } = await loadAndroidMechanics();
      const result = await runAndroidAdb(device, args, options);
      return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
    },
    async readSnapshotNodes(device) {
      const { snapshotAndroid, androidSnapshotPublicationInput, isCompleteAndroidSnapshotCapture } =
        await loadAndroidMechanics();
      const { buildSnapshotState } = await import('@agent-device/capture-kit/snapshot-state');
      const rawSnapshot = await snapshotAndroid(device, { interactiveOnly: false });
      if (!isCompleteAndroidSnapshotCapture(rawSnapshot)) {
        throw new AppError('COMMAND_FAILED', 'Android snapshot capture was incomplete', {
          truncated: rawSnapshot.truncated === true,
          quality: rawSnapshot.quality?.state,
        });
      }
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
