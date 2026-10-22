import { vi } from 'vitest';
import { createDurableResourceEnvelope } from '@agent-device/capture-kit';
import { emptyAudioProbeResult } from '@agent-device/contracts/audio-probe-result';
import { deviceIdentity } from '@agent-device/kernel/device';
import { localRuntimeOwner } from '@agent-device/contracts/platform-runtime';
import { audioProbeResourceStore } from '@agent-device/capture-kit/audio-probe-resource-store';
import { perfCaptureResourceStore } from '@agent-device/capture-kit/perf-capture-resource-store';
import { screenRecordingResourceStore } from '@agent-device/capture-kit/screen-recording-resource-store';
import type { SessionRef, SessionState } from './session-state.ts';
import type { resourceAdmissionWorld } from './composite-resource-admission.fixtures.ts';

type World = Awaited<ReturnType<typeof resourceAdmissionWorld>>;

export function seedExistingCapture(
  world: World,
  kind: 'audio-probe' | 'perf-capture' | 'screen-recording',
  ref: SessionRef = world.ref,
) {
  const session = world.sessionStore.requireCurrent(ref);
  const envelope = <K extends typeof kind>(resourceKind: K) =>
    createDurableResourceEnvelope({
      resourceKind,
      sessionId: ref.address,
      device: deviceIdentity(session.device),
      owner: localRuntimeOwner('android'),
      fence: { token: `owned-${kind}`, generation: 1 },
      lifecycle: 'open',
      descriptor: { version: 1, body: { kind: 'fixture' } },
    });
  const finish = vi.fn(async () => {
    throw new Error('existing resource finish reached');
  });
  const forceCleanup = vi.fn(async () => ({ status: 'cleaned' as const }));
  const disposal = { finish, forceCleanup, [Symbol.asyncDispose]: async () => {} };
  const sessionDir = world.sessionStore.resolveSessionDir(ref.address);
  let patch: Partial<SessionState>;
  let resourcePath: string;
  switch (kind) {
    case 'audio-probe': {
      const status = vi.fn(async () =>
        emptyAudioProbeResult({
          source: 'system-audio',
          backend: 'host-system-audio',
          durationMs: 1000,
          bucketMs: 100,
        }),
      );
      const resource = {
        envelope: envelope(kind),
        handle: {
          ...disposal,
          status,
          inspect: () => ({
            source: 'system-audio' as const,
            backend: 'host-system-audio',
            sourceCount: 1,
            notes: [],
            statusPath: '/tmp/status.json',
            startedAt: 1,
            durationMs: 1000,
            bucketMs: 100,
          }),
        },
      };
      patch = { audioProbe: resource };
      resourcePath = audioProbeResourceStore.resolvePath(sessionDir);
      audioProbeResourceStore.write(resourcePath, resource.envelope);
      break;
    }
    case 'perf-capture': {
      const resource = {
        envelope: envelope(kind),
        handle: {
          ...disposal,
          inspect: () => ({ kind: 'perfetto' as const, mode: 'trace' as const }),
          setOutputPath: vi.fn(),
        },
      };
      patch = { perfCapture: resource };
      resourcePath = perfCaptureResourceStore.resolvePath(sessionDir);
      perfCaptureResourceStore.write(resourcePath, resource.envelope);
      break;
    }
    case 'screen-recording': {
      const resource = {
        envelope: envelope(kind),
        handle: {
          ...disposal,
          inspect: () => ({
            backend: 'android',
            outPath: '/tmp/owned.mp4',
            startedAt: 1,
            scope: 'app' as const,
            showTouches: false,
            recordOnlySession: false,
            gestureEvents: [],
          }),
          appendGestureEvents: vi.fn(),
          setTouchReferenceFrame: vi.fn(),
          setRunnerSessionId: vi.fn(),
          invalidate: vi.fn(),
        },
      };
      patch = { screenRecording: resource };
      resourcePath = screenRecordingResourceStore.resolvePath(sessionDir);
      screenRecordingResourceStore.write(resourcePath, resource.envelope);
      break;
    }
  }
  world.sessionStore.update(ref, patch);
  return { finish, forceCleanup, resourcePath, patch };
}
