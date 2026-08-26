import type { OwnedProcessRecordWriter } from '@agent-device/contracts/platform-runtime-host';
import type { ScreenRecordingRuntimeHost } from '@agent-device/contracts/screen-recording-runtime-host';

/** Lazy host-only composition; platform semantics stay package-owned. */
export function createScreenRecordingRuntimeHost(
  options: {
    ownedProcesses?: OwnedProcessRecordWriter;
  } = {},
): ScreenRecordingRuntimeHost {
  const android: ScreenRecordingRuntimeHost['android'] = Object.freeze({
    resolve: async (device) => {
      const { createAndroidScreenRecordingTransport } =
        await import('./platform-runtime-screen-recording-android-host.ts');
      return await createAndroidScreenRecordingTransport(device);
    },
  });
  const web: ScreenRecordingRuntimeHost['web'] = Object.freeze({
    resolve: async (device) => {
      const { resolveWebScreenRecordingTransport } =
        await import('./platform-runtime-screen-recording-web-host.ts');
      return await resolveWebScreenRecordingTransport(device);
    },
  });
  const outputs: ScreenRecordingRuntimeHost['outputs'] = Object.freeze({
    prepare: async (outputPath) => {
      const { createScreenRecordingOutputHost } =
        await import('./platform-runtime-screen-recording-output-host.ts');
      await createScreenRecordingOutputHost().prepare(outputPath);
    },
  });
  const finalize: ScreenRecordingRuntimeHost['finalize'] = Object.freeze({
    complete: async (input, signal) => {
      const { createScreenRecordingFinalizer } =
        await import('./platform-runtime-screen-recording-finalizer-host.ts');
      return await createScreenRecordingFinalizer().complete(input, signal);
    },
  });
  const ownedProcesses: OwnedProcessRecordWriter =
    options.ownedProcesses ??
    Object.freeze({
      replace: () => {},
      clear: () => {},
    });
  return Object.freeze({
    apple: createLazyAppleHost(),
    android,
    harmony: createLazyHarmonyHost(),
    web,
    outputs,
    finalize,
    ownedProcesses,
  });
}

function createLazyAppleHost(): ScreenRecordingRuntimeHost['apple'] {
  const load = async () => {
    const { createAppleScreenRecordingHost } =
      await import('./platform-runtime-screen-recording-apple-host.ts');
    return createAppleScreenRecordingHost();
  };
  return Object.freeze({
    availability: async (device) => (await load()).availability(device),
    runRunner: async (device, request, signal) =>
      await (await load()).runRunner(device, request, signal),
    startSimulator: async (device, outputPath, signal) =>
      await (await load()).startSimulator(device, outputPath, signal),
    inspectProcess: async (marker) => await (await load()).inspectProcess(marker),
    terminateProcess: async (marker) => await (await load()).terminateProcess(marker),
    inspectRunner: async (device, sessionId, authority) =>
      await (await load()).inspectRunner(device, sessionId, authority),
    retrieveRunnerRecording: async (device, remotePath, outputPath, signal) =>
      await (await load()).retrieveRunnerRecording(device, remotePath, outputPath, signal),
    captureClockAnchor: async (device, appBundleId, signal) =>
      await (await load()).captureClockAnchor(device, appBundleId, signal),
    isRunnerBundleId: async (bundleId) => await (await load()).isRunnerBundleId(bundleId),
  });
}

function createLazyHarmonyHost(): ScreenRecordingRuntimeHost['harmony'] {
  const load = async () => {
    const { createHarmonyScreenRecordingHost } =
      await import('./platform-runtime-screen-recording-harmony-host.ts');
    return createHarmonyScreenRecordingHost();
  };
  return Object.freeze({
    start: async (device, fileName, signal) => await (await load()).start(device, fileName, signal),
    stop: async (device, signal) => await (await load()).stop(device, signal),
    findMedia: async (device, fileName, signal) =>
      await (await load()).findMedia(device, fileName, signal),
    stageMedia: async (device, input, signal) =>
      await (await load()).stageMedia(device, input, signal),
    stagedFileSize: async (device, remotePath, signal) =>
      await (await load()).stagedFileSize(device, remotePath, signal),
    pull: async (device, input, signal) => await (await load()).pull(device, input, signal),
    remove: async (device, remotePath, signal) =>
      await (await load()).remove(device, remotePath, signal),
    removeMedia: async (device, mediaUri, signal) =>
      await (await load()).removeMedia(device, mediaUri, signal),
  });
}
