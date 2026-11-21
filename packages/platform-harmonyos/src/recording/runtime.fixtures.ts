import { recordingFileStore } from '@agent-device/capture-kit/recording-artifact-fixtures';
import type { ScreenRecordingRuntimeHost } from '@agent-device/contracts/screen-recording-runtime-host';
import type { ScreenRecordingStartInput } from '@agent-device/contracts/screen-recording-runtime';
import type { HarmonyScreenRecorder } from './recorder.ts';
import type { HarmonyScreenRecordingOperationHost } from './runtime.ts';

export const harmonyDevice = Object.freeze({
  platform: 'harmonyos' as const,
  id: 'harmony-device',
  name: 'Harmony',
  kind: 'device' as const,
  target: 'mobile' as const,
  booted: true,
});

export function harmonyRecordingInput(
  overrides: Partial<ScreenRecordingStartInput> = {},
): ScreenRecordingStartInput {
  return {
    sessionId: 'one',
    outputPath: '/tmp/harmony.mp4',
    scope: 'device',
    showTouches: true,
    hideTouchesRequested: false,
    recordOnlySession: false,
    fence: { token: 'fence', generation: 1 },
    ...overrides,
  };
}

export function harmonyCommandSuccess() {
  return { stdout: 'start ability successfully', stderr: '', exitCode: 0 };
}

/**
 * The host and recorder pair the recording operations consume. Every recorder port is a stub the
 * test overrides, so no HDC process is spawned from these tests; `recorder.test.ts` covers what the
 * real recorder asks the host to spawn.
 */
export function harmonyRecordingHost(
  overrides: Partial<HarmonyScreenRecorder> & {
    complete?: ScreenRecordingRuntimeHost['finalize']['complete'];
    prepare?: ScreenRecordingRuntimeHost['outputs']['prepare'];
  } = {},
): HarmonyScreenRecordingOperationHost {
  return {
    screenRecording: {
      outputs: {
        ...recordingFileStore().outputs,
        prepare: overrides.prepare ?? (async () => {}),
      },
      finalize: { sniff: async () => {}, complete: overrides.complete ?? (async () => ({})) },
    },
    clock: { now: () => 0, sleep: async () => {} },
    recorder: harmonyRecordingRecorder(overrides),
  } as unknown as HarmonyScreenRecordingOperationHost;
}

function harmonyRecordingRecorder(
  overrides: Partial<HarmonyScreenRecorder> = {},
): HarmonyScreenRecorder {
  return {
    start: overrides.start ?? (async () => harmonyCommandSuccess()),
    stop: overrides.stop ?? (async () => harmonyCommandSuccess()),
    findMedia: overrides.findMedia ?? (async () => 'file://media/video'),
    stageMedia: overrides.stageMedia ?? (async () => true),
    stagedFileSize: overrides.stagedFileSize ?? (async () => 12),
    pull: overrides.pull ?? (async () => ({ stdout: '', stderr: '', exitCode: 0 })),
    remove: overrides.remove ?? (async () => true),
    removeMedia: overrides.removeMedia ?? (async () => true),
  };
}
