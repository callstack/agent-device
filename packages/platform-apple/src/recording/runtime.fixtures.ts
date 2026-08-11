import type {
  AppleScreenRecordingRunnerRequest,
  ScreenRecordingFinalizer,
  ScreenRecordingRuntimeHost,
  ScreenRecordingStartInput,
} from '@agent-device/contracts/platform';
import type { DeviceInfo } from '@agent-device/kernel/device';
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

export function recordingInput(
  overrides: Partial<ScreenRecordingStartInput> = {},
): ScreenRecordingStartInput {
  return {
    sessionId: 'one',
    outputPath: '/tmp/capture.mp4',
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
    prepare?: ScreenRecordingRuntimeHost['outputs']['prepare'];
  } = {},
): AppleScreenRecordingOperationHost {
  const apple = Object.assign(
    {
      availability: async () => ({ available: true }) as const,
      runRunner: async (_device: DeviceInfo, request: AppleScreenRecordingRunnerRequest) =>
        request.kind === 'start' ? coreDeviceRunnerStart : {},
      startSimulator: async () => {
        throw new Error('unused');
      },
      inspectProcess: async () => 'owned-alive' as const,
      terminateProcess: async () => 'terminated' as const,
      inspectRunner: async () => 'owned-alive' as const,
      retrieveRunnerRecording: async () => {},
      captureClockAnchor: async () => undefined,
      isRunnerBundleId: async () => false,
    },
    options.apple,
  );
  return {
    screenRecording: {
      apple,
      outputs: { prepare: options.prepare ?? (async () => {}) },
      finalize: { complete: options.complete ?? (async () => ({})) },
    },
  };
}
