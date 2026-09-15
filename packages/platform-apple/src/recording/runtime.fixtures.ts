import type {
  AppleScreenRecordingRunnerRequest,
  ScreenRecordingFinalizer,
  ScreenRecordingRuntimeHost,
} from '@agent-device/contracts/screen-recording-runtime-host';
import type { ScreenRecordingStartInput } from '@agent-device/contracts/screen-recording-runtime';
import type { DeviceInfo } from '@agent-device/kernel/device';
import type { NativePathDisposition } from '@agent-device/contracts/recording-native-path';
import type { AppleScreenRecordingOperationHost } from './recovery.ts';

export const coreDevice = Object.freeze({
  platform: 'apple' as const,
  appleOs: 'ios' as const,
  id: 'ios-device',
  name: 'iPhone',
  kind: 'device' as const,
  target: 'mobile' as const,
  iosPhysicalDeviceBackend: 'coredevice' as const,
  booted: true,
});

export const simulator = Object.freeze({
  platform: 'apple' as const,
  appleOs: 'ios' as const,
  id: 'sim',
  name: 'Simulator',
  kind: 'simulator' as const,
  target: 'mobile' as const,
  booted: true,
});

export const runnerOwnership = Object.freeze({
  runnerSessionId: 'runner-session',
  runnerAuthority: 'local-lease' as const,
});

export const coreDeviceRunnerStart = Object.freeze({
  ...runnerOwnership,
  remotePath: 'tmp/agent-device-recording-123.mp4',
});

export const processIdentity = Object.freeze({
  pid: 42,
  startTime: 'start-time',
  command: 'xcrun simctl io sim recordVideo /tmp/capture.mp4',
});

/**
 * The recording files a stop moves between paths, held where the output host would hold them. A copy
 * with no source fails here the way it fails on a real volume, so a runtime that invents a path cannot
 * pass (ADR 0024 2.3).
 */
export function recordingFileStore(initial: Readonly<Record<string, string>> = {}): Readonly<{
  files: Map<string, string>;
  exists(filePath: string): boolean;
  outputs: ScreenRecordingRuntimeHost['outputs'];
}> {
  const files = new Map(Object.entries(initial));
  const missing = (filePath: string) => new Error(`ENOENT: no such file, copyfile '${filePath}'`);
  return {
    files,
    exists: (filePath) => files.has(filePath),
    outputs: {
      prepare: async (outputPath) => {
        files.delete(outputPath);
      },
      collectFromRecorder: async ({ recorderPath, collectedPath }) => {
        const bytes = files.get(recorderPath);
        if (bytes === undefined) throw missing(recorderPath);
        files.set(collectedPath, bytes);
      },
      writeExportFromCollected: async ({ collectedPath, exportPath }) => {
        const bytes = files.get(collectedPath);
        if (bytes === undefined) throw missing(collectedPath);
        files.set(exportPath, bytes);
      },
      retireRecorderFile: async (recorderPath): Promise<NativePathDisposition> => {
        files.delete(recorderPath);
        return files.has(recorderPath) ? 'retirable' : 'retired';
      },
      discardCollectedFile: async (collectedPath) => {
        files.delete(collectedPath);
      },
    },
  };
}

export function recordingOutputPath(name = 'capture.mp4'): string {
  return `/tmp/${name}`;
}

export function recordingInput(
  overrides: Partial<ScreenRecordingStartInput> = {},
): ScreenRecordingStartInput {
  return {
    sessionId: 'one',
    outputPath: recordingOutputPath(),
    scope: 'device',
    showTouches: false,
    hideTouchesRequested: false,
    recordOnlySession: false,
    activeSessionApp: { bundleId: 'com.example.app' },
    fence: { token: 'fence', generation: 1 },
    ...overrides,
  };
}

export function appleRecordingHost(
  options: {
    apple?: Partial<ScreenRecordingRuntimeHost['apple']>;
    complete?: ScreenRecordingFinalizer['complete'];
    validatePlayable?: ScreenRecordingFinalizer['validatePlayable'];
    files?: ReturnType<typeof recordingFileStore>;
    outputs?: Partial<ScreenRecordingRuntimeHost['outputs']>;
    ownedProcesses?: ScreenRecordingRuntimeHost['ownedProcesses'];
  } = {},
): AppleScreenRecordingOperationHost {
  const store = options.files ?? recordingFileStore();
  const provided = options.apple ?? {};
  const startSimulator =
    provided.startSimulator ??
    (async () => {
      throw new Error('unused');
    });
  const apple = Object.assign(
    {
      availability: async () => ({ available: true }) as const,
      runRunner: async (_device: DeviceInfo, request: AppleScreenRecordingRunnerRequest) =>
        request.kind === 'start' ? coreDeviceRunnerStart : {},
      startSimulator,
      inspectProcess: async () => 'owned-alive' as const,
      terminateProcess: async () => 'terminated' as const,
      inspectRunner: async () => 'owned-alive' as const,
      retrieveRunnerRecording: async () => {},
      captureClockAnchor: async () => undefined,
      isRunnerBundleId: async () => false,
    },
    provided,
    {
      // The recorder owns its own file, and the stop copies it, so the double has to leave one
      // behind wherever the runtime told `simctl` to write.
      startSimulator: async (
        device: DeviceInfo,
        outputPath: string,
        signal?: AbortSignal,
      ): Promise<Awaited<ReturnType<ScreenRecordingRuntimeHost['apple']['startSimulator']>>> => {
        // The recorder owns its own file and the stop copies it, so the double has to leave one
        // behind wherever the runtime told `simctl` to write.
        store.files.set(outputPath, 'fake-video');
        return await startSimulator(device, outputPath, signal);
      },
    },
  );
  return {
    screenRecording: {
      apple,
      outputs: Object.assign({}, store.outputs, options.outputs),
      finalize: {
        complete: options.complete ?? (async () => ({})),
        validatePlayable: options.validatePlayable ?? (async () => {}),
      },
      ownedProcesses: options.ownedProcesses ?? { replace: () => {}, clear: () => {} },
    },
  };
}
