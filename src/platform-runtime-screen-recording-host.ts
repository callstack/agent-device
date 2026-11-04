import type { HostEnvironment } from '@agent-device/kernel/source-value';
import type { OwnedProcessRecordWriter } from '@agent-device/contracts/platform-runtime-host';
import type { ScreenRecordingRuntimeHost } from '@agent-device/contracts/screen-recording-runtime-host';
import type { VideoValidatorPreparation } from '@agent-device/capture-kit/recording-video';

/**
 * The one validator owner this host composes, plus the shutdown its compile needs. A cold compile
 * runs outside any request, so the host that started it is the only owner left that can stop it;
 * the daemon closes it with the rest of its durable resources.
 */
export type ScreenRecordingVideoValidatorHost = Readonly<{
  /**
   * Cancels an unfinished validator compile this host started and awaits its settlement, including
   * the compiler's exit, its temporary output and the Swift cache lock. It loads nothing this host
   * never loaded, and it never waits for a compile that already settled.
   */
  closeValidatorPreparation(): Promise<void>;
}>;

/** Lazy host-only composition; platform semantics stay package-owned. */
export function createScreenRecordingRuntimeHost(options: {
  ownedProcesses?: OwnedProcessRecordWriter;
  host: HostEnvironment;
}): ScreenRecordingRuntimeHost & ScreenRecordingVideoValidatorHost {
  const host = options.host;
  // One preparation owner for this host, created when a recording first asks for it. Compilation
  // across runtimes and processes stays with the Swift cache lock, not a second lock database.
  let validator: Promise<VideoValidatorPreparation> | undefined;
  let validatorClosed = false;
  const loadValidator = async () => {
    validator ??= import('@agent-device/capture-kit/recording-video').then((video) =>
      video.createVideoValidatorPreparation(host),
    );
    const preparation = await validator;
    // A load that lands after this host closed hands out a closed owner: nothing it is asked for
    // afterwards may start a compile no shutdown will reach.
    if (validatorClosed) await preparation.close();
    return preparation;
  };
  const loadFinalizer = async () => {
    const { createScreenRecordingFinalizer } =
      await import('./platform-runtime-screen-recording-finalizer-host.ts');
    return createScreenRecordingFinalizer(host, await loadValidator());
  };
  const android: ScreenRecordingRuntimeHost['android'] = Object.freeze({
    resolve: async (device) => {
      const { createAndroidScreenRecordingTransport } =
        await import('./platform-runtime-screen-recording-android-host.ts');
      return await createAndroidScreenRecordingTransport(device, await loadValidator());
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
    inspect: async (filePath) => {
      const { createScreenRecordingOutputHost } =
        await import('./platform-runtime-screen-recording-output-host.ts');
      return await createScreenRecordingOutputHost().inspect(filePath);
    },
    prepare: async (outputPath) => {
      const { createScreenRecordingOutputHost } =
        await import('./platform-runtime-screen-recording-output-host.ts');
      await createScreenRecordingOutputHost().prepare(outputPath);
    },
    copy: async (input) => {
      const { createScreenRecordingOutputHost } =
        await import('./platform-runtime-screen-recording-output-host.ts');
      await createScreenRecordingOutputHost().copy(input);
    },
    remove: async (filePath) => {
      const { createScreenRecordingOutputHost } =
        await import('./platform-runtime-screen-recording-output-host.ts');
      return await createScreenRecordingOutputHost().remove(filePath);
    },
  });
  const finalize: ScreenRecordingRuntimeHost['finalize'] = Object.freeze({
    prepare: async (input) => (await loadFinalizer()).prepare(input),
    sniff: async (input) => (await loadFinalizer()).sniff(input),
    complete: async (input, signal) => (await loadFinalizer()).complete(input, signal),
  });
  const ownedProcesses: OwnedProcessRecordWriter =
    options.ownedProcesses ??
    Object.freeze({
      replace: () => {},
      clear: () => {},
    });
  return Object.freeze({
    apple: createLazyAppleHost(host),
    android,
    harmony: createLazyHarmonyHost(),
    web,
    outputs,
    finalize,
    ownedProcesses,
    closeValidatorPreparation: async () => {
      // Closed first, so a preparation that is still loading is closed too and nothing that comes
      // afterwards can start a compile this shutdown will not reach.
      validatorClosed = true;
      // Nothing loaded means nothing to close: a host that never recorded never started a compile.
      if (!validator) return;
      await (await validator).close();
    },
  });
}

function createLazyAppleHost(host: HostEnvironment): ScreenRecordingRuntimeHost['apple'] {
  const load = async () => {
    const { createAppleScreenRecordingHost } =
      await import('./platform-runtime-screen-recording-apple-host.ts');
    return createAppleScreenRecordingHost(host);
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
    captureClockAnchor: async (device, appBundleId, signal, requestId) =>
      await (await load()).captureClockAnchor(device, appBundleId, signal, requestId),
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
