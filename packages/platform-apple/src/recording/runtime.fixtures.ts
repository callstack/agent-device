import type {
  AppleScreenRecordingRunnerRequest,
  ScreenRecordingFinalizer,
  ScreenRecordingRuntimeHost,
} from '@agent-device/contracts/screen-recording-runtime-host';
import type { ScreenRecordingStartInput } from '@agent-device/contracts/screen-recording-runtime';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { recordingFileStore } from '@agent-device/capture-kit/recording-artifact-fixtures';
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
    sniff?: ScreenRecordingFinalizer['sniff'];
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
        sniff: options.sniff ?? (async () => {}),
        complete: options.complete ?? (async () => ({})),
      },
      ownedProcesses: options.ownedProcesses ?? { replace: () => {}, clear: () => {} },
    },
  };
}
