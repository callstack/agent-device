import { isIosFamily } from '@agent-device/kernel/device';
import { getRunnerSessionSnapshot } from '../platforms/apple/core/runner-client.ts';
import type { SessionState } from './types.ts';

export function refreshRecordingHealth(session: SessionState): void {
  if (!recordingRequiresRunnerHealth(session)) {
    return;
  }
  const recording = session.screenRecording!.handle;
  const state = recording.inspect();

  const snapshot = getRunnerSessionSnapshot(session.device.id);
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
