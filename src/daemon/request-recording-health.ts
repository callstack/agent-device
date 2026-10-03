import { isIosFamily } from '@agent-device/kernel/device';
import { appleSessionObservation } from '../platform-runtime-apple-resources.ts';
import type { SessionRef, SessionState } from './session-state.ts';
import type { SessionStore } from './session-store.ts';

export async function refreshRecordingHealth(store: SessionStore, ref: SessionRef): Promise<void> {
  const session = store.requireCurrent(ref);
  if (!recordingRequiresRunnerHealth(session)) {
    return;
  }
  const resource = session.screenRecording!;
  const recording = resource.handle;

  const snapshot = await appleSessionObservation.observeRunnerSession(session.device.id);
  if (store.resolveCurrent(ref)?.screenRecording !== resource) return;
  const state = recording.inspect();
  if (!state.runnerSessionId) {
    if (snapshot?.alive) {
      recording.setRunnerSessionId(snapshot.sessionId);
    }
    return;
  }

  if (!snapshot?.alive) {
    recording.invalidate('iOS runner session exited during recording');
    return;
  }

  if (snapshot.sessionId !== state.runnerSessionId) {
    recording.invalidate('iOS runner session restarted during recording');
  }
}

function recordingRequiresRunnerHealth(session: SessionState): boolean {
  const recording = session.screenRecording?.handle.inspect();
  if (!recording || !isIosFamily(session.device)) return false;
  return recording.backend === 'runner AVAssetWriter' && recording.showTouches !== false;
}
