import {
  createDurableResourceEnvelope,
  createScreenRecordingLiveHandle,
} from '@agent-device/capture-kit';
import { localRuntimeOwner } from '@agent-device/contracts/platform-runtime';
import type { ScreenRecordingLiveSnapshot } from '@agent-device/contracts/screen-recording-runtime';
import { deviceIdentity } from '@agent-device/kernel/device';
import type { SessionState } from '../../daemon/types.ts';

type ScreenRecordingOverrides = Partial<ScreenRecordingLiveSnapshot>;

/** Honest mutable screen-recording handle plus its ownership-qualified durable envelope. */
export function makeTestScreenRecordingResource(
  session: Pick<SessionState, 'name' | 'device'>,
  overrides: ScreenRecordingOverrides = {},
): NonNullable<SessionState['screenRecording']> {
  const initial: ScreenRecordingLiveSnapshot = {
    backend: 'fixture',
    outPath: '/tmp/recording.mp4',
    startedAt: 1_000,
    scope: 'app',
    showTouches: true,
    recordOnlySession: false,
    gestureEvents: [],
    ...overrides,
  };
  const handle = createScreenRecordingLiveHandle(initial, {
    finish: async (snapshot) => ({
      status: 'completed',
      result: {
        backend: snapshot.backend,
        outPath: snapshot.outPath,
        ...(snapshot.clientOutPath ? { clientOutPath: snapshot.clientOutPath } : {}),
        startedAt: snapshot.startedAt,
        completedAt: snapshot.startedAt + 1,
        scope: snapshot.scope,
        showTouches: snapshot.showTouches,
        recordOnlySession: snapshot.recordOnlySession,
        ...(snapshot.activeSessionApp ? { activeSessionApp: snapshot.activeSessionApp } : {}),
      },
    }),
    forceCleanup: async () => ({ status: 'cleaned' }),
  });
  return {
    handle,
    envelope: createDurableResourceEnvelope({
      resourceKind: 'screen-recording',
      sessionId: session.name,
      device: deviceIdentity(session.device),
      owner: localRuntimeOwner(session.device.platform),
      fence: { token: 'test-screen-recording', generation: 1 },
      lifecycle: 'open',
      descriptor: { version: 1, body: { fixture: true } },
      metadata: { phase: 'active' },
    }),
  };
}
