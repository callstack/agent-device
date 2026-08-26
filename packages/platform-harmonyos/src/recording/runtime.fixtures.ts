import type { ScreenRecordingRuntimeHost } from '@agent-device/contracts/screen-recording-runtime-host';
import type { ScreenRecordingStartInput } from '@agent-device/contracts/screen-recording-runtime';
import type { createHarmonyScreenRecordingOperations } from './runtime.ts';

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

type HarmonyHost = Parameters<typeof createHarmonyScreenRecordingOperations>[0]['host'];

export function harmonyRecordingHost(
  overrides: Partial<ScreenRecordingRuntimeHost['harmony']> & {
    complete?: ScreenRecordingRuntimeHost['finalize']['complete'];
    prepare?: ScreenRecordingRuntimeHost['outputs']['prepare'];
  } = {},
): HarmonyHost {
  const harmony: ScreenRecordingRuntimeHost['harmony'] = {
    start: overrides.start ?? (async () => harmonyCommandSuccess()),
    stop: overrides.stop ?? (async () => harmonyCommandSuccess()),
    findMedia: overrides.findMedia ?? (async () => 'file://media/video'),
    stageMedia: overrides.stageMedia ?? (async () => true),
    stagedFileSize: overrides.stagedFileSize ?? (async () => 12),
    pull: overrides.pull ?? (async () => ({ stdout: '', stderr: '', exitCode: 0 })),
    remove: overrides.remove ?? (async () => true),
    removeMedia: overrides.removeMedia ?? (async () => true),
  };
  return {
    screenRecording: {
      harmony,
      outputs: { prepare: overrides.prepare ?? (async () => {}) },
      finalize: { complete: overrides.complete ?? (async () => ({})) },
    },
    clock: { now: () => 0, sleep: async () => {} },
  };
}
