import path from 'node:path';
import { localRuntimeOwner } from '@agent-device/contracts/platform-runtime';
import type { ScreenRecordingLiveHandle } from '@agent-device/contracts/screen-recording-runtime';
import { createDurableResourceEnvelope } from '@agent-device/capture-kit';
import { WEB_DESKTOP_DEVICE } from '../../__tests__/test-utils/device-fixtures.ts';
import { screenRecordingResourceStore } from '../screen-recording-resource-store.ts';
import type { SessionStore } from '../session-store.ts';
import type { SessionState } from '../types.ts';

export function makeRecordingSession(params: {
  name: string;
  sessionStore: SessionStore;
  finish: ScreenRecordingLiveHandle['finish'];
}): SessionState {
  const { name, sessionStore, finish } = params;
  const device = {
    platform: 'apple' as const,
    id: 'sim-udid-shutdown',
    name: 'iPhone 15',
    kind: 'simulator' as const,
    booted: true,
  };
  const outPath = path.join(sessionStore.resolveSessionDir(name), 'recording.mp4');
  const handle: ScreenRecordingLiveHandle = {
    inspect: () => ({
      backend: 'simctl recordVideo',
      outPath,
      startedAt: Date.now() - 5_000,
      scope: 'app',
      showTouches: false,
      recordOnlySession: false,
      gestureEvents: [],
    }),
    appendGestureEvents: () => {},
    setTouchReferenceFrame: () => {},
    setRunnerSessionId: () => {},
    invalidate: () => {},
    finish,
    forceCleanup: async () => ({ status: 'cleaned' }),
    [Symbol.asyncDispose]: async () => {},
  };
  const envelope = createDurableResourceEnvelope({
    resourceKind: 'screen-recording',
    sessionId: name,
    device: { id: device.id, family: 'apple', appleOs: 'ios', kind: 'simulator' },
    owner: localRuntimeOwner('apple'),
    fence: { token: `${name}-fence`, generation: 1 },
    lifecycle: 'open',
    descriptor: { version: 1, body: { recordingId: name } },
    metadata: { phase: 'active' },
  });
  screenRecordingResourceStore.write(
    screenRecordingResourceStore.resolvePath(sessionStore.resolveSessionDir(name)),
    envelope,
  );
  return {
    name,
    device,
    createdAt: Date.now(),
    actions: [],
    screenRecording: { handle, envelope },
  };
}

export function makeWebSession(name: string): SessionState {
  return { name, device: WEB_DESKTOP_DEVICE, createdAt: Date.now(), actions: [] };
}
